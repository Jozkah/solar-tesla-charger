// SolaX Cloud client — reads the SolaX inverter's live generation (solarPanel1).
// POST {apiUrl}/api/v2/dataAccess/realtimeInfo/get  header tokenId  body {wifiSn}
// Returns acpower (W AC output), yieldtoday/total (kWh), inverter status.
//
// SolaX Cloud only refreshes ~every 5 min and rate-limits, so we cache and refresh
// at most once per pollSec; getCached() never blocks the control loop.
import config from './config.js';

const S = config.solax || {};
let cache = null;
let lastFetch = 0;
let inflight = false;

export function enabled() {
  return Boolean(S.enabled && S.tokenId && S.wifiSn);
}

async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch(`${S.apiUrl.replace(/\/$/, '')}/api/v2/dataAccess/realtimeInfo/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', tokenId: S.tokenId },
      body: JSON.stringify({ wifiSn: S.wifiSn }),
      signal: AbortSignal.timeout(S.timeoutMs || 8000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.exception || `code ${json.code}`);
    const r = json.result || {};
    cache = {
      ok: true,
      acpower: num(r.acpower), // live AC generation (W)
      yieldToday: num(r.yieldtoday), // kWh
      yieldTotal: num(r.yieldtotal), // kWh
      pv1: num(r.powerdc1),
      pv2: num(r.powerdc2),
      status: r.inverterStatus,
      uploadTime: r.uploadTime,
      ts: Date.now(),
    };
  } catch (e) {
    cache = { ...(cache || {}), ok: false, error: String(e.message || e), ts: Date.now() };
  } finally {
    inflight = false;
    lastFetch = Date.now();
  }
}

// Returns the cached reading immediately; triggers a background refresh when stale.
export function getCached() {
  if (!enabled()) return null;
  if (Date.now() - lastFetch > (S.pollSec || 60) * 1000) refresh();
  return cache;
}

function num(n) {
  return n == null || n === '' || Number.isNaN(Number(n)) ? null : Number(n);
}

export default { enabled, getCached };
