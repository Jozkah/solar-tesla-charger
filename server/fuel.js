// Portuguese 98 petrol price from DGEG (precoscombustiveis.dgeg.gov.pt), for the
// charger page's "cost vs petrol" comparison.
//
// DGEG serves a broken TLS chain, so the fetch goes through an undici Agent with
// certificate verification disabled — scoped to this module / that host only.
// One national average (all 18 districts) refreshed ~daily; the constant
// fallback keeps the UI working if DGEG is unreachable.
import { request, Agent } from 'undici';
import config from './config.js';

const fuelCfg = config.fuel;
const DAY_MS = 86_400_000;
const REFRESH_MS = DAY_MS;
const DISTRICT_IDS = Array.from({ length: 18 }, (_, i) => i + 1); // DGEG idDistrito 1..18
const ENDPOINT = 'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos';

// DGEG's cert doesn't validate; accept it for this host only.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

// --- Pure core (unit-tested) ----------------------------------------------

// Parse a DGEG price string ("2,201 €/litro", mojibake "2,201 �", "1,899 €")
// to a number. Returns null when there's no usable value.
export function parsePrice(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^0-9.,]/g, '').replace(',', '.');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Average `type` fuel price across DGEG rows. Returns { price, n, date } or null.
// date = most recent DataAtualizacao among matched rows (YYYY-MM-DD).
export function averageType(rows, type) {
  let sum = 0;
  let n = 0;
  let latest = '';
  for (const r of rows || []) {
    if (r?.Combustivel !== type) continue;
    const p = parsePrice(r.Preco);
    if (p == null) continue;
    sum += p;
    n += 1;
    const d = String(r.DataAtualizacao || '').slice(0, 10);
    if (d > latest) latest = d;
  }
  if (n === 0) return null;
  return { price: sum / n, n, date: latest || null };
}

// --- Fetch + cache ---------------------------------------------------------

async function fetchDistrict(id) {
  const url = `${ENDPOINT}?idDistrito=${id}&qtdPorPagina=99999&pagina=1`;
  const res = await request(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    dispatcher: insecureAgent,
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  });
  if (res.statusCode !== 200) throw new Error(`DGEG HTTP ${res.statusCode}`);
  const json = await res.body.json();
  return json?.resultado || [];
}

// Which districts to sample: 'national' → all 18; a numeric id → just that one.
function scopeDistricts() {
  const s = fuelCfg.scope;
  if (s && s !== 'national') {
    const id = Number(s);
    if (Number.isInteger(id) && id >= 1 && id <= 18) return [id];
  }
  return DISTRICT_IDS;
}

async function computePrice() {
  const ids = scopeDistricts();
  const rows = [];
  // Sequential: 18 large payloads once a day — kind to the DGEG endpoint and to
  // memory (one district's ~0.6 MB at a time).
  for (const id of ids) {
    try {
      rows.push(...(await fetchDistrict(id)));
    } catch {
      // Skip a failed district; a partial national average is still useful.
    }
  }
  return averageType(rows, fuelCfg.type);
}

let cache = { price: fuelCfg.fallbackEurL, date: null, stale: true, at: 0 };
let inflight = null;

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const avg = await computePrice();
      if (avg && avg.price > 0) cache = { price: avg.price, date: avg.date, stale: false, at: Date.now() };
    } catch {
      // keep whatever we had (fallback or last good)
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

// Public: current price snapshot. Triggers a background refresh when stale but
// returns immediately with the cached/fallback value (never blocks the request).
// Lazy by design: the first /api/fuel request warms it (no network at import, so
// importing this module in tests never touches DGEG).
export function getPrice() {
  const now = Date.now();
  if (cache.stale || now - cache.at >= REFRESH_MS) refresh();
  return { price: cache.price, currency: 'EUR', date: cache.date, stale: cache.stale, scope: fuelCfg.scope };
}
