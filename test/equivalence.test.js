import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayRollup, foldRollups } from '../server/rollup.js';

const DAY = 86_400_000;
const START = new Date(2026, 0, 5).setHours(0, 0, 0, 0); // Monday, local

// Reference implementation: the whole-range math as it exists today, copied
// verbatim in spirit from getStats. The rollup fold must reproduce it exactly.
function referenceWholeRange(rows) {
  const out = { car_wh: 0, car_solar_wh: 0, car_grid_wh: 0, peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0, solar2_wh: 0, solax_wh: 0,
    export_wh: 0, import_wh: 0, used_wh: 0, samples: rows.length };
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const r = rows[i - 1];
    const cw = Math.max(0, r.charge_w || 0);
    out.car_wh += cw * dtH;
    if (cw > 0) {
      const gridShare = (r.import_w || 0) > 0 ? Math.min(r.import_w, cw) : 0;
      out.car_grid_wh += gridShare * dtH;
      out.car_solar_wh += (cw - gridShare) * dtH;
    }
    const growatt = -Math.min(0, r.solar2_w || 0);
    const solax = Math.max(0, r.solax_w || 0);
    out.solar2_wh += growatt * dtH;
    out.solax_wh += solax * dtH;
    out.export_wh += Math.max(0, r.export_w || 0) * dtH;
    out.import_wh += Math.max(0, r.import_w || 0) * dtH;
    out.used_wh += Math.max(0, growatt + solax + (r.grid_power || 0)) * dtH;
  }
  let prevAmps = null;
  for (const r of rows) {
    if ((r.charge_w || 0) > out.peak_w) out.peak_w = r.charge_w;
    if ((r.charge_amps || 0) > out.peak_amps) out.peak_amps = r.charge_amps;
    if (r.charging) out.charging_samples++;
    if (r.charging && prevAmps != null && r.charge_amps != null && r.charge_amps !== prevAmps) out.adjustments++;
    if (r.charging) prevAmps = r.charge_amps;
  }
  return out;
}

// Three days at a 10s poll with an overnight charge that runs 22:00 -> 06:00
// across BOTH midnights, changing amps a few times. This is the shape that
// breaks a naive per-day rollup.
function buildSamples() {
  const rows = [];
  for (let t = START; t < START + 3 * DAY; t += 10_000) {
    const hour = new Date(t).getHours();
    const overnight = hour >= 22 || hour < 6;
    const amps = overnight ? (hour % 3 === 0 ? 20 : 32) : null;
    const sun = hour > 8 && hour < 18 ? -2000 : 0;
    rows.push({
      ts: t,
      grid_power: overnight ? 7000 : sun / 2,
      export_w: overnight ? 0 : Math.max(0, -sun / 2),
      import_w: overnight ? 7000 : 0,
      solar2_w: sun,
      solax_w: overnight ? 0 : 800,
      charge_w: overnight ? amps * 230 : 0,
      charge_amps: amps,
      charging: overnight ? 1 : 0,
    });
  }
  return rows;
}

// The samples a day's rollup gets: its own, plus one lookbehind and one lookahead.
function windowFor(rows, dayStart, dayEnd) {
  const inDay = rows.filter((r) => r.ts >= dayStart && r.ts < dayEnd);
  const before = rows.filter((r) => r.ts < dayStart).slice(-1);
  const after = rows.find((r) => r.ts >= dayEnd);
  return [...before, ...inDay, ...(after ? [after] : [])];
}

test('folded days equal the same range integrated whole', () => {
  const rows = buildSamples();
  const days = [0, 1, 2].map((i) => {
    const s = START + i * DAY;
    return computeDayRollup(windowFor(rows, s, s + DAY), s, s + DAY);
  });
  const folded = foldRollups(days);
  const whole = referenceWholeRange(rows);

  for (const k of ['car_wh', 'car_solar_wh', 'car_grid_wh', 'solar2_wh', 'solax_wh',
                   'export_wh', 'import_wh', 'used_wh']) {
    assert.ok(Math.abs(folded[k] - whole[k]) < 0.01, `${k}: ${folded[k]} != ${whole[k]}`);
  }
  for (const k of ['samples', 'charging_samples', 'adjustments', 'peak_w', 'peak_amps']) {
    assert.equal(folded[k], whole[k], `${k}: ${folded[k]} != ${whole[k]}`);
  }
});

test('adjustments across midnight match the whole-range count exactly', () => {
  // Guards the prevAmps seed specifically: this is the field a naive per-day
  // rollup gets wrong, once per boundary, only when a charge spans midnight.
  const rows = buildSamples();
  const days = [0, 1, 2].map((i) => {
    const s = START + i * DAY;
    return computeDayRollup(windowFor(rows, s, s + DAY), s, s + DAY);
  });
  assert.equal(foldRollups(days).adjustments, referenceWholeRange(rows).adjustments);
});
