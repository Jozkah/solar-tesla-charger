import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadChannels } from '../server/backfill-download.js';

const DEVICES = [
  { ip: '10.0.0.1', channels: { 0: { key: 'floor1' }, 1: { key: 'floor2' } } },
  { ip: '10.0.0.2', channels: { 0: { key: 'grid' } } },
];
const CSV = 'Date/time UTC,a,b,c,d\n2026-09-02 10:00,100,0,230,230\n2026-09-02 10:10,200,0,230,230\n';
const FROM = Date.UTC(2026, 8, 2, 10, 0), TO = Date.UTC(2026, 8, 2, 10, 20);

test('every channel downloaded, device channels sequential, rows clipped to the window', async () => {
  const order = [];
  const fetchOne = async (ip, idx) => { order.push(`${ip}/${idx}`); return CSV; };
  const ch = await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0 });
  assert.deepEqual(Object.keys(ch).sort(), ['floor1', 'floor2', 'grid']);
  assert.equal(ch.grid.length, 2);
  assert.equal(order.indexOf('10.0.0.1/0') < order.indexOf('10.0.0.1/1'), true);
});

test('a channel that fails twice then succeeds is retried, not fatal', async () => {
  let n = 0;
  const fetchOne = async (ip, idx) => { if (ip === '10.0.0.2' && n++ < 2) throw new Error('device busy'); return CSV; };
  const log = [];
  const ch = await downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, log: (m) => log.push(m) });
  assert.equal(ch.grid.length, 2);
  assert.equal(log.filter((m) => m.includes('device busy')).length, 2);
});

test('a channel that never answers throws with the device and channel named', async () => {
  const fetchOne = async (ip) => { if (ip === '10.0.0.2') { const e = new Error('fetch failed'); e.cause = new Error('Connect Timeout Error'); throw e; } return CSV; };
  await assert.rejects(() => downloadChannels(DEVICES, FROM, TO, { fetchOne, waitMs: 0, tries: 2 }), /10\.0\.0\.2 \/emeter\/0: Connect Timeout Error/);
});
