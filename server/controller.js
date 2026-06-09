// The brain. Two loops:
//   * live loop  (livePollSec, ~2s): reads the Shelly meters, recomputes the
//     surplus/target using the last known car state, updates `state`, and emits
//     a 'update' event so the dashboard can stream in real time. No Tesla calls.
//   * control loop (pollIntervalSec, ~10s): reads the car, makes the charging
//     decision, sends commands, and persists a sample to SQLite.
//
// Surplus math (single-phase, voltage read live). The car's draw is already inside
// the grid meter, so to find the total power we could feed the car while keeping
// an export buffer:
//   exportW  = max(0, -gridPower)
//   surplusW = exportW + chargeW - buffer
//   amps     = clamp(floor(surplusW / voltage), minAmps, ampCeiling)
import { EventEmitter } from 'node:events';
import config from './config.js';
import * as shelly from './shelly.js';
import tesla, { teslaConfigured } from './tesla.js';
import * as wallconnector from './wallconnector.js';
import * as solax from './solax.js';
import * as db from './db.js';

const C = config.control;

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const state = {
  mode: 'auto', // 'auto' | 'pause'
  override: null, // { amps, expiresAt }
  lastCycleAt: 0, // last control-loop tick
  liveAt: 0, // last live-loop tick
  lastAction: 'starting',
  lastError: null,
  meters: null,
  car: null,
  wc: null, // wall connector vitals
  solax: null, // SolaX cloud generation (solarPanel1)
  computed: null,
  charging: false,
  teslaConfigured: teslaConfigured(),
  dryRun: C.dryRun,
};

let session = null;
let lastSetAmps = null;
let timers = [];

export function getState() {
  return { ...state, ts: Date.now() };
}
function emit() {
  bus.emit('update', getState());
}

export function setMode(mode) {
  if (mode !== 'auto' && mode !== 'pause') throw new Error('mode must be auto|pause');
  state.mode = mode;
  if (mode === 'auto') state.override = null;
  emit();
  return state.mode;
}
export function setOverride(amps, expiresInMin) {
  const a = clamp(Math.round(amps), C.minAmps, C.maxAmps);
  state.override = { amps: a, expiresAt: expiresInMin ? Date.now() + expiresInMin * 60_000 : null };
  state.mode = 'auto';
  emit();
  return state.override;
}
export function clearOverride() {
  state.override = null;
  emit();
}
export async function manualCharge(action) {
  if (action === 'start') return tesla.chargeStart();
  if (action === 'stop') return tesla.chargeStop();
  throw new Error('action must be start|stop');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Pure computation shared by both loops. The Wall Connector (wc) is the preferred
// source for actual current / voltage / charging+plugged state when available.
function computeDecision(meters, car, wc) {
  const wcOk = wc && !wc.error;
  const isCharging = wcOk ? wc.charging : car?.chargingState === 'Charging';
  const connected = wcOk ? wc.connected : !!car?.pluggedIn;
  const voltage = pickVoltage(meters, car, wc);
  const actualAmps = (wcOk ? wc.currentA : car?.chargerActualCurrent) ?? null;
  const chargeW = wcOk && wc.power != null ? wc.power : computeChargeW(car, voltage);
  const commandedAmps = car?.chargeAmps ?? lastSetAmps ?? null;
  const surplusW = meters.exportW + (isCharging ? chargeW : 0) - C.bufferWatts;
  const carMax = car?.chargeCurrentRequestMax;
  const ampCeiling = carMax && carMax > 0 ? Math.min(C.maxAmps, carMax) : C.maxAmps;
  const targetAmps = clamp(Math.floor(surplusW / voltage), C.minAmps, ampCeiling);
  const throttled =
    isCharging && actualAmps != null && commandedAmps != null && commandedAmps - actualAmps >= 2;
  return { voltage, chargeW, isCharging, connected, surplusW, ampCeiling, targetAmps, actualAmps, commandedAmps, throttled };
}

function setComputed(meters, d) {
  state.computed = {
    exportW: meters.exportW,
    importW: meters.importW,
    chargeW: round1(d.chargeW),
    bufferWatts: C.bufferWatts,
    surplusW: round1(d.surplusW),
    rawTargetAmps: d.surplusW / d.voltage,
    targetAmps: d.targetAmps,
    ampCeiling: d.ampCeiling,
    voltage: round1(d.voltage),
    commandedAmps: d.commandedAmps,
    actualAmps: d.actualAmps,
    throttled: d.throttled,
  };
}

// --- Live loop (fast, dashboard) -------------------------------------------

async function liveCycle() {
  const now = Date.now();
  try {
    const [meters, wc] = await Promise.all([shelly.readMeters(), wallconnector.readVitals()]);
    state.meters = meters;
    state.wc = wc;
    state.solax = solax.getCached(); // cached; refreshes itself at most once per pollSec
    if (state.lastError && state.lastError.startsWith('shelly')) state.lastError = null;
    const d = computeDecision(meters, state.car, wc);
    state.charging = d.isCharging;
    setComputed(meters, d);
    state.liveAt = now;
    emit();
  } catch (err) {
    state.lastError = `shelly: ${err.message}`;
    emit();
  }
}

// --- Control loop (slow, Tesla) --------------------------------------------

async function controlCycle() {
  const now = Date.now();
  state.lastCycleAt = now;

  // Refresh car.
  let car = state.car;
  if (state.teslaConfigured) {
    try {
      car = await tesla.getVehicleData();
      state.car = car;
      if (state.lastError && state.lastError.startsWith('tesla')) state.lastError = null;
    } catch (err) {
      state.lastError = `tesla: ${err.message}`;
      state.car = state.car ? { ...state.car, stale: true } : null;
      car = state.car;
    }
  }

  const meters = state.meters;
  if (!meters) {
    state.lastAction = 'waiting for meters';
    return;
  }

  const wc = state.wc;
  const d = computeDecision(meters, car, wc);
  state.charging = d.isCharging;
  setComputed(meters, d);

  if (state.override?.expiresAt && now > state.override.expiresAt) state.override = null;

  let action = 'monitor';
  let appliedAmps = car?.chargeAmps ?? lastSetAmps ?? null;

  if (state.mode === 'pause') {
    action = 'paused';
  } else if (!state.teslaConfigured) {
    action = 'tesla not configured';
  } else if (!d.connected) {
    action = 'not plugged in';
  } else {
    const desired = state.override ? state.override.amps : d.targetAmps;
    const haveSurplusToStart = d.surplusW >= C.minAmps * d.voltage - C.resumeMarginWatts;

    if (!state.override && C.stopWhenInsufficient && !haveSurplusToStart) {
      if (d.isCharging) action = await safeCmd('stop charge (insufficient surplus)', () => tesla.chargeStop());
      else action = 'idle (insufficient surplus)';
    } else {
      if (!d.isCharging && (state.override || haveSurplusToStart)) {
        await safeCmd('start charge', () => tesla.chargeStart());
      }
      const current = car?.chargeAmps ?? lastSetAmps;
      if (current == null || Math.abs(desired - current) >= C.minAmpStepChange || state.override) {
        action = await safeCmd(`set ${desired}A`, () => tesla.setChargingAmps(desired));
        appliedAmps = desired;
        lastSetAmps = desired;
        bumpAdjustments();
      } else {
        action = `hold ${current}A`;
        appliedAmps = current;
      }
    }
  }

  state.lastAction = action;
  trackSession(now, d.isCharging, d.chargeW, appliedAmps, meters);

  db.recordSample({
    ts: now,
    gridPower: meters.gridPower,
    exportW: meters.exportW,
    importW: meters.importW,
    solarPanels2: meters.solarPanels2,
    floor1W: meters.channels.floor1?.power ?? null,
    floor2W: meters.channels.floor2?.power ?? null,
    voltage: d.voltage,
    charging: d.isCharging,
    chargeAmps: appliedAmps,
    targetAmps: d.targetAmps,
    chargeW: d.chargeW,
    mode: state.override ? 'override' : state.mode,
    action,
  });
  emit();
}

// --- Helpers ---------------------------------------------------------------

function sane(v) {
  return v != null && v >= 180 && v <= 270 ? v : null;
}
function pickVoltage(meters, car, wc) {
  const wcV = wc && !wc.error && wc.charging ? sane(wc.voltage) : null;
  const carV = car?.chargingState === 'Charging' ? sane(car?.chargerVoltage) : null;
  return wcV ?? carV ?? sane(meters.voltage) ?? C.voltage;
}
function computeChargeW(car, voltage) {
  if (!car) return 0;
  if (car.chargerActualCurrent && car.chargerVoltage) return car.chargerActualCurrent * car.chargerVoltage;
  if (car.chargerPower) return car.chargerPower * 1000;
  if (car.chargeAmps) return car.chargeAmps * voltage;
  return 0;
}

function trackSession(now, isCharging, chargeW, amps, meters) {
  if (isCharging) {
    if (!session) session = db.startSession(now);
    const dtH = session._lastTs ? (now - session._lastTs) / 3_600_000 : 0;
    session._lastTs = now;
    if (dtH > 0 && dtH < 0.5) {
      session.energy_wh = (session.energy_wh || 0) + chargeW * dtH;
      const gridShare = meters.importW > 0 ? Math.min(meters.importW, chargeW) : 0;
      session.solar_wh = (session.solar_wh || 0) + Math.max(0, chargeW - gridShare) * dtH;
      session.grid_wh = (session.grid_wh || 0) + gridShare * dtH;
    }
    session.peak_w = Math.max(session.peak_w || 0, chargeW);
    session.peak_amps = Math.max(session.peak_amps || 0, amps || 0);
    db.updateSession(session);
  } else if (session) {
    db.updateSession(session);
    db.endSession(now);
    session = null;
  }
}
function bumpAdjustments() {
  if (session) session.adjustments = (session.adjustments || 0) + 1;
}
async function safeCmd(label, fn) {
  try {
    const r = await fn();
    return r?.dryRun ? `[dry-run] ${label}` : label;
  } catch (err) {
    state.lastError = `cmd ${label}: ${err.message}`;
    return `failed: ${label}`;
  }
}

export function start() {
  if (timers.length) return;
  const live = () => liveCycle().catch((e) => { state.lastError = String(e.message || e); });
  const ctrl = () => controlCycle().catch((e) => { state.lastError = String(e.message || e); });
  live();
  setTimeout(ctrl, 1000); // let meters populate first
  timers.push(setInterval(live, (C.livePollSec || 2) * 1000));
  timers.push(setInterval(ctrl, C.pollIntervalSec * 1000));
  timers.push(setInterval(() => db.pruneOld(), 86_400_000));
  timers.forEach((t) => t.unref?.());
}
export function stop() {
  timers.forEach(clearInterval);
  timers = [];
}

function round1(n) {
  return n == null ? n : Math.round(n * 10) / 10;
}

export default { start, stop, getState, setMode, setOverride, clearOverride, manualCharge, bus, state };
