// Background runner for meter-history recovery. See backfill-pure.js for the
// CSV parsing and bucket maths (unit tested); this file owns the schedule,
// single-flight run, retries, and the DB writes.
import config from './config.js';
import * as db from './db.js';
import { startOfDayMs, nextDayMs } from './rollup.js';
import { parseEmData, bucketsToSamples, fetchEmData, DEFAULT_INTERVAL_MS } from './backfill-pure.js';

const RETRY_DELAY_MS = 5 * 60_000;
const MAX_TRIES = 3;

// --- Runner ------------------------------------------------------------------

const status = { running: false, last: null };
let pending = null; // { from, to, tries }
let timer = null;
let runWindow = null; // { from, to } wall-clock span of the last download
const SELF_GAP_SLACK_MS = 60_000;

export function getStatus() {
  return { running: status.running, last: status.last, pending: pending ? { from: pending.from, to: pending.to, tries: pending.tries } : null };
}

// Queue a gap. Overlapping requests are merged; a run already in progress is
// left alone and the merged gap picks up afterwards.
export function schedule(from, to) {
  if (!(to > from)) return;
  // A gap that opened while we were downloading is most likely OUR doing (a
  // Gen1 EM can stall /status during a transfer). Recovering it would start
  // another download, which opens another gap — an endless loop. Skip it.
  if (runWindow && from >= runWindow.from - SELF_GAP_SLACK_MS && from <= runWindow.to + SELF_GAP_SLACK_MS) return;
  pending = pending ? { from: Math.min(pending.from, from), to: Math.max(pending.to, to), tries: pending.tries } : { from, to, tries: 0 };
  kick();
}

function kick(delayMs = 0) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; run().catch(() => {}); }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function run() {
  if (status.running || !pending) return;
  const job = pending; pending = null;
  status.running = true;
  const at = Date.now();
  runWindow = { from: at, to: Infinity };
  try {
    const channels = await downloadChannels(job.from, job.to);
    const samples = bucketsToSamples({ channels, from: job.from, to: job.to });
    let rows = 0;
    for (const s of samples) rows += db.recordSampleIgnore(s);
    for (let day = startOfDayMs(job.from); day < job.to; day = nextDayMs(day)) db.deleteDayRollup(day);
    status.last = { from: job.from, to: job.to, rows, error: null, at };
    console.log(`[backfill] recovered ${rows} rows for ${new Date(job.from).toISOString()}..${new Date(job.to).toISOString()}`);
  } catch (e) {
    const error = String(e.message || e);
    status.last = { from: job.from, to: job.to, rows: 0, error, at };
    console.warn(`[backfill] failed (try ${job.tries + 1}/${MAX_TRIES}): ${error}`);
    if (job.tries + 1 < MAX_TRIES) {
      pending = pending ? { from: Math.min(pending.from, job.from), to: Math.max(pending.to, job.to), tries: job.tries + 1 } : { ...job, tries: job.tries + 1 };
      kick(RETRY_DELAY_MS);
    }
  } finally {
    runWindow.to = Date.now();
    status.running = false;
    if (pending && !timer) kick();
  }
}

// Devices in parallel, the two channels of one device one after the other.
async function downloadChannels(from, to) {
  const channels = {};
  const { devices } = config.shelly;
  await Promise.all(devices.map(async (dev) => {
    for (const [idx, meta] of Object.entries(dev.channels)) {
      const csv = await fetchEmData(dev.ip, Number(idx));
      const rows = parseEmData(csv).filter((r) => r.ts >= from - DEFAULT_INTERVAL_MS && r.ts < to + DEFAULT_INTERVAL_MS);
      channels[meta.key] = rows;
    }
  }));
  return channels;
}

export default { schedule, getStatus };
