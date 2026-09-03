// period-nav.js is a browser IIFE (window.createPeriodNav). Load it with fake
// window/document/fetch/timers so the polling + wake-up behaviour is testable
// in node:test without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'period-nav.js'),
  'utf8',
);

const el = () => ({
  hidden: false, disabled: false, textContent: '', style: {}, handlers: {},
  addEventListener(ev, fn) { this.handlers[ev] = fn; },
  querySelectorAll() { return []; },
});

// Builds a nav against stubs and returns everything the assertions need.
function setup({ statsBody } = {}) {
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    return { json: async () => statsBody || { range: 'day', offset: 0, home: {}, cost: null } };
  };
  const timers = [];
  const setIntervalStub = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const clearIntervalStub = () => {};
  const docHandlers = {};
  const document = {
    hidden: false,
    addEventListener(ev, fn) { docHandlers[ev] = fn; },
  };
  const winHandlers = {};
  const window = { addEventListener(ev, fn) { winHandlers[ev] = fn; } };
  const factory = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', SRC);
  factory(window, document, fetchStub, setIntervalStub, clearIntervalStub);

  const data = [];
  const nav = window.createPeriodNav({
    navEl: el(), labelEl: el(), prevEl: el(), nextEl: el(), segEl: null,
    onData: (st) => data.push(st),
  });
  return { nav, calls, timers, document, docHandlers, winHandlers, data };
}

const flush = () => new Promise((r) => setImmediate(r));

test('refresh fetches the current range/offset and hands the payload to onData', async () => {
  const { nav, calls, data } = setup();
  await nav.refresh();
  assert.deepEqual(calls, ['/api/stats?range=day&offset=0']);
  assert.equal(data.length, 1);
});

test('stats poll runs on the live 15s cadence', () => {
  const { timers } = setup();
  assert.equal(timers.length, 1, 'createPeriodNav should own a stats poll timer');
  assert.equal(timers[0].ms, 15_000);
});

test('poll tick refreshes while the page is visible', async () => {
  const { timers, calls } = setup();
  timers[0].fn();
  await flush();
  assert.equal(calls.length, 1);
});

test('poll tick is skipped while the page is hidden', async () => {
  const { timers, calls, document } = setup();
  document.hidden = true;
  timers[0].fn();
  await flush();
  assert.equal(calls.length, 0, 'no point fetching stats nobody can see');
});

test('becoming visible again refreshes immediately', async () => {
  const { calls, document, docHandlers } = setup();
  assert.equal(typeof docHandlers.visibilitychange, 'function', 'must listen for visibilitychange');
  document.hidden = true;
  docHandlers.visibilitychange();
  await flush();
  assert.equal(calls.length, 0, 'going away must not fetch');
  document.hidden = false;
  docHandlers.visibilitychange();
  await flush();
  assert.equal(calls.length, 1, 'coming back must fetch at once, not wait for the next tick');
});

test('a restored page (bfcache / iOS home screen) refreshes immediately', async () => {
  const { calls, winHandlers } = setup();
  assert.equal(typeof winHandlers.pageshow, 'function', 'must listen for pageshow');
  winHandlers.pageshow({ persisted: true });
  await flush();
  assert.equal(calls.length, 1);
});

test('a plain page load does not double-fetch via pageshow', async () => {
  const { calls, winHandlers } = setup();
  winHandlers.pageshow({ persisted: false }); // fires on every normal load
  await flush();
  assert.equal(calls.length, 0, 'the caller boot-refresh already covers a fresh load');
});

test('stale response for a range the user left is dropped', async () => {
  const { nav, data } = setup({ statsBody: { range: 'week', offset: 0, home: {} } });
  await nav.refresh(); // nav is on 'day'; a 'week' payload must not render
  assert.equal(data.length, 0);
});
