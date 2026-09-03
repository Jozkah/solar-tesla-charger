import test from 'node:test';
import assert from 'node:assert/strict';
import { findFlatRuns } from '../server/flat-runs.js';

const row = (ts, g, f1 = 100, f2 = 200, s2 = -300, extra = {}) => ({ ts, grid_power: g, floor1_w: f1, floor2_w: f2, solar2_w: s2, ...extra });
const STEP = 10_000;

test('a live stream with jitter has no runs', () => {
  const rows = []; for (let i = 0; i < 200; i++) rows.push(row(i * STEP, 500 + (i % 3) * 0.1));
  assert.deepEqual(findFlatRuns(rows), []);
});

test('an hour of identical rows is one run starting at the first repeat, anchor kept', () => {
  const rows = [row(0, 480.2), row(STEP, 481.1)];
  for (let i = 2; i < 2 + 360; i++) rows.push(row(i * STEP, 1021.1));
  rows.push(row(362 * STEP, 640));
  const runs = findFlatRuns(rows);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 3 * STEP); // row 2 is the anchor (last real reading)
  assert.equal(runs[0].to, 361 * STEP + 1);
  assert.equal(runs[0].rows, 359);
});

test('short repeats and idle-house repeats are ignored', () => {
  const short = []; for (let i = 0; i < 30; i++) short.push(row(i * STEP, 900)); // 5 min
  assert.deepEqual(findFlatRuns(short), []);
  const idle = []; for (let i = 0; i < 400; i++) idle.push(row(i * STEP, 0, 0, 0, 0));
  assert.deepEqual(findFlatRuns(idle), []);
});

test('backfill rows never form or extend a run', () => {
  const rows = []; for (let i = 0; i < 100; i++) rows.push(row(i * 600_000, 700, 100, 200, -300, { mode: 'backfill' }));
  assert.deepEqual(findFlatRuns(rows), []);
});

test('two separate outages give two runs', () => {
  const rows = [];
  let t = 0;
  for (let i = 0; i < 100; i++, t += STEP) rows.push(row(t, 1000));
  for (let i = 0; i < 5; i++, t += STEP) rows.push(row(t, 300 + i));
  for (let i = 0; i < 100; i++, t += STEP) rows.push(row(t, 2000));
  const runs = findFlatRuns(rows);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].rows, 99);
  assert.equal(runs[1].rows, 99);
});
