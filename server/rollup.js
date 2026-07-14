// One day's aggregates, computed in a single pass.
//
// `rows` must be time-ordered and may include two samples outside the day:
//   * one BEFORE dayStart — seeds prevAmps so an overnight charge crossing
//     midnight isn't miscounted as a fresh adjustment. Its interval is not
//     counted; it belongs to the previous day.
//   * the first sample AT/AFTER dayEnd — closes the day's final interval.
// Each interval is valued by its LEFT sample and attributed to that sample's
// day, matching integrate(), so a week folded from days equals the same week
// integrated whole.
export function computeDayRollup(rows, dayStart, dayEnd) {
  const out = {
    day_ts: dayStart,
    samples: 0,
    car_wh: 0, car_solar_wh: 0, car_grid_wh: 0,
    peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0,
    solar2_wh: 0, solax_wh: 0, export_wh: 0, import_wh: 0, used_wh: 0,
  };
  let prevAmps = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const inDay = r.ts >= dayStart && r.ts < dayEnd;

    // prevAmps tracks across the boundary; only in-day changes are counted.
    if (r.charging) {
      if (inDay && prevAmps != null && r.charge_amps != null && r.charge_amps !== prevAmps) out.adjustments++;
      prevAmps = r.charge_amps;
    }
    if (!inDay) continue;

    out.samples++;
    if ((r.charge_w || 0) > out.peak_w) out.peak_w = r.charge_w;
    if ((r.charge_amps || 0) > out.peak_amps) out.peak_amps = r.charge_amps;
    if (r.charging) out.charging_samples++;

    const next = rows[i + 1];
    if (!next) continue;
    const dtH = (next.ts - r.ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue; // skip gaps

    const cw = Math.max(0, r.charge_w || 0);
    out.car_wh += cw * dtH;
    if (cw > 0) {
      const gridShare = (r.import_w || 0) > 0 ? Math.min(r.import_w, cw) : 0;
      out.car_grid_wh += gridShare * dtH;
      out.car_solar_wh += (cw - gridShare) * dtH;
    }
    const growatt = -Math.min(0, r.solar2_w || 0); // generation reads negative
    const solax = Math.max(0, r.solax_w || 0);
    out.solar2_wh += growatt * dtH;
    out.solax_wh += solax * dtH;
    out.export_wh += Math.max(0, r.export_w || 0) * dtH;
    out.import_wh += Math.max(0, r.import_w || 0) * dtH;
    out.used_wh += Math.max(0, growatt + solax + (r.grid_power || 0)) * dtH;
  }
  return out;
}

// Next local midnight after `dayStart`. Calendar arithmetic, NOT + 86_400_000:
// a DST fall-back day is 25 hours and a spring-forward day is 23, so a fixed
// 24h step drifts off midnight and mis-keys every following day.
export function nextDayMs(dayStart) {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// A day is complete once the next local midnight has arrived. Only complete
// days may be persisted — freezing a partially-elapsed day would store its
// mid-day totals forever, since rollups are never recomputed.
export function isDayComplete(dayStart, nowMs) {
  return nextDayMs(dayStart) <= nowMs;
}

// Whether a day's rollup is safe to freeze into daily_stats forever. All three
// conditions matter, because a persisted rollup is NEVER recomputed:
//   * complete    — a still-running day would freeze its mid-day totals.
//   * historyStart — the calendar day of the earliest sample ever recorded. A
//     day before this has no data by definition. Persisting a zero row for it
//     is what drags firstRollupDay back arbitrarily — an old `offset` (e.g. a
//     month offset resolving to the 1940s) would otherwise walk and persist
//     every day between it and today, blocking the event loop for minutes.
//   * retentionStart — pruneOld deletes samples older than sampleRetentionDays
//     on a timer that doesn't align to day boundaries, so the day straddling
//     that cutoff has already lost half its samples by the time it's first
//     viewed. Persisting from the surviving half would freeze a wrong total;
//     only persist once the whole day is younger than the retention window.
// Days that fail these checks still COMPUTE a rollup (so totals stay correct)
// — they just aren't written to daily_stats.
export function shouldPersistDay(dayStart, nowMs, historyStart, retentionStart) {
  if (!isDayComplete(dayStart, nowMs)) return false;
  if (historyStart == null || dayStart < historyStart) return false;
  if (retentionStart == null || dayStart < retentionStart) return false;
  return true;
}

// The first day a range walk must visit: the later of the requested `since`
// and `knownStart` (the earliest day we know ANYTHING about — see stats.js's
// knownStartMs). This must NOT be historyStart (earliest surviving sample
// only): a day whose samples were pruned but whose daily_stats row still
// exists is still "known" and must be walked, or its stored rollup silently
// drops out of `all`/`month` once it ages past the sample retention window.
// `until` is the fallback when knownStart is Infinity (empty DB) so the loop
// in rollupRange (`for (d = walkStart; d < until; ...)`) walks zero days
// instead of iterating from -Infinity.
export function walkStartMs(since, until, knownStart) {
  return Math.max(since, knownStart === Infinity ? until : knownStart);
}

// Local midnight on or before `ts`.
export function startOfDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Upper bound on how far back a legitimate daily_stats row can ever predate
// "now" — generously larger than any real deployment's uptime. daily_stats
// rows are NEVER pruned (only `samples` is), so a stray pre-history row
// (restore-from-backup, clock skew before NTP got a lock, a manual insert)
// has no self-healing mechanism: shouldPersistDay correctly refuses to
// (re-)persist days before real history, so no cache ever forms to short-
// circuit the next call — every single `all`/`month` request would re-walk
// tens of thousands of empty days, forever. Flooring knownStart (below) turns
// a corrupt/stray row into a one-time miss instead of a permanent per-request
// tax.
export const MAX_ROLLUP_HISTORY_MS = 1826 /* ~5 years */ * 86_400_000;

// Floors a raw "earliest known day" (stats.js's knownStartMs, before this
// clamp) at MAX_ROLLUP_HISTORY_MS before `nowMs`. Pure so the clamp itself —
// as opposed to knownStartMs's DB reads — can be unit tested without a
// database. Day-aligned (not just ms-clamped): callers loop `d = start; d <
// until; d = nextDayMs(d)`, so a non-midnight start would offset every
// subsequent "day" boundary it walks off of local midnight.
export function floorKnownStart(rawStart, nowMs) {
  if (rawStart === Infinity) return Infinity;
  return Math.max(rawStart, startOfDayMs(nowMs - MAX_ROLLUP_HISTORY_MS));
}

// Combine day rollups into one range total. Peaks take a max; everything else
// sums. Ratios (solarPct) and chargingMinutes are derived by the caller from
// the summed parts — never averaged across days.
export function foldRollups(days) {
  const out = {
    samples: 0,
    car_wh: 0, car_solar_wh: 0, car_grid_wh: 0,
    peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0,
    solar2_wh: 0, solax_wh: 0, export_wh: 0, import_wh: 0, used_wh: 0,
  };
  for (const d of days) {
    out.samples += d.samples;
    out.car_wh += d.car_wh;
    out.car_solar_wh += d.car_solar_wh;
    out.car_grid_wh += d.car_grid_wh;
    out.charging_samples += d.charging_samples;
    out.adjustments += d.adjustments;
    out.solar2_wh += d.solar2_wh;
    out.solax_wh += d.solax_wh;
    out.export_wh += d.export_wh;
    out.import_wh += d.import_wh;
    out.used_wh += d.used_wh;
    out.peak_w = Math.max(out.peak_w, d.peak_w || 0);
    out.peak_amps = Math.max(out.peak_amps, d.peak_amps || 0);
  }
  return out;
}
