import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayRollup } from '../server/rollup.js';

const DAY = 86_400_000;
const d0 = new Date(2026, 0, 5).setHours(0, 0, 0, 0); // local midnight

// One sample every 10s, matching the production poll interval.
function sample(ts, o = {}) {
  return {
    ts,
    grid_power: 0, export_w: 0, import_w: 0, solar2_w: 0, solax_w: 0,
    charge_w: 0, charge_amps: null, charging: 0, ...o,
  };
}

// NOTE ON INTERVAL LENGTHS: integrate() skips any interval longer than 0.5h as
// a gap, and computeDayRollup must keep that behavior. Every sample spacing
// below is <= 30 minutes on purpose. Do not "fix" the 0.5h threshold to make a
// test pass — it is established production behavior and changing it would
// silently alter every energy figure on the dashboard.

test('sums energy from the left sample of each interval', () => {
  // Two 30-minute intervals at 1000 W => 500 + 500 = 1000 Wh. The third sample
  // only closes the second interval and contributes no energy of its own.
  const rows = [
    sample(d0, { charge_w: 1000, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 1000, charging: 1 }),
    sample(d0 + 3_600_000, { charge_w: 0 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_wh), 1000);
  assert.equal(r.samples, 3);
  assert.equal(r.peak_w, 1000);
});

test('skips gaps longer than 30 minutes', () => {
  const rows = [
    sample(d0, { charge_w: 1000 }),
    sample(d0 + 3_600_000 * 2, { charge_w: 1000 }), // 2h gap => not counted
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_wh), 0);
});

test('does not count the lookbehind sample interval or its peak', () => {
  // The lookbehind sample belongs to the previous day: its 9000 W peak and its
  // interval must not leak into this day. One 30-minute in-day interval at
  // 1000 W => 500 Wh.
  const rows = [
    sample(d0 - 10_000, { charge_w: 9000, charge_amps: 32, charging: 1 }),
    sample(d0, { charge_w: 1000, charge_amps: 16, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 1000, charge_amps: 16, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.peak_w, 1000);
  assert.equal(r.samples, 2);
  assert.equal(Math.round(r.car_wh), 500);
});

test('seeds prevAmps from the lookbehind sample so midnight does not miscount', () => {
  // Overnight charge crossing midnight at a steady 32 A. Without the seed the
  // first in-day sample would look like a fresh adjustment.
  const rows = [
    sample(d0 - 10_000, { charge_w: 7000, charge_amps: 32, charging: 1 }),
    sample(d0, { charge_w: 7000, charge_amps: 32, charging: 1 }),
    sample(d0 + 10_000, { charge_w: 7000, charge_amps: 32, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.adjustments, 0);
});

test('counts a real amp change after midnight as one adjustment', () => {
  const rows = [
    sample(d0 - 10_000, { charge_amps: 32, charging: 1 }),
    sample(d0, { charge_amps: 32, charging: 1 }),
    sample(d0 + 10_000, { charge_amps: 20, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.adjustments, 1);
});

test('splits car energy into solar and grid shares', () => {
  // 2000 W charge with 500 W imported, over 30 minutes => 250 Wh grid,
  // 750 Wh solar.
  const rows = [
    sample(d0, { charge_w: 2000, import_w: 500, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 0 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_grid_wh), 250);
  assert.equal(Math.round(r.car_solar_wh), 750);
});

test('house consumption is generation plus grid power, floored at zero', () => {
  // Growatt generation reads negative; solax reads positive. Over 30 minutes:
  // 1500 W generated - 200 W exported = 1300 W consumed => 650 Wh.
  const rows = [
    sample(d0, { solar2_w: -1000, solax_w: 500, grid_power: -200 }),
    sample(d0 + 1_800_000, {}),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.solar2_wh), 500);
  assert.equal(Math.round(r.solax_wh), 250);
  assert.equal(Math.round(r.used_wh), 650);
});

test('returns a zero row for a day with no samples', () => {
  const r = computeDayRollup([], d0, d0 + DAY);
  assert.equal(r.day_ts, d0);
  assert.equal(r.samples, 0);
  assert.equal(r.car_wh, 0);
});
