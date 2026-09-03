import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadChannels } from '../server/backfill-download.js';

const DEVICES = [
  { ip: '10.0.0.1', channels: { 0: { key: 'floor1' }, 1: { key: 'floor2' } } },
  { ip: '10.0.0.2', channels: { 0: { key: 'grid' } } },
];
const CSV = 'Date/time UTC,a,b,c,d\n2026-09-02 10:00,100,0,230,230\n2026-09-02 10:10,200,0,230,230\n';
const FROM = Date.UTC(2026, 8, 2, 10, 0), TO = Date.UTC(2026, 8, 2, 10, 20);
const noReboot = async () => {};

test('every channel downloaded, device channels sequential, rows clipped to the window', async () => {
  const order = [];
  const fetchOne = async (ip, idx) => { order.push(`${ip}/${idx}`); return CSV; };
  const ch = await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, rebootWaitMs: 0, reboot: noReboot });
  assert.deepEqual(Object.keys(ch).sort(), ['floor1', 'floor2', 'grid']);
  assert.equal(ch.grid.length, 2);
  assert.equal(order.indexOf('10.0.0.1/0') < order.indexOf('10.0.0.1/1'), true);
});

test('a busy channel is rebooted, then the retry succeeds', async () => {
  let n = 0;
  const fetchOne = async (ip) => { if (ip === '10.0.0.2' && n++ < 1) throw new Error('device busy with another transfer'); return CSV; };
  const rebooted = [];
  const ch = await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, rebootWaitMs: 0, reboot: async (ip) => rebooted.push(ip) });
  assert.equal(ch.grid.length, 2);
  assert.deepEqual(rebooted, ['10.0.0.2']);
});

test('a connect timeout also triggers a reboot (the self-strand case)', async () => {
  let n = 0;
  const fetchOne = async (ip) => {
    if (ip === '10.0.0.2' && n++ < 1) { const e = new Error('fetch failed'); e.cause = new Error('Connect Timeout Error'); throw e; }
    return CSV;
  };
  const rebooted = [];
  await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, rebootWaitMs: 0, reboot: async (ip) => rebooted.push(ip) });
  assert.deepEqual(rebooted, ['10.0.0.2']);
});

test('a non-stuck error (bad HTTP) is retried without a reboot', async () => {
  let n = 0;
  const fetchOne = async (ip) => { if (ip === '10.0.0.2' && n++ < 1) throw new Error('HTTP 500'); return CSV; };
  const rebooted = [];
  const ch = await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, rebootWaitMs: 0, reboot: async (ip) => rebooted.push(ip) });
  assert.equal(ch.grid.length, 2);
  assert.deepEqual(rebooted, []);
});

test('a meter that stays busy through every try throws, naming the device and channel', async () => {
  const fetchOne = async (ip) => { if (ip === '10.0.0.2') throw new Error('device busy with another transfer'); return CSV; };
  await assert.rejects(
    () => downloadChannels(DEVICES, FROM, TO, { fetchOne, tries: 3, waitMs: 0, rebootWaitMs: 0, reboot: noReboot }),
    /10\.0\.0\.2 \/emeter\/0: device busy.*reboot did not clear it/,
  );
});
