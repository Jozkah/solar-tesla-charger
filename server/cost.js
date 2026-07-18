// Pure tariff / cost logic (no DB). Grid-import-only, simplified time-of-use.

export const DEFAULT_TARIFF = {
  currency: '€',
  bands: [
    { name: 'peak', rate: 0.20, windows: [[8, 22]] },
    { name: 'mid', rate: 0.15, windows: [] },
    { name: 'offpeak', rate: 0.10, windows: [[0, 8], [22, 24]] },
  ],
  dailyFixed: 0.50,
  perKwhLevy: 0.001,
  fixedMonthly: 1.00,
  vatPct: 23,
};

function invalid(msg) {
  const e = new Error(msg);
  e.code = 'INVALID_TARIFF';
  throw e;
}

export function validateTariff(t) {
  if (!t || typeof t !== 'object') invalid('tariff must be an object');
  if (typeof t.currency !== 'string' || !t.currency.trim() || t.currency.length > 8) {
    invalid('currency must be a non-empty string up to 8 chars');
  }
  if (!Array.isArray(t.bands) || t.bands.length < 1 || t.bands.length > 3) {
    invalid('tariff needs 1–3 bands');
  }
  for (const b of t.bands) {
    if (!b || typeof b.name !== 'string' || !b.name.trim()) invalid('each band needs a name');
    if (!Number.isFinite(b.rate) || b.rate < 0) invalid('band rate must be a number ≥ 0');
    if (!Array.isArray(b.windows)) invalid('band windows must be an array');
    for (const w of b.windows) {
      if (!Array.isArray(w) || w.length !== 2) invalid('each window must be [start, end]');
      const [s, e] = w;
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) {
        invalid('window hours must be integers with 0 ≤ start < end ≤ 24');
      }
    }
  }
  for (const k of ['dailyFixed', 'perKwhLevy', 'fixedMonthly']) {
    if (!Number.isFinite(t[k]) || t[k] < 0) invalid(`${k} must be a number ≥ 0`);
  }
  if (!Number.isFinite(t.vatPct) || t.vatPct < 0 || t.vatPct > 100) invalid('vatPct must be 0–100');
  return t;
}

// hour (0-23) -> band index. Later bands overwrite on overlap; uncovered -> band 0.
export function hourBandMap(bands) {
  const map = new Int8Array(24); // zero-filled => default band 0
  bands.forEach((b, idx) => {
    for (const [s, e] of (b.windows || [])) {
      for (let h = s; h < e && h < 24; h++) if (h >= 0) map[h] = idx;
    }
  });
  return map;
}

// Integrate positive grid import (W) over time-ordered samples -> kWh per band.
// Same gap-skip rule as stats.integrate (dt > 0.5h treated as a gap).
export function importKwhByBand(rows, map, bandCount) {
  const wh = new Array(bandCount).fill(0);
  for (let i = 1; i < rows.length; i++) {
    const dtMs = rows[i].ts - rows[i - 1].ts;
    const dtH = dtMs / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const imp = Math.max(0, rows[i - 1].import_w || 0);
    if (imp <= 0) continue;
    const midHour = new Date(rows[i - 1].ts + dtMs / 2).getHours();
    wh[map[midHour]] += imp * dtH;
  }
  return wh.map((x) => x / 1000);
}

// Fold a per-hour Wh histogram (24 entries) into per-band kWh using an
// hour->band map. Rollup-architecture counterpart of importKwhByBand: bands are
// applied at READ time over stored per-hour energy, so editing a tariff's band
// windows re-buckets historical hours without any sample re-integration.
export function foldHoursToBands(hourWh, map, bandCount) {
  const out = new Array(bandCount).fill(0);
  for (let h = 0; h < 24; h++) out[map[h]] += (hourWh[h] || 0) / 1000;
  return out;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Marginal cost of the grid energy that charged the car: per-band energy rate +
// per-kWh levy, VAT-inclusive. No daily/fixed standing charges (those are not
// caused by the charging), so it reads as "what this charging added to the bill".
export function computeChargeCost({ carGridKwhByBand, tariff }) {
  const bands = tariff.bands.map((b, i) => {
    const kwh = carGridKwhByBand[i] || 0;
    return { name: b.name, rate: b.rate, kwh: round2(kwh), cost: round2(kwh * b.rate) };
  });
  const energyCost = tariff.bands.reduce((a, b, i) => a + (carGridKwhByBand[i] || 0) * b.rate, 0);
  const totalKwh = carGridKwhByBand.reduce((a, b) => a + b, 0);
  const levy = totalKwh * tariff.perKwhLevy;
  const total = (energyCost + levy) * (1 + tariff.vatPct / 100);
  return { currency: tariff.currency, total: round2(total), vatPct: tariff.vatPct, kwh: round2(totalKwh), bands };
}

export function computeCost({ bandKwh, tariff, elapsedDays }) {
  const bands = tariff.bands.map((b, i) => {
    const kwh = bandKwh[i] || 0;
    return { name: b.name, rate: b.rate, kwh: round2(kwh), cost: round2(kwh * b.rate) };
  });
  const energyCost = tariff.bands.reduce((a, b, i) => a + (bandKwh[i] || 0) * b.rate, 0);
  const totalKwh = bandKwh.reduce((a, b) => a + b, 0);
  const levy = totalKwh * tariff.perKwhLevy;
  const daily = elapsedDays * tariff.dailyFixed;
  const preVat = energyCost + levy + daily + tariff.fixedMonthly;
  const total = preVat * (1 + tariff.vatPct / 100);
  return {
    currency: tariff.currency,
    total: round2(total),
    elapsedDays: round2(elapsedDays),
    vatPct: tariff.vatPct,
    bands,
  };
}
