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
