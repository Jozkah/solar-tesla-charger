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
import * as teslaAuth from './teslaAuth.js';

const t = config.tesla;
const backend = t.backend || 'teslamateapi';
const cmdBackend = t.commandBackend || backend; // backend used for write commands

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
  const climate = status.climate_details || {};
  const geo = status.car_geodata || {};
  // TeslaMateApi reports car state as e.g. "charging"/"online"/"asleep".
  const stateHint = mapTmaState(status.state);
  const base = normalize(
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
  // Extras (TeslaMateApi only) — temps, location, charge details.
  base.outsideTemp = num(climate.outside_temp);
  base.insideTemp = num(climate.inside_temp);
  base.climateOn = !!climate.is_climate_on;
  base.preconditioning = !!climate.is_preconditioning;
  base.chargeEnergyAdded = num(charging.charge_energy_added);
  base.chargePortOpen = !!charging.charge_port_door_open;
  base.estRangeKm = num(battery.est_battery_range);
  base.ratedRangeKm = num(battery.rated_battery_range);
  base.odometer = num(status.odometer);
  base.chargeRateKmh = num(charging.charge_rate);
  const lat = num(geo.latitude), lon = num(geo.longitude);
  base.location = lat != null && lon != null ? { lat, lon } : null;
  const tp = status.tpms_details || {};
  if (tp.tpms_pressure_fl != null) {
    base.tpms = { fl: num(tp.tpms_pressure_fl), fr: num(tp.tpms_pressure_fr), rl: num(tp.tpms_pressure_rl), rr: num(tp.tpms_pressure_rr) };
  }
  return base;
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
// Access tokens come from the OAuth third-party-token manager (teslaAuth.js).
async function getAccessToken() {
  return teslaAuth.getAccessToken();
}
async function proxyHeaders() {
  return { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' };
}
async function proxyVehicleDataRaw(endpoints) {
  const url = `${t.fleetBase}/api/1/vehicles/${t.vin}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`;
  let res = await fetch(url, { headers: await proxyHeaders() });
  if (res.status === 408 && t.wakeIfAsleep) {
    await fleetWake();
    await sleep(8000);
    res = await fetch(url, { headers: await proxyHeaders() });
  }
  return res;
}
async function proxyGetVehicleData() {
  // Prefer including location (needs vehicle_location scope); fall back gracefully
  // if the token doesn't have it yet, so reads keep working pre-re-auth.
  let res = await proxyVehicleDataRaw('charge_state;climate_state;location_data');
  if (res.status === 403 && /scope/i.test(await peek(res))) {
    res = await proxyVehicleDataRaw('charge_state;climate_state');
  }
  if (!res.ok) {
    const err = new Error(`vehicle_data HTTP ${res.status} ${await safeText(res)}`);
    err.status = res.status;
    throw err;
  }
  const resp = (await res.json())?.response || {};
  const cs = resp.charge_state || {};
  const cl = resp.climate_state || {};
  const ds = resp.drive_state || {};
  const base = normalize(cs);
  base.outsideTemp = num(cl.outside_temp);
  base.insideTemp = num(cl.inside_temp);
  base.climateOn = !!cl.is_climate_on;
  base.preconditioning = !!cl.is_preconditioning;
  base.chargeEnergyAdded = num(cs.charge_energy_added);
  base.chargePortOpen = cs.charge_port_door_open === true;
  base.estRangeKm = mi2km(num(cs.est_battery_range) ?? num(cs.ideal_battery_range) ?? num(cs.battery_range));
  base.ratedRangeKm = mi2km(num(cs.battery_range));
  const lat = num(ds.latitude), lon = num(ds.longitude);
  base.location = lat != null && lon != null ? { lat, lon } : null;
  return base;
}
function mi2km(mi) { return mi == null ? null : Math.round(mi * 1.60934 * 10) / 10; }
async function peek(res) { try { return await res.clone().text(); } catch { return ''; } }

// Tesla returns result:false with a harmless reason for idempotent no-ops — e.g.
// charge_start while the car is already charging, or charge_stop while already
// stopped. Treat those as success so they don't surface as command errors.
const BENIGN_CMD_REASONS = new Set(['is_charging', 'not_charging', 'complete', 'already_set']);
function commandFailed(res, json) {
  if (!res.ok) return true;
  if (json?.response?.result === false) {
    return !BENIGN_CMD_REASONS.has(String(json.response.reason || '').toLowerCase());
  }
  return false;
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
      if (commandFailed(res, json)) throw new Error(`${command} HTTP ${res.status} ${JSON.stringify(json)}`);
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
// Backend: direct Fleet API commands (OAuth token; app key already paired with
// the vehicle — no local signing proxy needed).
// ===========================================================================
async function fleetCommand(command, payload) {
  if (config.control.dryRun) return { dryRun: true, command, payload };
  const url = `${t.fleetBase}/api/1/vehicles/${t.vin}/command/${command}`;
  let lastErr;
  for (let attempt = 0; attempt <= (t.commandRetries ?? 1); attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: await proxyHeaders(), body: JSON.stringify(payload || {}) });
      const json = await res.json().catch(() => ({}));
      if (res.status === 408 && t.wakeIfAsleep) { await fleetWake(); await sleep(8000); continue; }
      if (commandFailed(res, json)) {
        throw new Error(`${command} HTTP ${res.status} ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) { lastErr = err; await sleep(1500); }
  }
  throw lastErr;
}
async function fleetWake() {
  if (config.control.dryRun) return { dryRun: true, command: 'wake_up' };
  const res = await fetch(`${t.fleetBase}/api/1/vehicles/${t.vin}/wake_up`, { method: 'POST', headers: await proxyHeaders() });
  return res.json().catch(() => ({}));
}

// Dispatch a write command to the selected command backend.
function dispatchCommand(command, payload) {
  if (cmdBackend === 'fleet') return fleetCommand(command, payload);
  if (cmdBackend === 'proxy') return proxyCommand(command, payload);
  return tmaCommand(command, payload);
}

// ===========================================================================
// Public API (dispatches to the selected backend)
// ===========================================================================
export async function getVehicleData() {
  return backend === 'proxy' ? proxyGetVehicleData() : tmaGetVehicleData();
}
export async function setChargingAmps(amps) {
  return dispatchCommand('set_charging_amps', { charging_amps: Math.round(amps) });
}
export async function setChargeLimit(percent) {
  // Tesla allows a SoC limit of 50–100%. Fleet/proxy take { percent };
  // TeslaMateApi's set_charge_limit takes { charge_limit_soc }.
  const p = Math.max(50, Math.min(100, Math.round(percent)));
  const payload = cmdBackend === 'fleet' || cmdBackend === 'proxy' ? { percent: p } : { charge_limit_soc: p };
  return dispatchCommand('set_charge_limit', payload);
}
export async function chargeStart() {
  return dispatchCommand('charge_start', {});
}
export async function chargeStop() {
  return dispatchCommand('charge_stop', {});
}
export async function wake() {
  if (cmdBackend === 'fleet') return fleetWake();
  if (cmdBackend === 'proxy') return proxyWake();
  return tmaWake();
}

export { teslaConfigured };

function num(n) {
  return n == null || n === '' || Number.isNaN(Number(n)) ? undefined : Number(n);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }

export default { getVehicleData, setChargingAmps, setChargeLimit, chargeStart, chargeStop, wake, teslaConfigured };
