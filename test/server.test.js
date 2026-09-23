const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server.js');

test('GET /health returns OK', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('GET /api/stats returns storage stats', async () => {
  const res = await request(app).get('/api/stats');
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.body.total_size === 'number');
});
