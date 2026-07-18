import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let settings;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-settings-'));
  // config.js reads config.json (gitignored/absent in a fresh clone) at import
  // time; point it at a throwaway copy of the example via CONFIG_PATH, and the
  // DB at a temp file, BEFORE importing settings.js (-> db.js -> config.js).
  const configPath = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);
  process.env.CONFIG_PATH = configPath;
  process.env.DB_PATH = path.join(dir, 'test.db');
  settings = await import('../server/settings.js');
});

test('getBillingDay falls back to default (1) when unset', () => {
  assert.equal(settings.getBillingDay(), 1);
});

test('setBillingDay persists and getBillingDay reads it back', () => {
  settings.setBillingDay(15);
  assert.equal(settings.getBillingDay(), 15);
});

test('setBillingDay rejects out-of-range and non-integers', () => {
  assert.throws(() => settings.setBillingDay(0));
  assert.throws(() => settings.setBillingDay(32));
  assert.throws(() => settings.setBillingDay(15.5));
  assert.throws(() => settings.setBillingDay('x'));
});

test('getTariff returns default until set, then persisted value', () => {
  const def = settings.getTariff();
  assert.equal(def.currency, '€');
  const custom = { ...def, currency: '$', vatPct: 10 };
  settings.setTariff(custom);
  assert.equal(settings.getTariff().currency, '$');
  assert.equal(settings.getTariff().vatPct, 10);
});

test('setTariff rejects invalid tariff', () => {
  assert.throws(() => settings.setTariff({ currency: '€', bands: [], dailyFixed: 0, perKwhLevy: 0, fixedMonthly: 0, vatPct: 10 }));
});

test('applySettings validates all before persisting (atomic)', () => {
  const before = settings.getBillingDay();
  const badTariff = { currency: '€', bands: [{ name: 'p', rate: -1, windows: [] }], dailyFixed: 0, perKwhLevy: 0, fixedMonthly: 0, vatPct: 10 };
  assert.throws(() => settings.applySettings({ billingDay: 9, tariff: badTariff }));
  assert.equal(settings.getBillingDay(), before, 'billingDay must not persist when tariff is invalid');
});
