// Average EV efficiency (Wh/km) for the charger page's fuel comparison.
//
// We deliberately do NOT sum per-drive distance to get a "km driven" total —
// TeslaMate does not record every drive, so a distance total undercounts. The
// section instead derives km from charged energy (chargedKwh ÷ avgWhPerKm), and
// this module supplies only that single average.
//
// avgWhPerKm is energy-weighted: Σ energy_consumed_net (kWh) ÷ Σ distance (km).
// Because it's a ratio, missing drives drop out of BOTH sums and don't bias it —
// unlike a raw distance total.
import config from './config.js';

const fuelCfg = config.fuel;
const tma = config.tesla.teslamateapi || {};
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = DAY_MS; // avg efficiency drifts slowly; refresh daily.

// --- Pure core (unit-tested) ----------------------------------------------

// Energy-weighted Wh/km over TeslaMate drive rows. `unitOfLength` is 'km' or
// 'mi' (TeslaMate settings). Skips imprecise / zero-distance / null-energy rows.
// Returns null when no usable drives (caller falls back to the configured Wh/km).
export function computeAvgWhPerKm(drives, unitOfLength = 'km') {
  const miToKm = 1.609344;
  let energyKwh = 0;
  let distanceKm = 0;
  for (const d of drives || []) {
    const od = d?.odometer_details || {};
    if (od.is_sufficiently_precise === false) continue;
    const energy = d?.energy_consumed_net;
    const dist = od.odometer_distance;
    if (energy == null || dist == null) continue;
    if (!(energy > 0) || !(dist > 0)) continue;
    const distKm = unitOfLength === 'mi' ? dist * miToKm : dist;
    energyKwh += energy;
    distanceKm += distKm;
  }
  if (distanceKm <= 0) return null;
  return (energyKwh * 1000) / distanceKm; // Wh/km
}

// --- Fetch + cache ---------------------------------------------------------

function tmaHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (tma.token) h.Authorization = `Bearer ${tma.token}`;
  return h;
}
function tmaUrl(suffix) {
  const base = String(tma.baseUrl || '').replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${base}/api/v1/cars/${tma.carId}${suffix}`;
}

// ISO date (no ms) for the TeslaMate startDate filter.
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

async function fetchRecentDrives() {
  const startDate = isoDay(Date.now() - fuelCfg.avgWindowDays * DAY_MS);
  const all = [];
  let unit = 'km';
  // Paginate defensively (TeslaMateApi caps rows/page); stop when a page is
  // short or we've gathered plenty. Recent drives are enough for an average.
  for (let page = 1; page <= 10; page++) {
    const url = tmaUrl(`/drives?startDate=${encodeURIComponent(startDate)}&page=${page}`);
    const res = await fetch(url, { headers: tmaHeaders() });
    if (!res.ok) throw new Error(`TeslaMateApi /drives HTTP ${res.status}`);
    const json = await res.json();
    const data = json?.data || json || {};
    const drives = data.drives || [];
    unit = data.units?.unit_of_length || unit;
    all.push(...drives);
    if (drives.length < 50) break; // last page
    if (all.length >= 1000) break; // more than enough for an average
  }
  return { drives: all, unit };
}

let cache = null; // { whPerKm, estimated, at }

// Public: cached lifetime average Wh/km. Never throws — on any failure returns
// the configured fallback with estimated:true so the UI still renders.
export async function avgWhPerKm() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return { whPerKm: cache.whPerKm, estimated: cache.estimated };
  try {
    const { drives, unit } = await fetchRecentDrives();
    const wh = computeAvgWhPerKm(drives, unit);
    if (wh && wh > 0) {
      cache = { whPerKm: wh, estimated: false, at: now };
      return { whPerKm: wh, estimated: false };
    }
  } catch {
    // fall through to fallback
  }
  const fallback = { whPerKm: fuelCfg.fallbackWhPerKm, estimated: true, at: now };
  cache = fallback;
  return { whPerKm: fallback.whPerKm, estimated: true };
}
