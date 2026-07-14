// Derives the dashboard statistics from the SQLite sample/session history.
import { queries, currentSession, saveDayRollup } from './db.js';
import config from './config.js';
import { computeDayRollup, foldRollups } from './rollup.js';

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// [since, until) bounds for a calendar period, `offset` periods back from the
// current one (offset 0 = today / this week / this month). Weeks start Monday.
export function periodBounds(range, offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === 'day') {
    d.setDate(d.getDate() - offset);
    const since = d.getTime();
    d.setDate(d.getDate() + 1);
    return { since, until: d.getTime() };
  }
  if (range === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow - offset * 7);
    const since = d.getTime();
    d.setDate(d.getDate() + 7);
    return { since, until: d.getTime() };
  }
  if (range === 'month') {
    d.setDate(1);
    d.setMonth(d.getMonth() - offset);
    const since = d.getTime();
    d.setMonth(d.getMonth() + 1);
    return { since, until: d.getTime() };
  }
  return null;
}

// One day's rollup: stored rows for completed days, live compute for today.
// A completed day is immutable, so it's computed once and kept forever — this
// is what makes week/month/all cheap.
function dayRollup(dayStart) {
  const dayEnd = dayStart + 86_400_000;
  const isToday = dayStart >= startOfTodayMs();
  if (!isToday) {
    const hit = queries.dayRollup.get(dayStart);
    if (hit) return hit;
  }
  const before = queries.sampleBefore.get(dayStart);   // last charging sample; seeds prevAmps
  const after = queries.sampleAtOrAfter.get(dayEnd);   // closes the last interval
  const rows = [
    ...(before ? [before] : []),
    ...queries.samplesBetween.all(dayStart, dayEnd),
    ...(after ? [after] : []),
  ];
  const r = computeDayRollup(rows, dayStart, dayEnd);
  // Never freeze a day that's still running. Empty days are stored too, so a
  // day the server was off isn't recomputed on every future view.
  if (!isToday) saveDayRollup(r);
  return r;
}

// Fold every day in [since, until) — the calendar ranges.
function rollupRange(since, until) {
  const days = [];
  for (let d = since; d < until; d += 86_400_000) days.push(dayRollup(d));
  return foldRollups(days);
}

function startOfDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 'all' spans from the earliest thing we know about — a stored rollup (whose
// samples may already be pruned) or the oldest surviving sample, whichever is
// older — through today. Going day-by-day rather than reading only the stored
// rollups matters: a day that was never viewed has no row yet, and folding
// only stored rows would silently drop it.
function allTimeTotals() {
  const firstRollup = queries.firstRollupDay.get()?.day_ts ?? null;
  const firstSample = queries.firstSampleTs.get()?.ts ?? null;
  const starts = [firstRollup, firstSample == null ? null : startOfDayMs(firstSample)]
    .filter((v) => v != null);
  if (!starts.length) return foldRollups([]); // empty database
  return rollupRange(Math.min(...starts), startOfTodayMs() + 86_400_000);
}

export function getStats(range = 'today', offset = 0) {
  const now = Date.now();
  let since;
  let until = null; // null = open-ended (up to now)
  const bounds = periodBounds(range, offset);
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
    t = rollupRange(since, Math.min(until, startOfTodayMs() + 86_400_000));
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
  return out;
}

function round0(n) {
  return n == null ? 0 : Math.round(n);
}

export default { getStats, getSeries };
