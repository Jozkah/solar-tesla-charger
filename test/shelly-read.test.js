// Unit tests for the per-device retry + per-channel fallback in server/shelly.js.
// readDeviceWith takes a fake fetch so no network is touched. config.js is
// still imported by shelly.js, so these tests need a config.json present like
// the rest of the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceWith } from '../server/shelly.js';

const DEV = { ip: '10.0.0.1', channels: { 0: { key: 'grid', label: 'Grid', role: 'grid' }, 1: { key: 'solar', label: 'Solar', role: 'solar' } } };
const EM = (power) => ({ power, voltage: 230.04, pf: 0.951, total: 100.5, total_returned: 2, is_valid: true });

function fakeFetch(script) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const step = script.shift();
    if (!step) throw new Error('unexpected call ' + url);
    if (step instanceof Error) throw step;
    return { ok: true, status: 200, json: async () => step };
  };
  impl.calls = calls;
  return impl;
}

test('healthy /status answers on the first try', async () => {
  const f = fakeFetch([{ emeters: [EM(500), EM(-1200)] }]);
  const r = await readDeviceWith(DEV, 1000, f, 0);
  assert.equal(r.error, null);
  assert.deepEqual(f.calls, ['http://10.0.0.1/status']);
  assert.equal(r.channels.grid.power, 500);
  assert.equal(r.channels.solar.power, -1200);
  assert.equal(r.channels.grid.totalWh, 100.5);
  assert.equal(r.channels.grid.current, 2.17); // 500 / 230.04
});

test('one blip: /status fails, the retry succeeds, no fallback needed', async () => {
  const f = fakeFetch([new Error('timeout'), { emeters: [EM(10), EM(0)] }]);
  const r = await readDeviceWith(DEV, 1000, f, 0);
  assert.equal(r.error, null);
  assert.equal(f.calls.length, 2);
  assert.equal(r.channels.grid.power, 10);
});

test('/status dead twice: per-channel endpoints fill in', async () => {
  const f = fakeFetch([new Error('timeout'), new Error('timeout'), EM(42), EM(-7)]);
  const r = await readDeviceWith(DEV, 1000, f, 0);
  assert.equal(r.error, null);
  assert.deepEqual(f.calls.slice(2), ['http://10.0.0.1/emeter/0', 'http://10.0.0.1/emeter/1']);
  assert.equal(r.channels.grid.power, 42);
  assert.equal(r.channels.solar.power, -7);
});

test('partial fallback: grid answers, solar does not -> no device error, solar marked failed', async () => {
  const f = fakeFetch([new Error('x'), new Error('x'), EM(1), new Error('HTTP 500')]);
  const r = await readDeviceWith(DEV, 1000, f, 0);
  assert.equal(r.error, null);
  assert.equal(r.channels.grid.power, 1);
  assert.equal(r.channels.solar.power, null);
  assert.equal(r.channels.solar.valid, false);
  assert.match(r.channels.solar.error, /HTTP 500/);
});

test('everything fails: every channel failed and the device reports the error', async () => {
  const f = fakeFetch([new Error('a'), new Error('b'), new Error('c'), new Error('d')]);
  const r = await readDeviceWith(DEV, 1000, f, 0);
  assert.equal(r.error, 'd');
  assert.equal(r.channels.grid.power, null);
  assert.equal(r.channels.solar.power, null);
  assert.equal(f.calls.length, 4);
});

test('a non-2xx /status counts as a failure', async () => {
  const impl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await readDeviceWith(DEV, 1000, impl, 0);
  assert.match(r.error, /HTTP 503/);
});
