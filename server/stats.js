// Derives the dashboard statistics from the SQLite sample/session history.
import { queries, currentSession } from './db.js';
import config from './config.js';

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

// Integrate a signed power column (W) over a list of time-ordered samples -> Wh.
// Only counts the positive part when `positiveOnly`, else the whole signed value.
function integrate(rows, pick, { positiveOnly = false } = {}) {
  let wh = 0;
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue; // skip gaps
    let w = pick(rows[i - 1]);
    if (w == null) continue;
    if (positiveOnly) w = Math.max(0, w);
    wh += w * dtH;
  }
  return wh;
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

  const rows = until != null ? queries.samplesBetween.all(since, until) : queries.samplesSince.all(since);
  const peakAll = queries.peakAllTime.get() || {};

  // Energy figures from sample integration (robust even without session rows).
  const carWh = integrate(rows, (r) => r.charge_w, { positiveOnly: true });
  const solar2Wh = integrate(rows, (r) => -Math.min(0, r.solar2_w || 0)); // solar generates negative
  const exportWh = integrate(rows, (r) => r.export_w, { positiveOnly: true });
  const importWh = integrate(rows, (r) => r.import_w, { positiveOnly: true });

  // Solar vs grid share of what went into the car.
  let carSolarWh = 0;
  let carGridWh = 0;
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const r = rows[i - 1];
    const cw = Math.max(0, r.charge_w || 0);
    if (cw <= 0) continue;
    const gridShare = (r.import_w || 0) > 0 ? Math.min(r.import_w, cw) : 0;
    carGridWh += gridShare * dtH;
    carSolarWh += (cw - gridShare) * dtH;
  }

  // Total solar generation = Growatt clamp (generation is negative) + SolaX cloud.
  // Deliberately NOT floored by the energy balance the way the live dashboard tile
  // is: solax_w is a cloud reading minutes behind the live grid/charge columns, so
  // per-sample max(measured, balance) would grab each ramp peak without the
  // matching trough and bias the total up (~+7% over the June history). The floor
  // fixes an instantaneous display; an energy total has to stay measured.
  const solaxWh = integrate(rows, (r) => Math.max(0, r.solax_w || 0));
  const solarGenWh = solar2Wh + solaxWh;

  // Estimated whole-home consumption via energy balance at the grid meter:
  //   consumption = total_generation + grid_power   (grid_power: + import, - export)
  // Both arrays sit behind the main grid meter, so this nets out correctly.
  let usedWh = 0;
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const r = rows[i - 1];
    const gen = -Math.min(0, r.solar2_w || 0) + Math.max(0, r.solax_w || 0);
    const cons = Math.max(0, gen + (r.grid_power || 0));
    usedWh += cons * dtH;
  }

  // Peaks within range.
  let peakW = 0;
  let peakAmps = 0;
  let chargingSamples = 0;
  let adjustments = 0;
  let prevAmps = null;
  for (const r of rows) {
    if ((r.charge_w || 0) > peakW) peakW = r.charge_w;
    if ((r.charge_amps || 0) > peakAmps) peakAmps = r.charge_amps;
    if (r.charging) chargingSamples++;
    if (r.charging && prevAmps != null && r.charge_amps != null && r.charge_amps !== prevAmps) adjustments++;
    if (r.charging) prevAmps = r.charge_amps;
  }
  const chargingMinutes = Math.round(chargingSamples * config.control.pollIntervalSec / 60);

  const session = currentSession();

  return {
    range,
    offset,
    since,
    until,
    now,
    samples: rows.length,
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
