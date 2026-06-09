// TP-Link smart plugs (local, no cloud round-trip) for the home dashboard.
// Two protocols, chosen per-plug via config `protocol`:
//   * "kasa" (default) — legacy Kasa HS100/HS110/KP115 over port 9999
//     (tplink-smarthome-api). No account needed.
//   * "tapo" — newer Tapo P100/P110/P115 over the KLAP/secure-passthrough
//     protocol (tp-link-tapo-connect). Needs your TP-Link account email/password
//     (TAPO_EMAIL / TAPO_PASSWORD) — used for the LOCAL handshake, not the cloud.
//
// Reads are cached so the live loop (getCached()) never blocks on the network.
import config from './config.js';
import kasaPkg from 'tplink-smarthome-api';
const { Client } = kasaPkg;
import tapoPkg from 'tp-link-tapo-connect';
const { loginDeviceByIp } = tapoPkg;

const K = config.kasa || {};
const plugsCfg = Array.isArray(K.plugs) ? K.plugs : [];
const timeoutMs = K.timeoutMs || 3000;
const tapoTimeoutMs = K.tapoTimeoutMs || 8000;
const TAPO = K.tapo || {}; // { email, password }

let kasaClient = null;
const kasaDevices = new Map(); // ip -> Plug (legacy)
const tapoHandles = new Map(); // key -> logged-in Tapo device handle
let cache = null;
let lastFetch = 0;
let inflight = false;

export function enabled() {
  return Boolean(K.enabled && plugsCfg.length);
}
const protocolOf = (p) => (p.protocol || 'kasa').toLowerCase();
function cfgByKey(key) { return plugsCfg.find((p) => p.key === key) || null; }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

// --- Legacy Kasa (port 9999) ------------------------------------------------
function kasaClientGet() {
  // logLevel 'silent' — we surface per-plug errors in the UI; no console spam.
  if (!kasaClient) kasaClient = new Client({ defaultSendOptions: { timeout: timeoutMs }, logLevel: 'silent' });
  return kasaClient;
}
async function kasaDeviceFor(ip) {
  let d = kasaDevices.get(ip);
  if (!d) { d = await kasaClientGet().getDevice({ host: ip }); kasaDevices.set(ip, d); }
  return d;
}
function normKasaEmeter(r) {
  if (!r) return {};
  const voltage = r.voltage_mv != null ? r.voltage_mv / 1000 : r.voltage ?? null;
  const current = r.current_ma != null ? r.current_ma / 1000 : r.current ?? null;
  const power = r.power_mw != null ? r.power_mw / 1000 : r.power ?? null;
  const totalKwh = r.total_wh != null ? r.total_wh / 1000 : r.total ?? null;
  return { voltage: round1(voltage), current: round2(current), power: round1(power), totalKwh: totalKwh == null ? null : round2(totalKwh) };
}
async function readKasa(p, base) {
  try {
    const dev = await kasaDeviceFor(p.ip);
    const sys = await dev.getSysInfo();
    const on = sys.relay_state === 1 || sys.relay_state === true;
    let energy = {};
    if (dev.supportsEmeter) {
      try { energy = normKasaEmeter(await dev.emeter.getRealtime()); } catch { /* emeter read failed */ }
    }
    return { ...base, on, model: sys.model, ...energy };
  } catch (e) {
    return { ...base, on: null, error: cleanErr(e) };
  }
}

// --- Tapo (KLAP) ------------------------------------------------------------
async function tapoHandleFor(p) {
  let h = tapoHandles.get(p.key);
  if (!h) {
    if (!TAPO.email || !TAPO.password) throw new Error('set TAPO_EMAIL / TAPO_PASSWORD in .env');
    h = await withTimeout(loginDeviceByIp(TAPO.email, TAPO.password, p.ip), tapoTimeoutMs, 'tapo login');
    tapoHandles.set(p.key, h);
  }
  return h;
}
function normTapoEnergy(e) {
  if (!e) return {};
  const power = e.current_power != null ? e.current_power / 1000 : null; // mW -> W
  const todayKwh = e.today_energy != null ? e.today_energy / 1000 : null; // Wh -> kWh
  return { power: round1(power), todayKwh: todayKwh == null ? null : round2(todayKwh) };
}
async function readTapo(p, base) {
  try {
    const h = await tapoHandleFor(p);
    const info = await withTimeout(h.getDeviceInfo(), tapoTimeoutMs, 'tapo info');
    const on = !!info.device_on;
    let energy = {};
    try { energy = normTapoEnergy(await withTimeout(h.getEnergyUsage(), tapoTimeoutMs, 'tapo energy')); }
    catch { /* P100/P105 have no energy meter */ }
    return { ...base, on, model: info.model, ...energy };
  } catch (e) {
    tapoHandles.delete(p.key); // force a fresh login next cycle (sessions expire)
    return { ...base, on: null, error: cleanErr(e) };
  }
}

// --- Shared read/cache ------------------------------------------------------
function readPlug(p) {
  const base = {
    key: p.key, label: p.label || p.key, role: p.role || 'appliance',
    ip: p.ip, controllable: p.controllable !== false, protocol: protocolOf(p),
  };
  return protocolOf(p) === 'tapo' ? readTapo(p, base) : readKasa(p, base);
}

async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const plugs = await Promise.all(plugsCfg.map(readPlug));
    cache = { ok: true, enabled: true, plugs, ts: Date.now() };
  } catch (e) {
    cache = { ...(cache || {}), ok: false, enabled: true, error: String(e.message || e), ts: Date.now() };
  } finally {
    inflight = false;
    lastFetch = Date.now();
  }
}

// Cached read for the live loop; triggers a background refresh when stale.
export function getCached() {
  if (!enabled()) return null;
  if (Date.now() - lastFetch > (K.pollSec || 5) * 1000) refresh();
  return cache;
}
export async function readNow() { await refresh(); return cache; }

export async function setState(key, on) {
  const p = cfgByKey(key);
  if (!p) throw new Error(`unknown plug: ${key}`);
  if (p.controllable === false) throw new Error(`plug ${key} is not controllable`);
  if (protocolOf(p) === 'tapo') {
    try {
      const h = await tapoHandleFor(p);
      await withTimeout(on ? h.turnOn() : h.turnOff(), tapoTimeoutMs, 'tapo switch');
    } catch (e) { tapoHandles.delete(key); throw e; }
  } else {
    const dev = await kasaDeviceFor(p.ip);
    await dev.setPowerState(!!on);
  }
  await refresh(); // so the next /api/state + SSE tick reflects the change
  return cache?.plugs?.find((x) => x.key === key) || null;
}

export function getStatus() {
  if (!enabled()) return { enabled: false };
  const plugs = cache?.plugs || [];
  return { enabled: true, total: plugsCfg.length, online: plugs.filter((x) => !x.error).length, ts: cache?.ts || 0 };
}

function round1(n) { return n == null ? n : Math.round(n * 10) / 10; }
function round2(n) { return n == null ? n : Math.round(n * 100) / 100; }
function cleanErr(e) {
  const msg = String(e?.message || e || '');
  if (/timeout|ETIMEDOUT|EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|closed before/i.test(msg)) return 'offline / unreachable';
  if (/json|unexpected token|handshake|1003|forbidden|credential|password|login/i.test(msg)) return 'login failed — check TAPO_EMAIL / TAPO_PASSWORD';
  return msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
}

export default { enabled, getCached, readNow, setState, getStatus };
