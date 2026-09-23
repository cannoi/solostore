const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure data and upload directories exist
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// SQLite Database setup
const dbPath = path.join(DATA_DIR, 'solostore.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    folder_id TEXT,
    size INTEGER NOT NULL,
    mimetype TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

app.use(express.json({ limit: '1gb' }));
app.use(express.urlencoded({ extended: true, limit: '1gb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

// Health Check
app.get('/health', (req, res) => {
  db.get('SELECT 1', (err) => {
    if (err) {
      res.status(500).json({ status: 'error', database: err.message });
    } else {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
  });
});

// Folders API
app.get('/api/folders', (req, res) => {
  const parentId = req.query.parent_id || null;
  const query = parentId === 'null' || !parentId ? 'SELECT * FROM folders WHERE parent_id IS NULL' : 'SELECT * FROM folders WHERE parent_id = ?';
  const params = parentId === 'null' || !parentId ? [] : [parentId];

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/folders', (req, res) => {
  const { name, parent_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const id = 'f_' + Date.now() + Math.random().toString(36).substr(2, 5);
  const pId = parent_id && parent_id !== 'null' ? parent_id : null;

  db.run('INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)', [id, name, pId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, parent_id: pId, created_at: new Date().toISOString() });
  });
});

app.delete('/api/folders/:id', (req, res) => {
  const folderId = req.params.id;
  db.run('DELETE FROM folders WHERE id = ?', [folderId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: folderId });
  });
});

// Files API
app.get('/api/files', (req, res) => {
  const folderId = req.query.folder_id || null;
  const search = req.query.search || '';
  
  let query = 'SELECT * FROM files WHERE 1=1';
  let params = [];

  if (search) {
    query += ' AND (original_name LIKE ? OR name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  } else if (folderId === 'null' || !folderId) {
    query += ' AND folder_id IS NULL';
  } else {
    query += ' AND folder_id = ?';
    params.push(folderId);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const { folder_id } = req.body;
  const id = 'file_' + Date.now() + Math.random().toString(36).substr(2, 5);
  const name = req.file.filename;
  const original_name = req.file.originalname;
  const filePath = req.file.path;
  const size = req.file.size;
  const mimetype = req.file.mimetype;
  const fId = folder_id && folder_id !== 'null' ? folder_id : null;

  db.run(
    'INSERT INTO files (id, name, original_name, path, folder_id, size, mimetype) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, name, original_name, filePath, fId, size, mimetype],
    function(err) {
      if (err) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(500).json({ error: err.message });
      }
      res.json({
        id, name, original_name, folder_id: fId, size, mimetype, created_at: new Date().toISOString()
      });
    }
  );
});

app.get('/api/files/:id/download', (req, res) => {
  const fileId = req.params.id;
  db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file) return res.status(404).json({ error: 'File not found' });
    
    const safePath = path.resolve(file.path);
    if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'File missing on disk' });
    
    res.download(safePath, file.original_name);
  });
});

app.delete('/api/files/:id', (req, res) => {
  const fileId = req.params.id;
  db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, file) => {
    if (err || !file) return res.status(404).json({ error: 'File not found' });

    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    db.run('DELETE FROM files WHERE id = ?', [fileId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: fileId });
    });
  });
});

// Storage stats
app.get('/api/stats', (req, res) => {
  db.get('SELECT SUM(size) as total_size, COUNT(*) as file_count FROM files', (err, fileStats) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT COUNT(*) as folder_count FROM folders', (err2, folderStats) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({
        total_size: fileStats.total_size || 0,
        file_count: fileStats.file_count || 0,
        folder_count: folderStats.folder_count || 0
      });
    });
  });
});

// Start server if run directly
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SoloStore server running on port ${PORT}`);
  });
}

module.exports = app;
