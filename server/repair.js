// One-time repair of flat runs already recorded in the samples table (see
// flat-runs.js for what a flat run is). Downloads each Shelly EM channel's
// energy log ONCE, deletes the repeated rows of every run, and re-inserts
// 10-minute backfill rows for those windows. Runs automatically once at
// startup (controller.start -> runOnceAtStartup) and can be run by hand:
//
//   node server/repair-flat.js [--dry-run] [--since 2026-08-01]
//
// Idempotent: the settings key below records the completed run; backfill
// rows are skipped by the detector, so a second pass finds nothing.
import config from './config.js';
import * as db from './db.js';
import { startOfDayMs, nextDayMs } from './rollup.js';
import { findFlatRuns } from './flat-runs.js';
import { bucketsToSamples } from './backfill-pure.js';
import { downloadChannels } from './backfill-download.js';

export const SETTING_KEY = 'flat_repair_v1_done_at';
const STARTUP_DELAY_MS = 90_000; // let the live loop settle first

export async function repairFlatRuns({ since = 0, dryRun = false, log = console.log } = {}) {
  const rows = db.queries.samplesSince.all(since);
  const runs = findFlatRuns(rows);
  const summary = { runs, deleted: 0, inserted: 0, downloaded: false };
  for (const r of runs) {
    log(`[repair] flat run ${new Date(r.from).toISOString()} .. ${new Date(r.to).toISOString()} (${r.rows} rows)`);
  }
  if (!runs.length || dryRun) return summary;

  const from = Math.min(...runs.map((r) => r.from)), to = Math.max(...runs.map((r) => r.to));
  const channels = await downloadChannels(config.shelly.devices, from, to, { log });
  summary.downloaded = true;

  const days = new Set();
  for (const r of runs) {
    const samples = bucketsToSamples({ channels, from: r.from, to: r.to });
    // Only replace a run we can actually refill; otherwise leave the flat rows
    // (a gap with nothing is worse than a plateau for the day's totals).
    if (!samples.length) { log(`[repair] no log data for run at ${new Date(r.from).toISOString()}, kept`); continue; }
    summary.deleted += db.deleteSamplesBetween(r.from, r.to);
    for (const s of samples) summary.inserted += db.recordSampleIgnore(s);
    for (let d = startOfDayMs(r.from); d < r.to; d = nextDayMs(d)) days.add(d);
  }
  for (const d of days) db.deleteDayRollup(d);
  log(`[repair] deleted ${summary.deleted} flat rows, inserted ${summary.inserted} backfill rows, reset ${days.size} day rollups`);
  return summary;
}

export function runOnceAtStartup() {
  if (db.getSetting(SETTING_KEY)) return null;
  const t = setTimeout(async () => {
    try {
      await repairFlatRuns({});
      db.setSetting(SETTING_KEY, new Date().toISOString());
    } catch (e) {
      console.warn(`[repair] startup repair failed, will retry next start: ${e.message || e}`);
    }
  }, STARTUP_DELAY_MS);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

export default { repairFlatRuns, runOnceAtStartup, SETTING_KEY };
