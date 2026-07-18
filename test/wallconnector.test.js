// Unit tests for the WC retry + circuit-breaker logic (server/wallconnector.js).
// Guards against the MEDIUM finding in the adversarial review of the WC
// resilience commit: the retry (added so a blipping WC gets a second try
// before surfacing {error}) must NOT retry forever against a persistently
// hung WC, since liveCycle runs the WC read alongside the meter read in a
// Promise.all — an uncapped retry would delay the primary sensor too.
//
// shouldRetry/readVitalsWith are pure/injectable (no network, no module
// state needed by the caller), so they're driven directly here with a fake
// fetchImpl and a fresh breakerState per test — no real socket, no timers
// beyond the (zeroed) retry backoff.
//
// server/wallconnector.js imports server/config.js at module load, which
// reads config.json (or CONFIG_PATH) as an import-time side effect. Point it
// at config.json.example via CONFIG_PATH/DB_PATH before the dynamic import,
// same pattern as test/retention.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallconnector-test-'));
const dbPath = path.join(tmpDir, 'test.db');
const configPath = path.join(tmpDir, 'config.json');
fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);

process.env.CONFIG_PATH = configPath;
process.env.DB_PATH = dbPath;

const { shouldRetry, readVitalsWith } = await import('../server/wallconnector.js');

const URL = 'http://wc.example/api/1/vitals';
const TIMEOUT_MS = 3000;
const NO_BACKOFF = 0; // skip the real 250ms wait in tests

function okResponse(body) {
  return { ok: true, json: async () => body };
}

function fakeFetch(results) {
  // results: array of either a response object or an Error to reject with.
  // Each call consumes the next entry; extra calls beyond the array reuse
  // the last entry (keeps tests terse when a test only cares about the
  // first couple of calls).
  let i = 0;
  const calls = [];
  const impl = async (...args) => {
    calls.push(args);
    const entry = results[Math.min(i, results.length - 1)];
    i += 1;
    if (entry instanceof Error) throw entry;
    return entry;
  };
  impl.calls = calls;
  return impl;
}

test('shouldRetry allows retrying below the breaker threshold', () => {
  assert.equal(shouldRetry(0, 2), true);
  assert.equal(shouldRetry(1, 2), true);
});

test('shouldRetry stops retrying at/above the breaker threshold', () => {
  assert.equal(shouldRetry(2, 2), false);
  assert.equal(shouldRetry(5, 2), false);
});

test('first attempt fails, second succeeds -> clean success and streak resets', async () => {
  const fetchImpl = fakeFetch([
    new Error('ECONNRESET'),
    okResponse({ vehicle_connected: true, contactor_closed: true, vehicle_current_a: 16, grid_v: 230 }),
  ]);
  const breakerState = { fails: 0 };
  const result = await readVitalsWith(URL, TIMEOUT_MS, fetchImpl, breakerState, NO_BACKOFF);
  assert.equal(result.error, undefined);
  assert.equal(result.connected, true);
  assert.equal(fetchImpl.calls.length, 2); // did retry once
  assert.equal(breakerState.fails, 0); // success clears the streak
});

test('both attempts fail -> returns {error} and increments the streak', async () => {
  const fetchImpl = fakeFetch([new Error('ETIMEDOUT')]);
  const breakerState = { fails: 0 };
  const result = await readVitalsWith(URL, TIMEOUT_MS, fetchImpl, breakerState, NO_BACKOFF);
  assert.match(result.error, /ETIMEDOUT/);
  assert.equal(fetchImpl.calls.length, 2); // breaker not tripped yet -> retried
  assert.equal(breakerState.fails, 1);
});

test('circuit breaker trips after 2 consecutive fails: 3rd call makes only 1 attempt', async () => {
  const breakerState = { fails: 0 };

  // Tick 1: fails twice (retry allowed, fails 0 -> 1)
  const fetch1 = fakeFetch([new Error('down')]);
  await readVitalsWith(URL, TIMEOUT_MS, fetch1, breakerState, NO_BACKOFF);
  assert.equal(fetch1.calls.length, 2);
  assert.equal(breakerState.fails, 1);

  // Tick 2: fails twice again (still below threshold, fails 1 -> 2)
  const fetch2 = fakeFetch([new Error('down')]);
  await readVitalsWith(URL, TIMEOUT_MS, fetch2, breakerState, NO_BACKOFF);
  assert.equal(fetch2.calls.length, 2);
  assert.equal(breakerState.fails, 2);

  // Tick 3: breaker tripped (fails >= 2) -> single attempt only, no retry
  const fetch3 = fakeFetch([new Error('still down')]);
  const result3 = await readVitalsWith(URL, TIMEOUT_MS, fetch3, breakerState, NO_BACKOFF);
  assert.equal(fetch3.calls.length, 1); // capped: no retry while breaker is tripped
  assert.match(result3.error, /still down/);
  assert.equal(breakerState.fails, 3);
});

test('a success after the breaker has tripped resets the streak (recovery)', async () => {
  const breakerState = { fails: 2 }; // already tripped
  const fetchImpl = fakeFetch([
    okResponse({ vehicle_connected: true, contactor_closed: false, vehicle_current_a: 0, grid_v: 230 }),
  ]);
  const result = await readVitalsWith(URL, TIMEOUT_MS, fetchImpl, breakerState, NO_BACKOFF);
  assert.equal(result.error, undefined);
  assert.equal(fetchImpl.calls.length, 1); // still capped to 1 attempt this tick (breaker was tripped going in)
  assert.equal(breakerState.fails, 0); // but the success clears it for next tick
});
