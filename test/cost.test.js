import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TARIFF, validateTariff, hourBandMap, importKwhByBand, computeCost, computeChargeCost,
  foldHoursToBands,
} from '../server/cost.js';

test('foldHoursToBands sums per-hour Wh into per-band kWh via the hour map', () => {
  const map = hourBandMap(DEFAULT_TARIFF.bands); // hours 8-21 => band 0 (peak), 0-7 & 22-23 => band 2 (off-peak)
  const hourWh = new Array(24).fill(0);
  hourWh[9] = 2000;  // peak -> band 0
  hourWh[10] = 1000; // peak -> band 0
  hourWh[2] = 500;   // off-peak -> band 2
  const bands = foldHoursToBands(hourWh, map, DEFAULT_TARIFF.bands.length);
  assert.ok(Math.abs(bands[0] - 3.0) < 1e-9); // (2000+1000)/1000 kWh peak
  assert.equal(bands[1], 0);                   // mid unused
  assert.ok(Math.abs(bands[2] - 0.5) < 1e-9); // 500/1000 kWh off-peak
});

test('foldHoursToBands tolerates a short/sparse hour array as zeros', () => {
  const map = hourBandMap(DEFAULT_TARIFF.bands);
  const bands = foldHoursToBands([], map, DEFAULT_TARIFF.bands.length);
  assert.deepEqual(bands, [0, 0, 0]);
});

test('DEFAULT_TARIFF is valid', () => {
  assert.doesNotThrow(() => validateTariff(DEFAULT_TARIFF));
});

test('hourBandMap: off-peak 0-8 & 22-24, peak 8-22', () => {
  const map = hourBandMap(DEFAULT_TARIFF.bands);
  assert.equal(map[0], 2);
  assert.equal(map[7], 2);
  assert.equal(map[8], 0);
  assert.equal(map[21], 0);
  assert.equal(map[22], 2);
  assert.equal(map[23], 2);
});

test('hourBandMap: overlap -> later band wins; uncovered -> band 0', () => {
  const bands = [
    { name: 'a', rate: 1, windows: [[0, 24]] },
    { name: 'b', rate: 2, windows: [[10, 12]] },
  ];
  const map = hourBandMap(bands);
  assert.equal(map[11], 1);
  assert.equal(map[9], 0);
  const none = hourBandMap([{ name: 'x', rate: 1, windows: [[0, 1]] }]);
  assert.equal(none[5], 0);
});

test('validateTariff rejects bad shapes', () => {
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: -1, windows: [] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: 1, windows: [[8, 8]] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: 1, windows: [[22, 25]] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, vatPct: 150 }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, dailyFixed: -1 }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, currency: '' }));
});

test('importKwhByBand buckets by sample midpoint hour, import only', () => {
  const h = (hr) => new Date(2026, 5, 20, hr, 0, 0, 0).getTime();
  const ordered = [
    { ts: h(2), import_w: 1000 },
    { ts: h(2) + 1800e3, import_w: 0 },   // 500Wh off-peak
    { ts: h(9), import_w: 2000 },          // gap > 0.5h -> skipped
    { ts: h(9) + 1800e3, import_w: 0 },   // 1000Wh peak
  ];
  const map = hourBandMap(DEFAULT_TARIFF.bands);
  const kwh = importKwhByBand(ordered, map, DEFAULT_TARIFF.bands.length);
  assert.ok(Math.abs(kwh[0] - 1.0) < 1e-9);
  assert.ok(Math.abs(kwh[2] - 0.5) < 1e-9);
  assert.equal(kwh[1], 0);
});

test('computeCost applies rates, levy, daily, fixed and VAT', () => {
  const tariff = {
    currency: '$', vatPct: 10, dailyFixed: 1, perKwhLevy: 0.01, fixedMonthly: 2,
    bands: [{ name: 'peak', rate: 0.2, windows: [[8, 22]] }, { name: 'off', rate: 0.1, windows: [[0, 8]] }],
  };
  const r = computeCost({ bandKwh: [10, 20], tariff, elapsedDays: 5 });
  assert.equal(r.total, 12.43);
  assert.equal(r.currency, '$');
  assert.equal(r.vatPct, 10);
  assert.equal(r.bands[0].kwh, 10);
  assert.equal(r.bands[0].cost, 2);
});

test('computeChargeCost is energy + levy + VAT only (no standing charges)', () => {
  const tariff = {
    currency: '$', vatPct: 10, dailyFixed: 99, perKwhLevy: 0.01, fixedMonthly: 99,
    bands: [{ name: 'peak', rate: 0.2, windows: [[8, 22]] }, { name: 'off', rate: 0.1, windows: [[0, 8]] }],
  };
  const r = computeChargeCost({ carGridKwhByBand: [10, 20], tariff });
  // energy = 10*0.2 + 20*0.1 = 4 ; levy = 30*0.01 = 0.3 ; no daily/fixed
  // total = 4.3 * 1.1 = 4.73
  assert.equal(r.total, 4.73);
  assert.equal(r.kwh, 30);
  assert.equal(r.bands[0].cost, 2);
});
