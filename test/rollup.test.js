import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayRollup, foldRollups, nextDayMs, isDayComplete } from '../server/rollup.js';

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

test('does not seed prevAmps from a non-charging lookbehind, even with stale charge_amps', () => {
  // charge_amps persists on non-charging rows, so a naive "last sample before
  // midnight" lookup can hand back a stale value that never actually charged
  // at. computeDayRollup only adopts prevAmps inside `if (r.charging)`, so a
  // non-charging lookbehind must seed nothing — the day's first charging
  // sample then has no prevAmps to compare against and must not count as an
  // adjustment. This is why queries.sampleBefore (server/db.js) filters
  // `charging = 1`: passing the plain last-sample-before-midnight here would
  // silently drop the seed and undercount adjustments.
  const rows = [
    sample(d0 - 10_000, { charge_amps: 12, charging: 0 }), // stale, not charging
    sample(d0, { charge_amps: 7, charging: 1 }), // first charging sample of the day
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

test('fold sums energies and maxes peaks', () => {
  const a = { day_ts: 1, samples: 2, car_wh: 100, car_solar_wh: 60, car_grid_wh: 40,
    peak_w: 3000, peak_amps: 16, charging_samples: 5, adjustments: 1,
    solar2_wh: 10, solax_wh: 5, export_wh: 7, import_wh: 3, used_wh: 20 };
  const b = { day_ts: 2, samples: 3, car_wh: 200, car_solar_wh: 150, car_grid_wh: 50,
    peak_w: 7000, peak_amps: 32, charging_samples: 6, adjustments: 2,
    solar2_wh: 20, solax_wh: 5, export_wh: 3, import_wh: 1, used_wh: 30 };
  const t = foldRollups([a, b]);
  assert.equal(t.samples, 5);
  assert.equal(t.car_wh, 300);
  assert.equal(t.car_solar_wh, 210);
  assert.equal(t.adjustments, 3);
  assert.equal(t.peak_w, 7000);   // max, not sum
  assert.equal(t.peak_amps, 32);  // max, not sum
  assert.equal(t.used_wh, 50);
});

test('fold of nothing is all zeros', () => {
  const t = foldRollups([]);
  assert.equal(t.samples, 0);
  assert.equal(t.car_wh, 0);
  assert.equal(t.peak_w, 0);
});

// NOTE: these two assertions (getHours() === 0, one-calendar-day advance) hold
// in every timezone. They only actually exercise the DST-safety property this
// suite guards against (a fixed +24h drifting off midnight) when run in a
// DST-observing zone — this deployment runs in Europe/Lisbon, which observes
// DST, so that's what CI/dev boxes here are expected to use.
test('nextDayMs lands on next local midnight across the autumn DST fall-back (25h day)', () => {
  // 2026-10-25 in Europe/Lisbon is the fall-back day: 01:00 happens twice, the
  // local day is 25 hours long. A fixed +86_400_000 step would land at 23:00
  // on the 25th, not midnight on the 26th.
  const start = new Date(2026, 9, 25).setHours(0, 0, 0, 0); // Oct 25 2026 local midnight
  const next = nextDayMs(start);
  const d = new Date(next);
  assert.equal(d.getHours(), 0, 'must land exactly on local midnight');
  assert.equal(d.getDate(), 26);
  assert.equal(d.getMonth(), 9);
});

test('nextDayMs lands on next local midnight across the spring DST spring-forward (23h day)', () => {
  // 2026-03-29 in Europe/Lisbon is the spring-forward day: 01:00 jumps to
  // 02:00, the local day is 23 hours long. A fixed +86_400_000 step would
  // overshoot past midnight on the 30th.
  const start = new Date(2026, 2, 29).setHours(0, 0, 0, 0); // Mar 29 2026 local midnight
  const next = nextDayMs(start);
  const d = new Date(next);
  assert.equal(d.getHours(), 0, 'must land exactly on local midnight');
  assert.equal(d.getDate(), 30);
  assert.equal(d.getMonth(), 2);
});

test('isDayComplete is false for today and true for yesterday', () => {
  const now = Date.now();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  const yesterdayMidnight = new Date(todayMidnight.getTime());
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

  // Today is never persisted: the invariant this whole fix protects.
  assert.equal(isDayComplete(todayMidnight.getTime(), now), false);
  // Yesterday's next midnight has already arrived, so it's safe to persist.
  assert.equal(isDayComplete(yesterdayMidnight.getTime(), now), true);
});
