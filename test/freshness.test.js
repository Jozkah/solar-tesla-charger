// Unit tests for the pure staleness rules (server/freshness.js).
// The bug this guards: a LAN outage left state.meters holding one reading for
// six hours and the control loop kept recording and acting on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meterSignature, isActive, resolveFreshness } from '../server/freshness.js';

const MAX_AGE = 30_000, FREEZE = 300_000;
const meters = (p) => ({ channels: { grid: { power: p, totalWh: 1000, totalReturnedWh: 5 }, floor1: { power: 10, totalWh: 20, totalReturnedWh: 0 } } });

test('fresh: recent success, signature still moving', () => {
  const r = resolveFreshness({ okAt: 100_000, sigChangedAt: 99_000, active: true, nowMs: 101_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.deepEqual(r, { fresh: true, reason: null, sinceMs: 0 });
});

test('unreachable once the last success is older than maxAgeMs; since = first failure', () => {
  const r = resolveFreshness({ okAt: 100_000, failedSince: 102_000, sigChangedAt: 99_000, active: true, nowMs: 131_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.fresh, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.sinceMs, 102_000);
});

test('never succeeded is unreachable', () => {
  const r = resolveFreshness({ nowMs: 5_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.reason, 'unreachable');
});

test('exactly maxAgeMs old is still fresh (boundary)', () => {
  const r = resolveFreshness({ okAt: 100_000, sigChangedAt: 100_000, active: true, nowMs: 130_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.fresh, true);
});

test('frozen when the signature has not changed for freezeMs while active', () => {
  const r = resolveFreshness({ okAt: 500_000, sigChangedAt: 100_000, active: true, nowMs: 500_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.fresh, false);
  assert.equal(r.reason, 'frozen');
  assert.equal(r.sinceMs, 400_000); // sigChangedAt + freezeMs
});

test('an idle house with a stuck signature is NOT frozen', () => {
  const r = resolveFreshness({ okAt: 500_000, sigChangedAt: 100_000, active: false, nowMs: 500_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.fresh, true);
});

test('unreachable wins over frozen', () => {
  const r = resolveFreshness({ okAt: 100_000, failedSince: 101_000, sigChangedAt: 0, active: true, nowMs: 900_000, maxAgeMs: MAX_AGE, freezeMs: FREEZE });
  assert.equal(r.reason, 'unreachable');
});

test('meterSignature changes when power or the Wh counter moves, and ignores key order', () => {
  const a = meterSignature(meters(500));
  assert.equal(a, meterSignature({ channels: { floor1: { power: 10, totalWh: 20, totalReturnedWh: 0 }, grid: { power: 500, totalWh: 1000, totalReturnedWh: 5 } } }));
  assert.notEqual(a, meterSignature(meters(501)));
  const bumped = meters(500); bumped.channels.grid.totalWh = 1001;
  assert.notEqual(a, meterSignature(bumped));
  assert.equal(meterSignature(null), '');
});

test('isActive needs one channel at or above minW', () => {
  assert.equal(isActive(meters(0), 50), false); // floor1 at 10 W is below the floor
  assert.equal(isActive(meters(-60), 50), true); // export counts as activity
  assert.equal(isActive(meters(49), 50), false);
  assert.equal(isActive(meters(50), 50), true);
  assert.equal(isActive(null), false);
});
