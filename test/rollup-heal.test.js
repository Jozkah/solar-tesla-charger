// Legacy-rollup self-heal: a daily_stats row persisted BEFORE the per-hour
// histogram columns existed has NULL import_wh_by_hour/car_grid_wh_by_hour and
// would contribute 0 to time-of-use cost forever — dayRollup returns stored
// complete-day rows verbatim. This test proves that a stored null-histogram day
// whose samples are still within retention is recomputed+repersisted on read
// (heal), so cost is real; and that the repersist sticks (row no longer null).
//
// Own throwaway config.json + DB so seeding a whole extra day can't perturb the
// per-band kWh assertions in stats-cost.test.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stats, db, pastDay;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-heal-'));
  const configPath = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);
  process.env.CONFIG_PATH = configPath;
  process.env.DB_PATH = path.join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  stats = await import('../server/stats.js');

  // A complete day 3 days ago (within the 60-day retention window from the
  // example config), so its samples are still available to backfill from.
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 3);
  pastDay = d.getTime();
  const at = (hr, min) => pastDay + hr * 3_600_000 + min * 60_000;

  // Real samples for that day: one 30-min peak-hour grid-import + car-charge slice.
  const ins = db.prepare('INSERT OR REPLACE INTO samples (ts, import_w, charge_w) VALUES (?, ?, ?)');
  ins.run(at(9, 0), 2000, 2000);  // slice [09:00,09:30): 2000W*0.5h = 1000Wh peak import; grid-charge share 1000Wh
  ins.run(at(9, 30), 0, 0);

  // A LEGACY persisted rollup for that day: scalar fields present, the two
  // histogram columns left unset (NULL) exactly as a pre-feature row would be.
  db.prepare(`
    INSERT INTO daily_stats
      (day_ts, samples, car_wh, car_solar_wh, car_grid_wh, peak_w, peak_amps,
       charging_samples, adjustments, solar2_wh, solax_wh, export_wh, import_wh, used_wh)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pastDay, 2, 1000, 0, 1000, 2000, 0, 1, 0, 0, 0, 0, 1000, 1000);
});

test('legacy null-histogram day within retention heals on read (cost > 0)', () => {
  // Pre-condition: the stored row really is a legacy null-histogram row.
  const before = db.prepare('SELECT import_wh_by_hour FROM daily_stats WHERE day_ts = ?').get(pastDay);
  assert.equal(before.import_wh_by_hour, null, 'seeded row must start with NULL histogram');

  const s = stats.getStats('day', 3); // the seeded past day
  assert.ok(s.cost, 'cost present');
  assert.ok(s.cost.total > 0, 'cost healed from samples, not read as zero');
  assert.ok(Math.abs(s.cost.bands[0].kwh - 1.0) < 1e-6, 'peak import 1.0 kWh recovered');
  assert.ok(s.chargeCost && s.chargeCost.total > 0, 'chargeCost healed too');

  // Post-condition: the heal re-persisted the row with a non-null histogram.
  const after = db.prepare('SELECT import_wh_by_hour FROM daily_stats WHERE day_ts = ?').get(pastDay);
  assert.notEqual(after.import_wh_by_hour, null, 'row re-persisted with histogram');
  const hours = JSON.parse(after.import_wh_by_hour);
  assert.equal(hours.length, 24);
  assert.ok(Math.abs(hours[9] - 1000) < 1e-6, 'peak-hour Wh backfilled at hour 9');
});
