// Derives the dashboard statistics from the SQLite sample/session history.
import { queries, currentSession, saveDayRollup, readDayRollup } from './db.js';
import config from './config.js';
import {
  computeDayRollup, foldRollups, nextDayMs, isDayComplete, shouldPersistDay, walkStartMs,
  startOfDayMs, floorKnownStart,
} from './rollup.js';
import { getBillingDay, getTariff } from './settings.js';
import { hourBandMap, foldHoursToBands, computeCost, computeChargeCost } from './cost.js';
import { withGaps } from './series.js';

// periodBounds now lives in period.js (pure, billing-aware). Re-exported so the
// previous public API (used by tests / callers) is preserved.
export { periodBounds } from './period.js';
import { periodBounds } from './period.js';

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The calendar day of the earliest SURVIVING sample, or Infinity if the
// database is empty. Answers "may we PERSIST this day?" — a day must have
// samples we can actually compute from to freeze a rollup. Every real day is
// < Infinity, so shouldPersistDay's `dayStart < historyStart` check correctly
// refuses to persist anything. Do NOT use this to decide how far back to WALK
// a range (see knownStartMs) — samples get pruned but daily_stats rows don't,
// so this alone would skip days whose only surviving record is a stored rollup.
function historyStartMs() {
  const firstTs = queries.firstSampleTs.get()?.ts ?? null;
  return firstTs == null ? Infinity : startOfDayMs(firstTs);
}

// The calendar day of the earliest thing we KNOW about — a stored daily_stats
// row (whose backing samples may already be pruned) or the earliest surviving
// sample, whichever is older. Infinity if the database is entirely empty.
// Answers "how far back do we know anything?" — this is the correct bound for
// walking a range (rollupRange), because daily_stats outlives the sample
// prune and must never be silently skipped. Floored via floorKnownStart so a
// stray pre-history daily_stats row (restore-from-backup, clock skew, manual
// insert) can't drag every walk back to it — see rollup.js for why that
// matters (shouldPersistDay never lets such a row's cache heal itself).
function knownStartMs() {
  const firstRollup = queries.firstRollupDay.get()?.day_ts ?? null;
  const firstSample = queries.firstSampleTs.get()?.ts ?? null;
  const starts = [firstRollup, firstSample == null ? null : startOfDayMs(firstSample)]
    .filter((v) => v != null);
  const rawStart = starts.length ? Math.min(...starts) : Infinity;
  return floorKnownStart(rawStart, Date.now());
}

function retentionStartMs() {
  return Date.now() - config.db.sampleRetentionDays * 86_400_000;
}

// One day's rollup: stored rows for eligible completed days, live compute
// otherwise. A persisted rollup is immutable and kept forever — this is what
// makes week/month/all cheap. `historyStart`/`retentionStart` are passed in
// (computed once per call by the caller, never per day) so this never runs an
// extra query inside a day-by-day loop.
function dayRollup(dayStart, historyStart, retentionStart) {
  const dayEnd = nextDayMs(dayStart);
  const now = Date.now();
  // A complete day's stored row must always be trusted on read, independent of
  // whether it would be (re-)eligible for persist right now: a day rolled up
  // while still inside the retention window stays true forever even after its
  // samples fall out of retention and get pruned. Gating the read behind
  // `persist` (as before) made such days silently recompute to zero once their
  // samples were gone — this is the fix for that.
  if (isDayComplete(dayStart, now)) {
    const hit = readDayRollup(dayStart);
    // Trust a stored complete day UNLESS it predates the per-hour histogram
    // columns (import_wh_by_hour === null for a legacy rollup) AND its samples
    // are still within retention to backfill from — then fall through to
    // recompute+repersist ONCE, so time-of-use cost isn't permanently zero for
    // days rolled up before this feature. Beyond retention (samples pruned) the
    // stored row is kept as-is; its histograms stay zero, unavoidable.
    if (hit && (hit.import_wh_by_hour != null || dayStart < retentionStart)) return hit;
  }
  const persist = shouldPersistDay(dayStart, now, historyStart, retentionStart);
  const before = queries.sampleBefore.get(dayStart);   // last charging sample; seeds prevAmps
  const after = queries.sampleAtOrAfter.get(dayEnd);   // closes the last interval
  const rows = [
    ...(before ? [before] : []),
    ...queries.samplesBetween.all(dayStart, dayEnd),
    ...(after ? [after] : []),
  ];
  const r = computeDayRollup(rows, dayStart, dayEnd);
  // A day that fails shouldPersistDay (still running, before real history, or
  // straddling the retention cutoff) still computes correctly above — it's
  // just never written to daily_stats, so it can't freeze a wrong value.
  if (persist) saveDayRollup(r);
  return r;
}

// Fold every day in [since, until) — the calendar ranges. Days before anything
// we know about are never walked individually: they compute to zero rollups
// anyway (no samples, no stored row), and folding nothing is equivalent to
// folding zeros. This is what stops an ancient `offset` from walking thousands
// of pre-history days. Uses knownStart (not historyStart) so a day whose
// samples were pruned but whose daily_stats row survives is still walked —
// see knownStartMs and rollup.js's walkStartMs for why.
function rollupRange(since, until) {
  const knownStart = knownStartMs();
  const historyStart = historyStartMs();
  const retentionStart = retentionStartMs();
  const walkSince = walkStartMs(since, until, knownStart);
  const days = [];
  for (let d = walkSince; d < until; d = nextDayMs(d)) days.push(dayRollup(d, historyStart, retentionStart));
  return foldRollups(days);
}

// 'all' spans from the earliest thing we know about — a stored rollup (whose
// samples may already be pruned) or the oldest surviving sample, whichever is
// older — through today. Going day-by-day rather than reading only the stored
// rollups matters: a day that was never viewed has no row yet, and folding
// only stored rows would silently drop it.
function allTimeTotals() {
  const knownStart = knownStartMs();
  if (knownStart === Infinity) return foldRollups([]); // empty database
  return rollupRange(knownStart, nextDayMs(startOfTodayMs()));
}

// Boot warm-up cursor: which day warmNextRollupDay looks at next. Module-level
// so repeated setImmediate calls resume where the last one left off; lost on
// restart, which is harmless — the next boot just starts the scan over, and
// already-persisted days are skipped almost for free (a single indexed read).
let warmCursor = null;

// Compute+persist (or cheaply skip, if already stored) exactly one day's
// rollup, advancing the cursor. Called from controller.js's boot warm-up via
// setImmediate, one day per tick, so the synchronous DB work (~25ms/day worst
// case) never blocks the live/control loops or the SSE feed for more than one
// day at a stretch. Returns true if there's more to warm, false when the
// cursor has reached today (nothing further to do this run).
export function warmNextRollupDay() {
  const historyStart = historyStartMs();
  if (historyStart === Infinity) return false; // empty database — nothing to warm
  const today = startOfTodayMs();
  if (warmCursor == null || warmCursor < historyStart) warmCursor = historyStart;
  if (warmCursor >= today) return false; // reached today — done for this run
  const day = warmCursor;
  warmCursor = nextDayMs(warmCursor);
  // dayRollup() itself returns the cached row immediately when one already
  // exists (see the `persist` cache-hit check above), so an already-warmed day
  // costs one indexed lookup here, not a re-computation.
  dayRollup(day, historyStart, retentionStartMs());
  return true;
}

export function getStats(range = 'today', offset = 0) {
  const now = Date.now();
  let since;
  let until = null; // null = open-ended (up to now)
  const bounds = periodBounds(range, offset, getBillingDay(), now);
  if (bounds) ({ since, until } = bounds);
  else if (range === 'all') since = 0;
  else if (range === 'session') {
    const s = currentSession();
    since = s ? s.started_at : now - 3_600_000;
  } else since = startOfTodayMs();

  const peakAll = queries.peakAllTime.get() || {};

  // Calendar ranges fold immutable per-day rollups; session/today stay live.
  let t;
  let sampleCount;
  if (bounds) {
    t = rollupRange(since, Math.min(until, nextDayMs(startOfTodayMs())));
    sampleCount = t.samples;
  } else if (range === 'all') {
    // Every day we have any record of. Rollups outlive the sample prune, so
    // 'all' now covers more than the sampleRetentionDays window the samples
    // table holds — but it must also include sample days never rolled up yet,
    // or a day nobody happened to view would vanish from the total.
    t = allTimeTotals();
    sampleCount = t.samples;
  } else {
    const rows = queries.samplesSince.all(since);
    t = computeDayRollup(rows, since, now + 1);
    sampleCount = rows.length;
  }

  // Estimated grid-import cost + marginal car-charging cost, derived from the
  // folded per-hour histograms. Bands are applied HERE (read time), so editing
  // tariff windows re-buckets stored history without any re-integration.
  let cost = null;
  let chargeCost = null;
  const importByHour = t.import_wh_by_hour; // 24-length Wh array (zeros for legacy rows)
  if (importByHour) {
    const tariff = getTariff();
    const map = hourBandMap(tariff.bands);
    const bandKwh = foldHoursToBands(importByHour, map, tariff.bands.length);
    // Daily fixed charge must reflect real elapsed days of data, never epoch:
    // open-ended ranges (all/session/today) measure from the earliest day we
    // know anything about, not since=0.
    const windowEnd = until != null ? Math.min(now, until) : now;
    const windowStart = until != null ? since : Math.max(since, knownStartMs());
    const elapsedDays = Math.max(0, (windowEnd - windowStart) / 86_400_000);
    cost = computeCost({ bandKwh, tariff, elapsedDays });
    const carGridKwh = foldHoursToBands(t.car_grid_wh_by_hour || new Array(24).fill(0), map, tariff.bands.length);
    chargeCost = computeChargeCost({ carGridKwhByBand: carGridKwh, tariff });
  }

  const carWh = t.car_wh;
  const carSolarWh = t.car_solar_wh;
  const carGridWh = t.car_grid_wh;
  const exportWh = t.export_wh;
  const importWh = t.import_wh;
  const solar2Wh = t.solar2_wh;
  const solaxWh = t.solax_wh;
  const usedWh = t.used_wh;
  // Total solar generation = Growatt clamp (generation is negative) + SolaX cloud.
  // Deliberately NOT floored by the energy balance the way the live dashboard tile
  // is: solax_w is a cloud reading minutes behind the live grid/charge columns, so
  // per-sample max(measured, balance) would grab each ramp peak without the
  // matching trough and bias the total up (~+7% over the June history). The floor
  // fixes an instantaneous display; an energy total has to stay measured.
  const solarGenWh = solar2Wh + solaxWh;
  const peakW = t.peak_w;
  const peakAmps = t.peak_amps;
  const chargingMinutes = Math.round(t.charging_samples * config.control.pollIntervalSec / 60);
  const adjustments = t.adjustments;

  const session = currentSession();

  return {
    range,
    offset,
    since,
    until,
    now,
    cost,
    chargeCost,
    samples: sampleCount,
    car: {
      energyWh: round0(carWh),
      solarWh: round0(carSolarWh),
      gridWh: round0(carGridWh),
      solarPct: carWh > 0 ? Math.round((carSolarWh / carWh) * 100) : null,
      peakW: round0(peakW),
      peakAmps,
      chargingMinutes,
      adjustments,
    },
    home: {
      solarGeneratedWh: round0(solarGenWh), // Growatt + SolaX
      growattWh: round0(solar2Wh),
      solaxWh: round0(solaxWh),
      exportedWh: round0(exportWh),
      importedWh: round0(importWh),
      usedWh: round0(usedWh),
    },
    allTime: {
      peakW: round0(peakAll.peak_w || 0),
      peakAmps: peakAll.peak_amps || 0,
    },
    session: session
      ? {
          startedAt: session.started_at,
          energyWh: round0(session.energy_wh),
          solarWh: round0(session.solar_wh),
          gridWh: round0(session.grid_wh),
          peakW: round0(session.peak_w),
          peakAmps: session.peak_amps,
          adjustments: session.adjustments,
        }
      : null,
  };
}

// Time-series for charts (downsampled): last N hours of selected metrics.
export function getSeries(hours = 1) {
  const since = Date.now() - hours * 3_600_000;
  const rows = queries.samplesSince.all(since);
  const maxPoints = 360;
  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = [];
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i];
    out.push({
      ts: r.ts,
      gridPower: r.grid_power,
      exportW: r.export_w,
      chargeW: r.charge_w,
      solar2W: r.solar2_w,
      floor1W: r.floor1_w,
      floor2W: r.floor2_w,
      solaxW: r.solax_w,
      chargeAmps: r.charge_amps,
    });
  }
  // Mark holes (an outage with no rows) so the charts break the line there.
  return withGaps(out);
}

function round0(n) {
  return n == null ? 0 : Math.round(n);
}

export default { getStats, getSeries, warmNextRollupDay };
