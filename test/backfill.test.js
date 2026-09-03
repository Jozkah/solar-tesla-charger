// Unit tests for the pure half of server/backfill.js: parsing the Shelly EM
// em_data.csv log and turning 10-minute Wh buckets into sample rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmData, bucketInterval, bucketsToSamples, fetchEmData, BUSY_BODY } from '../server/backfill-pure.js';

const T0 = Date.UTC(2026, 8, 3, 12, 0); // 2026-09-03 12:00 UTC
const csv = `Date/time UTC,Active energy Wh (1),Returned energy Wh (1),Min V,Max V
2026-09-03 12:00,100.00,0.00,226.0,232.0
2026-09-03 12:10,0.00,300.00,228.0,234.0

garbage line
2026-09-03 12:20,50.00,25.00,230.0,230.0
2026-09-03 12:3`; // cut mid-transfer

test('parseEmData skips header, blanks, junk and a truncated last line', () => {
  const rows = parseEmData(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { ts: T0, wh: 100, returnedWh: 0, minV: 226, maxV: 232 });
  assert.equal(rows[1].ts, T0 + 600_000);
});

test('parseEmData sorts by time and tolerates CRLF', () => {
  const rows = parseEmData('2026-09-03 12:10,1,0\r\n2026-09-03 12:00,2,0\r\n');
  assert.deepEqual(rows.map((r) => r.ts), [T0, T0 + 600_000]);
  assert.equal(rows[0].minV, null);
});

test('bucketInterval is the median spacing, 10 min when unknown', () => {
  assert.equal(bucketInterval([]), 600_000);
  assert.equal(bucketInterval([{ ts: 0 }, { ts: 60_000 }, { ts: 120_000 }, { ts: 900_000 }]), 60_000);
});

test('bucketsToSamples: sign convention, export/import split, voltage mean, window clipping', () => {
  const grid = parseEmData(csv);
  const solar = [
    { ts: T0, wh: 0, returnedWh: 500, minV: 230, maxV: 230 },
    { ts: T0 + 600_000, wh: 0, returnedWh: 0, minV: 230, maxV: 230 },
    { ts: T0 + 1_200_000, wh: 0, returnedWh: 100, minV: 230, maxV: 230 },
  ];
  const out = bucketsToSamples({ channels: { grid, solarPanels2: solar }, from: T0, to: T0 + 1_200_000 });
  assert.equal(out.length, 2); // 12:20 bucket starts at `to`, excluded
  // 100 Wh over 10 min = 600 W import
  assert.equal(out[0].gridPower, 600);
  assert.equal(out[0].importW, 600);
  assert.equal(out[0].exportW, 0);
  assert.equal(out[0].solarPanels2, -3000); // 500 Wh returned in 10 min, negative = generation
  assert.equal(out[0].voltage, 229.5); // mean of (226+232)/2 and (230+230)/2
  // 300 Wh returned = 1800 W export
  assert.equal(out[1].gridPower, -1800);
  assert.equal(out[1].exportW, 1800);
  assert.equal(out[1].importW, 0);
  for (const s of out) {
    assert.equal(s.mode, 'backfill');
    assert.equal(s.action, 'backfill');
    assert.equal(s.chargeW, 0);
    assert.equal(s.charging, false);
    assert.equal(s.floor1W, null);
  }
});

test('bucketsToSamples with no channel data yields nothing', () => {
  assert.deepEqual(bucketsToSamples({ channels: {}, from: 0, to: 1 }), []);
});

test('fetchEmData treats the busy body as an error and non-2xx as an error', async () => {
  const mk = (ok, status, body) => async () => ({ ok, status, text: async () => body });
  await assert.rejects(() => fetchEmData('1.2.3.4', 0, { fetchImpl: mk(true, 200, BUSY_BODY) }), /busy/);
  await assert.rejects(() => fetchEmData('1.2.3.4', 0, { fetchImpl: mk(false, 500, '') }), /HTTP 500/);
  assert.equal(await fetchEmData('1.2.3.4', 1, { fetchImpl: mk(true, 200, 'Date/time UTC,a,b\n') }), 'Date/time UTC,a,b\n');
});
