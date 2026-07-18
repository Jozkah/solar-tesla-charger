import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let computeAvgWhPerKm;

before(async () => {
  // config.js needs a config.json at import time; point it at the example.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-drives-'));
  process.env.CONFIG_PATH = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), process.env.CONFIG_PATH);
  process.env.DB_PATH = path.join(dir, 'test.db');
  ({ computeAvgWhPerKm } = await import('../server/drives.js'));
});

// energy-weighted Wh/km = Σenergy(kWh)*1000 / Σdistance(km)
const drive = (energyKwh, distKm, extra = {}) => ({
  energy_consumed_net: energyKwh,
  odometer_details: { odometer_distance: distKm, is_sufficiently_precise: true, ...extra },
});

test('energy-weights consumption across drives (Wh/km)', () => {
  // 10 kWh over 50 km + 5 kWh over 20 km => 15000 Wh / 70 km = 214.29 Wh/km
  const wh = computeAvgWhPerKm([drive(10, 50), drive(5, 20)], 'km');
  assert.ok(Math.abs(wh - (15000 / 70)) < 1e-6);
});

test('converts miles to km when TeslaMate unit is mi', () => {
  // 10 kWh over 10 mi = 16.09344 km => 10000/16.09344 = 621.37 Wh/km
  const wh = computeAvgWhPerKm([drive(10, 10)], 'mi');
  assert.ok(Math.abs(wh - (10000 / 16.09344)) < 1e-6);
});

test('a missing drive does not move the ratio (immune to untracked drives)', () => {
  // Same efficiency (200 Wh/km) on every drive => dropping one keeps the ratio.
  const full = [drive(10, 50), drive(4, 20), drive(2, 10)]; // all 200 Wh/km
  const missingOne = [drive(10, 50), drive(2, 10)];
  assert.ok(Math.abs(computeAvgWhPerKm(full, 'km') - 200) < 1e-6);
  assert.ok(Math.abs(computeAvgWhPerKm(missingOne, 'km') - 200) < 1e-6);
});

test('skips imprecise, null-energy, null/zero-distance rows', () => {
  const rows = [
    drive(10, 50),                                   // counted (200 Wh/km)
    drive(99, 50, { is_sufficiently_precise: false }), // skipped: imprecise
    { energy_consumed_net: null, odometer_details: { odometer_distance: 10 } }, // skipped: null energy
    drive(5, 0),                                     // skipped: zero distance
  ];
  assert.ok(Math.abs(computeAvgWhPerKm(rows, 'km') - 200) < 1e-6);
});

test('returns null when no usable drives (caller falls back)', () => {
  assert.equal(computeAvgWhPerKm([], 'km'), null);
  assert.equal(computeAvgWhPerKm([drive(5, 0)], 'km'), null);
});
