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
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import * as shelly from './shelly.js';
import tesla, { teslaConfigured } from './tesla.js';
import * as wallconnector from './wallconnector.js';
import * as solax from './solax.js';
import * as weather from './weather.js';
import * as notify from './notify.js';
import * as db from './db.js';

const C = config.control;

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const state = {
  mode: 'auto', // 'auto' | 'pause'
  override: null, // { amps, expiresAt }
  schedule: { enabled: false, start: '00:00', end: '07:00', amps: C.maxAmps }, // overnight grid charge
  maxAmps: C.maxAmps, // user-set auto ceiling (5..config.maxAmps)
  lastCycleAt: 0, // last control-loop tick
  liveAt: 0, // last live-loop tick
  lastAction: 'starting',
  lastError: null,
  meters: null,
  car: null,
  wc: null, // wall connector vitals
  solax: null, // SolaX cloud generation (solarPanel1)
  weather: null, // current weather at the car location
  computed: null,
  charging: false,
  teslaConfigured: teslaConfigured(),
  dryRun: C.dryRun,
};

let session = null;
let lastSetAmps = null;
let timers = [];

// Charging start/stop event detection + a small queue the Apple Shortcut drains.
let prevCharging = null;
const eventLog = []; // recent events (for reference)
const pendingNotifications = []; // messages awaiting delivery to the phone

function recordEvent(type, message) {
  const e = { ts: Date.now(), type, message };
  eventLog.push(e);
  if (eventLog.length > 50) eventLog.shift();
  pendingNotifications.push(e);
  if (pendingNotifications.length > 20) pendingNotifications.shift();
  // True push (fire-and-forget) — instant delivery via the configured service.
  notify.send('Solar Charger', message, { tags: type === 'start' ? 'battery' : 'warning' });
}
export function popPending() {
  return pendingNotifications.splice(0).map((e) => e.message);
}
export function recentEvents() {
  return eventLog.slice(-20);
}
function maybeNotify(d) {
  const charging = d.isCharging;
  if (prevCharging === null) { prevCharging = charging; return; } // skip first cycle
  if (charging === prevCharging) return;
  prevCharging = charging;
  if (charging) {
    recordEvent('start', `🔌 Charging started${d.actualAmps ? ` at ${d.actualAmps}A` : ''}`);
  } else if (!d.connected) {
    recordEvent('stop', '🔌 Charger unplugged — charging stopped');
  } else if (state.computed?.insufficientSolar) {
    recordEvent('stop', '⛅ Charging stopped — not enough solar energy');
  } else if (state.mode === 'pause') {
    recordEvent('stop', '⏸ Charging paused');
  } else {
    recordEvent('stop', '■ Charging stopped');
  }
}

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

// --- Overnight / scheduled grid charging ------------------------------------
const SCHEDULE_FILE = path.join(config.paths.root, 'data', 'schedule.json');
(function loadSchedule() {
  try {
    const s = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    if (s && typeof s === 'object') state.schedule = { ...state.schedule, ...s };
  } catch { /* none yet */ }
})();
export function setSchedule(s) {
  const cur = state.schedule;
  state.schedule = {
    enabled: s.enabled != null ? !!s.enabled : cur.enabled,
    start: /^\d{1,2}:\d{2}$/.test(s.start || '') ? s.start : cur.start,
    end: /^\d{1,2}:\d{2}$/.test(s.end || '') ? s.end : cur.end,
    amps: s.amps != null ? clamp(Math.round(s.amps), C.minAmps, C.maxAmps) : cur.amps,
  };
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(state.schedule, null, 2));
  } catch { /* best effort */ }
  emit();
  return state.schedule;
}
function isScheduleActive() {
  const s = state.schedule;
  if (!s || !s.enabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(s.start).split(':').map(Number);
  const [eh, em] = String(s.end).split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end); // handles overnight wrap
}
// Sets the auto ceiling — auto charges between minAmps and this value.
export function setMaxAmps(amps) {
  state.maxAmps = clamp(Math.round(amps), C.minAmps, C.maxAmps);
  emit();
  return state.maxAmps;
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
  let ampCeiling = C.maxAmps;
  if (carMax && carMax > 0) ampCeiling = Math.min(ampCeiling, carMax); // car/circuit limit
  if (state.maxAmps) ampCeiling = Math.min(ampCeiling, state.maxAmps); // user-set auto cap
  const targetAmps = clamp(Math.floor(surplusW / voltage), C.minAmps, ampCeiling);
  // Only a genuine voltage-drop throttle: car pulling materially fewer amps than
  // commanded AND the charging voltage is actually sagging. A healthy ~230V+ with
  // a commanded/actual gap is not a throttle (usually a failed/stale command).
  const throttled =
    isCharging && actualAmps != null && commandedAmps != null &&
    commandedAmps - actualAmps >= 2 && voltage > 0 && voltage < (C.throttleVoltage || 217);
  const enoughToCharge = surplusW >= C.minAmps * voltage - C.resumeMarginWatts;
  return { voltage, chargeW, isCharging, connected, surplusW, ampCeiling, targetAmps, actualAmps, commandedAmps, throttled, enoughToCharge };
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
    minAmps: C.minAmps,
    // Amps the current surplus could sustain (0 if below the minimum to charge).
    potentialAmps: clamp(Math.floor(d.surplusW / d.voltage), 0, d.ampCeiling),
    enoughToCharge: d.enoughToCharge,
    // True when the car is plugged in on auto but charging is held off because
    // the solar surplus can't sustain the minimum amperage.
    insufficientSolar: !!(d.connected && C.stopWhenInsufficient && state.mode === 'auto'
      && !state.override && !isScheduleActive() && !d.enoughToCharge && !d.isCharging),
    scheduleActive: isScheduleActive(),
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
    const loc = state.car?.location;
    state.weather = weather.getCached(loc?.lat, loc?.lon); // cached; refreshes ~every pollMin
    if (state.lastError && state.lastError.startsWith('shelly')) state.lastError = null;
    const d = computeDecision(meters, state.car, wc);
    state.charging = d.isCharging;
    setComputed(meters, d);
    maybeNotify(d);
    state.liveAt = now;
    emit();
  } catch (err) {
    state.lastError = `shelly: ${err.message}`;
    emit();
  }
}

// --- Control loop (slow, Tesla) --------------------------------------------

// Gentle car-telemetry refresh (battery %, temps, limits, location). Runs on its
// own slow timer so we don't wake/poll the car every control cycle. The live
// charging signal (amps/voltage/state/plugged) comes from the Wall Connector.
async function carCycle() {
  if (!state.teslaConfigured) return;
  const connected = state.wc && !state.wc.error ? state.wc.connected : null;
  const gentle = config.tesla.backend === 'proxy' || config.tesla.backend === 'fleet';
  if (gentle && connected === false && state.car) return; // unplugged → don't wake it
  try {
    state.car = await tesla.getVehicleData();
    if (state.lastError && state.lastError.startsWith('tesla')) state.lastError = null;
    emit();
  } catch (err) {
    state.lastError = `tesla: ${err.message}`;
    state.car = state.car ? { ...state.car, stale: true } : null;
  }
}

async function controlCycle() {
  const now = Date.now();
  state.lastCycleAt = now;
  const car = state.car; // refreshed by carCycle (gentle); WC drives the live signal
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
    // A scheduled window forces a fixed grid charge (ignores solar). A manual
    // override still takes precedence over the schedule.
    const scheduleActive = isScheduleActive();
    const sched = scheduleActive ? { amps: clamp(state.schedule.amps, C.minAmps, d.ampCeiling) } : null;
    const eff = state.override || sched; // effective forced amperage, or null = pure solar-auto
    const desired = eff ? eff.amps : d.targetAmps;
    const haveSurplusToStart = d.surplusW >= C.minAmps * d.voltage - C.resumeMarginWatts;

    if (!eff && C.stopWhenInsufficient && !haveSurplusToStart) {
      if (d.isCharging) action = await safeCmd('stop charge (insufficient surplus)', () => tesla.chargeStop());
      else action = 'idle (insufficient surplus)';
    } else {
      if (!d.isCharging && (eff || haveSurplusToStart)) {
        await safeCmd('start charge', () => tesla.chargeStart());
      }
      const current = car?.chargeAmps ?? lastSetAmps;
      if (current == null || Math.abs(desired - current) >= C.minAmpStepChange || eff) {
        action = await safeCmd(`set ${desired}A${sched && !state.override ? ' (schedule)' : ''}`, () => tesla.setChargingAmps(desired));
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
    solaxW: state.solax && state.solax.ok && state.solax.acpower != null ? Math.max(0, state.solax.acpower) : 0,
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
  const car = () => carCycle().catch((e) => { state.lastError = String(e.message || e); });
  live();
  setTimeout(car, 1500); // first car read shortly after meters
  setTimeout(ctrl, 2500); // let meters + car populate first
  timers.push(setInterval(live, (C.livePollSec || 2) * 1000));
  timers.push(setInterval(ctrl, C.pollIntervalSec * 1000));
  timers.push(setInterval(car, (C.carPollSec || 90) * 1000));
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

export default { start, stop, getState, setMode, setOverride, clearOverride, setMaxAmps, setSchedule, manualCharge, popPending, recentEvents, bus, state };
