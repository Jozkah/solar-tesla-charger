// Unit tests for the pure WC grace-window resolver (server/wc-resolve.js).
// The bug this guards: a single failed/slow WC poll used to flip wcOk false
// for that tick, sending the charging decision onto laggy car telemetry
// (phantom peaks, car showing 0W mid-charge). resolveWcReading carries the
// last successful reading through a short grace window instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWcReading } from '../server/wc-resolve.js';

const GRACE_MS = 15_000;
const GOOD = { connected: true, charging: true, currentA: 16, voltage: 230, power: 3680 };

test('fresh success is used directly and reported good', () => {
  const { wc, good } = resolveWcReading({
    read: GOOD, lastGood: null, lastGoodAt: 0, nowMs: 1_000, graceMs: GRACE_MS,
  });
  assert.equal(good, true);
  assert.equal(wc, GOOD); // same object, not carried/copied
});

test('failure within grace with a lastGood present carries the last-good reading', () => {
  const read = { error: 'timeout' };
  const lastGoodAt = 1_000;
  const nowMs = lastGoodAt + 5_000; // well within the 15s grace window
  const { wc, good } = resolveWcReading({ read, lastGood: GOOD, lastGoodAt, nowMs, graceMs: GRACE_MS });
  assert.equal(good, false);
  assert.equal(wc.carried, true);
  assert.equal(wc.connected, GOOD.connected);
  assert.equal(wc.currentA, GOOD.currentA);
  assert.equal(wc.error, undefined);
});

test('failure past the grace window surfaces the error read', () => {
  const read = { error: 'timeout' };
  const lastGoodAt = 1_000;
  const nowMs = lastGoodAt + 20_000; // past the 15s grace window
  const { wc, good } = resolveWcReading({ read, lastGood: GOOD, lastGoodAt, nowMs, graceMs: GRACE_MS });
  assert.equal(good, false);
  assert.equal(wc, read);
  assert.equal(wc.error, 'timeout');
});

test('failure with no lastGood (never succeeded) surfaces the error immediately', () => {
  const read = { error: 'ECONNREFUSED' };
  const { wc, good } = resolveWcReading({
    read, lastGood: null, lastGoodAt: 0, nowMs: 1_000, graceMs: GRACE_MS,
  });
  assert.equal(good, false);
  assert.equal(wc, read);
});

test('a success right after a carried failure is fresh again (good true)', () => {
  const failRead = { error: 'timeout' };
  const carried = resolveWcReading({
    read: failRead, lastGood: GOOD, lastGoodAt: 1_000, nowMs: 3_000, graceMs: GRACE_MS,
  });
  assert.equal(carried.good, false);

  const recovered = { connected: true, charging: true, currentA: 12, voltage: 230, power: 2760 };
  const { wc, good } = resolveWcReading({
    read: recovered, lastGood: GOOD, lastGoodAt: 1_000, nowMs: 4_000, graceMs: GRACE_MS,
  });
  assert.equal(good, true);
  assert.equal(wc, recovered);
});

test('boundary: elapsed time exactly equal to graceMs is treated as expired (not carried)', () => {
  const read = { error: 'timeout' };
  const lastGoodAt = 1_000;
  const nowMs = lastGoodAt + GRACE_MS; // exactly graceMs elapsed
  const { wc, good } = resolveWcReading({ read, lastGood: GOOD, lastGoodAt, nowMs, graceMs: GRACE_MS });
  assert.equal(good, false);
  assert.equal(wc, read); // surfaced, not carried — strict `<` excludes the boundary
});

test('a successful "not charging / unplugged" reading is never carried over — it is fresh truth', () => {
  const notCharging = { connected: false, charging: false, currentA: 0, voltage: 230, power: 0 };
  const { wc, good } = resolveWcReading({
    read: notCharging, lastGood: GOOD, lastGoodAt: 1_000, nowMs: 2_000, graceMs: GRACE_MS,
  });
  assert.equal(good, true);
  assert.equal(wc, notCharging); // used directly, no `carried` flag, not the stale GOOD reading
  assert.equal(wc.carried, undefined);
});
