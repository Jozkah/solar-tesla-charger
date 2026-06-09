// Tesla integration with a switchable backend:
//
//   backend = "teslamateapi" (default, recommended)
//     Talks to a local TeslaMateApi (https://github.com/tobiasehlert/teslamateapi)
//     over plain LAN HTTP. It reuses TeslaMate's stored tokens AND TeslaMate's
//     configured command host — so if TeslaMate is wired to the Fleet API proxy,
//     set_charging_amps is signed for us automatically. No tokens/keys here.
//
//   backend = "proxy"
//     Direct Fleet API: reads go to the Fleet API, writes (signed vehicle commands)
//     go through a locally-run tesla-http-proxy. Needs TESLA_* tokens in .env.
import { Agent } from 'undici';
import config, { teslaConfigured } from './config.js';

const t = config.tesla;
const backend = t.backend || 'teslamateapi';

// ===========================================================================
// Shared: normalize a charge_state-ish object into our internal shape.
// ===========================================================================
// TeslaMate stores the state lowercase ("charging"/"stopped"); the Fleet API
// returns it capitalized ("Charging"). Canonicalize so comparisons are stable.
function canonState(s) {
  if (!s) return s;
  const map = { charging: 'Charging', stopped: 'Stopped', complete: 'Complete', disconnected: 'Disconnected', nopower: 'NoPower', starting: 'Starting' };
  return map[String(s).toLowerCase()] || s;
}
function normalize(cs = {}, stateHint) {
  const chargingState = canonState(cs.charging_state || stateHint);
  return {
    online: true,
    chargingState, // "Charging" | "Stopped" | "Complete" | "Disconnected" | "NoPower"
    pluggedIn:
      cs.charge_port_latch === 'Engaged' ||
      cs.plugged_in === true ||
      (chargingState && !['Disconnected', null, undefined].includes(chargingState)),
    chargeAmps: num(cs.charge_amps ?? cs.charge_current_request),
    chargerActualCurrent: num(cs.charger_actual_current),
    chargeCurrentRequest: num(cs.charge_current_request),
    chargeCurrentRequestMax: num(cs.charge_current_request_max),
    chargerVoltage: num(cs.charger_voltage),
    chargerPower: num(cs.charger_power), // kW
    batteryLevel: num(cs.battery_level ?? cs.usable_battery_level),
    chargeLimitSoc: num(cs.charge_limit_soc),
    timeToFullCharge: num(cs.time_to_full_charge),
    raw: cs,
  };
}

// ===========================================================================
// Backend: TeslaMateApi
// ===========================================================================
const tma = t.teslamateapi || {};
function tmaHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (tma.token) h.Authorization = `Bearer ${tma.token}`;
  return h;
}
function tmaUrl(suffix) {
  // Tolerate a base url that already includes a trailing "/api" or slash; the
  // standard TeslaMateApi routes live under /api/v1/...
  const base = tma.baseUrl.replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${base}/api/v1/cars/${tma.carId}${suffix}`;
}

async function tmaGetVehicleData() {
  const res = await fetch(tmaUrl('/status'), { headers: tmaHeaders() });
  if (!res.ok) throw new Error(`TeslaMateApi /status HTTP ${res.status} ${await safeText(res)}`);
  const json = await res.json();
  const status = json?.data?.status || json?.data || json || {};
  const charging = status.charging_details || {};
  const battery = status.battery_details || {};
  // TeslaMateApi reports car state as e.g. "charging"/"online"/"asleep".
  const stateHint = mapTmaState(status.state);
  return normalize(
    {
      charging_state: charging.charging_state, // may be undefined -> stateHint used
      charge_amps: charging.charge_amps,
      charger_actual_current: charging.charger_actual_current,
      charge_current_request: charging.charge_current_request,
      charge_current_request_max: charging.charge_current_request_max,
      charger_voltage: charging.charger_voltage,
      charger_power: charging.charger_power,
      plugged_in: charging.plugged_in,
      battery_level: battery.battery_level,
      usable_battery_level: battery.usable_battery_level,
      charge_limit_soc: charging.charge_limit_soc,
      time_to_full_charge: charging.time_to_full_charge,
    },
    stateHint
  );
}

function mapTmaState(s) {
  if (!s) return undefined;
  const v = String(s).toLowerCase();
  if (v === 'charging') return 'Charging';
  if (v === 'asleep' || v === 'offline' || v === 'suspended') return undefined;
  return undefined; // online/driving/etc. -> let charging_details decide pluggedIn
}

async function tmaCommand(command, body) {
  if (config.control.dryRun) return { dryRun: true, command, payload: body };
  const res = await fetch(tmaUrl(`/command/${command}`), {
    method: 'POST',
    headers: tmaHeaders(),
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`TeslaMateApi ${command} HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function tmaWake() {
  return tmaCommand('wake_up', {});
}

// ===========================================================================
// Backend: official Fleet API + tesla-http-proxy
// ===========================================================================
const proxyAgent = new Agent({
  connect: { rejectUnauthorized: t.rejectUnauthorized === false ? false : true },
});
let accessToken = null;
let accessTokenExp = 0;

async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExp - 60_000) return accessToken;
  if (!t.refreshToken || !t.clientId) throw new Error('Tesla proxy backend not configured (missing token/client id).');
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken });
  const res = await fetch(t.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status} ${await safeText(res)}`);
  const json = await res.json();
  accessToken = json.access_token;
  accessTokenExp = now + (json.expires_in || 28800) * 1000;
  return accessToken;
}
async function proxyHeaders() {
  return { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' };
}
async function proxyGetVehicleData() {
  const url = `${t.fleetBase}/api/1/vehicles/${t.vin}/vehicle_data?endpoints=${encodeURIComponent('charge_state')}`;
  let res = await fetch(url, { headers: await proxyHeaders() });
  if (res.status === 408 && t.wakeIfAsleep) {
    await proxyWake();
    await sleep(8000);
    res = await fetch(url, { headers: await proxyHeaders() });
  }
  if (!res.ok) {
    const err = new Error(`vehicle_data HTTP ${res.status} ${await safeText(res)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return normalize(json?.response?.charge_state || {});
}
async function proxyCommand(command, payload) {
  if (config.control.dryRun) return { dryRun: true, command, payload };
  const url = `${t.proxyBaseUrl}/api/1/vehicles/${t.vin}/command/${command}`;
  let lastErr;
  for (let attempt = 0; attempt <= (t.commandRetries ?? 1); attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: await proxyHeaders(), body: JSON.stringify(payload || {}), dispatcher: proxyAgent });
      const json = await res.json().catch(() => ({}));
      if (res.status === 408 && t.wakeIfAsleep) { await proxyWake(); await sleep(8000); continue; }
      if (!res.ok || json?.response?.result === false) throw new Error(`${command} HTTP ${res.status} ${JSON.stringify(json)}`);
      return json;
    } catch (err) { lastErr = err; await sleep(1500); }
  }
  throw lastErr;
}
async function proxyWake() {
  if (config.control.dryRun) return { dryRun: true, command: 'wake_up' };
  const res = await fetch(`${t.proxyBaseUrl}/api/1/vehicles/${t.vin}/wake_up`, { method: 'POST', headers: await proxyHeaders(), dispatcher: proxyAgent });
  return res.json().catch(() => ({}));
}

// ===========================================================================
// Public API (dispatches to the selected backend)
// ===========================================================================
export async function getVehicleData() {
  return backend === 'proxy' ? proxyGetVehicleData() : tmaGetVehicleData();
}
export async function setChargingAmps(amps) {
  const a = Math.round(amps);
  return backend === 'proxy' ? proxyCommand('set_charging_amps', { charging_amps: a }) : tmaCommand('set_charging_amps', { charging_amps: a });
}
export async function chargeStart() {
  return backend === 'proxy' ? proxyCommand('charge_start', {}) : tmaCommand('charge_start', {});
}
export async function chargeStop() {
  return backend === 'proxy' ? proxyCommand('charge_stop', {}) : tmaCommand('charge_stop', {});
}
export async function wake() {
  return backend === 'proxy' ? proxyWake() : tmaWake();
}

export { teslaConfigured };

function num(n) {
  return n == null || n === '' || Number.isNaN(Number(n)) ? undefined : Number(n);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }

export default { getVehicleData, setChargingAmps, chargeStart, chargeStop, wake, teslaConfigured };
