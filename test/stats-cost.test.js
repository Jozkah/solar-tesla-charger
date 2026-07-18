// Cost engine wired into the ROLLUP architecture (home-dashboard). The feature
// branch integrated cost from raw per-sample rows; here cost is derived from the
// per-hour Wh histograms carried on the folded rollup, so this test seeds real
// samples for today and drives getStats end-to-end (compute-live path — today is
// never a stored rollup) to prove the per-band kWh and the cost object surface.
//
// config.js reads config.json (gitignored/absent in a fresh clone) and db.js
// opens SQLite at import time from config.paths.db; point both at throwaways via
// CONFIG_PATH/DB_PATH BEFORE the dynamic imports below.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stats, db;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-statscost-'));
  const configPath = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);
  process.env.CONFIG_PATH = configPath;
  process.env.DB_PATH = path.join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  stats = await import('../server/stats.js');

  // Two 30-min slices earlier today: 02:00 (off-peak, band 2) and 09:00 (peak,
  // band 0). Each interval is valued by its LEFT sample. import_w drives cost;
  // charge_w drives the marginal car-charging (chargeCost) grid share.
  const now = new Date();
  const at = (hr, min) => { const d = new Date(now); d.setHours(hr, min, 0, 0); return d.getTime(); };
  const insert = db.prepare('INSERT OR REPLACE INTO samples (ts, import_w, charge_w) VALUES (?, ?, ?)');
  insert.run(at(2, 0), 1000, 0);     // slice [02:00,02:30): 1000W * 0.5h = 500Wh off-peak import, no charge
  insert.run(at(2, 30), 0, 0);
  insert.run(at(9, 0), 2000, 2000);  // slice [09:00,09:30): 2000W * 0.5h = 1000Wh peak import; grid-charge share 1000Wh
  insert.run(at(9, 30), 0, 0);
});

test('getStats day includes cost + chargeCost with expected per-band kWh', () => {
  const s = stats.getStats('day', 0);
  assert.ok(s.cost, 'cost present for a bounded period');
  assert.equal(s.cost.currency, '€');
  // DEFAULT_TARIFF: band 0 = peak (8-22), band 2 = off-peak (0-8 & 22-24).
  assert.ok(Math.abs(s.cost.bands[0].kwh - 1.0) < 1e-6, 'peak import 1.0 kWh');
  assert.ok(Math.abs(s.cost.bands[2].kwh - 0.5) < 1e-6, 'off-peak import 0.5 kWh');
  assert.equal(s.cost.bands[1].kwh, 0, 'mid band unused');
  assert.ok(s.cost.total > 0);

  assert.ok(s.chargeCost, 'chargeCost present');
  assert.ok(Math.abs(s.chargeCost.bands[0].kwh - 1.0) < 1e-6, 'car grid-charge 1.0 kWh in peak');
  assert.ok(s.chargeCost.total > 0);
});

test('open-ended range (all) still has a cost object', () => {
  const s = stats.getStats('all', 0);
  assert.ok(s.cost, 'cost present for all');
  assert.ok(Math.abs(s.cost.bands[0].kwh - 1.0) < 1e-6);
  assert.ok(Math.abs(s.cost.bands[2].kwh - 0.5) < 1e-6);
});
