import test from 'node:test';
import assert from 'node:assert/strict';
import { withGaps } from '../server/series.js';

test('no marker across normal spacing', () => {
  const pts = [{ ts: 0 }, { ts: 10_000 }, { ts: 20_000 }];
  assert.deepEqual(withGaps(pts, 60_000), pts);
});

test('one marker per hole, placed right after the last point before it', () => {
  const pts = [{ ts: 0 }, { ts: 10_000 }, { ts: 500_000 }, { ts: 510_000 }, { ts: 2_000_000 }];
  const out = withGaps(pts, 60_000);
  assert.deepEqual(out.map((p) => p.gap ? 'gap' : p.ts), [0, 10_000, 'gap', 500_000, 510_000, 'gap', 2_000_000]);
  assert.equal(out[2].ts, 10_001);
});

test('exactly gapMs apart is not a hole; empty input stays empty', () => {
  assert.deepEqual(withGaps([{ ts: 0 }, { ts: 60_000 }], 60_000).length, 2);
  assert.deepEqual(withGaps([]), []);
});
