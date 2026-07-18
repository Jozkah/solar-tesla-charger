import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server, base, settings;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-api-'));
  // config.js needs a config.json at import time (see settings.test.js).
  const configPath = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);
  process.env.CONFIG_PATH = configPath;
  process.env.DB_PATH = path.join(dir, 'test.db');
  settings = await import('../server/settings.js');

  // Mirror index.js's settings routes on a controller-free app.
  const app = express();
  app.use(express.json());
  app.get('/api/settings', (req, res) => {
    res.json({ billingDay: settings.getBillingDay(), tariff: settings.getTariff() });
  });
  app.post('/api/settings', (req, res) => {
    try {
      res.json(settings.applySettings(req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('GET returns defaults', async () => {
  const s = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(s.billingDay, 1);
  assert.equal(s.tariff.currency, '€');
});

test('POST valid billingDay persists', async () => {
  const res = await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billingDay: 20 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).billingDay, 20);
  assert.equal((await (await fetch(`${base}/api/settings`)).json()).billingDay, 20);
});

test('POST invalid -> 400, value unchanged', async () => {
  const res = await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billingDay: 99 }),
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
  assert.equal((await (await fetch(`${base}/api/settings`)).json()).billingDay, 20);
});
