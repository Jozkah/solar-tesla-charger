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
  allowLimitIncrease: false, // opportunistically raise the SoC limit to soak up free solar
  limitBoosted: false, // true while we're holding the car's SoC limit above the user's setting
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
let savedChargeLimit = null; // the user's real SoC limit, stashed while boosted
let boostIdleSince = 0; // when free solar first dropped while boosted (revert grace timer)
let timers = [];
let controlBusy = false; // guards controlCycle against overlapping runs (interval + kicks)

// Charging start/stop event detection + a small queue the Apple Shortcut drains.
let prevCharging = null;
const eventLog = []; // recent events (for reference)
const pendingNotifications = []; // messages awaiting delivery to the phone
let solarFasterSince = 0; // when "override slower than solar" first became true (0 = not now)
let solarFasterNotifiedAt = 0; // last time we pushed that warning (for cooldown)

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

// Push a one-shot warning when an override is charging slower than the solar
// surplus could — i.e. free solar is being exported instead of used. Edge-triggered
// with a sustain window (ignore brief surplus spikes) and a cooldown (don't nag).
function maybeWarnSolarFaster(now) {
  const comp = state.computed;
  if (!comp?.solarCouldChargeFaster || !state.override) { solarFasterSince = 0; return; }
  if (!solarFasterSince) solarFasterSince = now;
  const sustainMs = (C.solarFasterSustainSec ?? 120) * 1000;
  const cooldownMs = (C.solarFasterCooldownMin ?? 30) * 60_000;
  if (now - solarFasterSince < sustainMs) return; // must persist — ignore passing clouds/spikes
  if (now - solarFasterNotifiedAt < cooldownMs) return; // already warned recently
  solarFasterNotifiedAt = now;
  recordEvent('solar', `☀️ Solar could charge faster — surplus supports ${comp.potentialAmps}A but you're overriding at ${state.override.amps}A. Switch to Auto to use the free solar.`);
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
  kickControl();
  return state.mode;
}
export function setOverride(amps, expiresInMin) {
  const a = clamp(Math.round(amps), C.minAmps, C.maxAmps);
  state.override = { amps: a, expiresAt: expiresInMin ? Date.now() + expiresInMin * 60_000 : null };
  state.mode = 'auto';
  emit();
  kickControl(); // apply the forced charge right away, don't wait for the next tick
  return state.override;
}
export function clearOverride() {
  state.override = null;
  emit();
  kickControl();
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
  kickControl();
  return state.maxAmps;
}

// --- Opportunistic battery-limit increase ----------------------------------
// When there's free solar beyond the user's SoC limit, raise the limit to 100%
// so the surplus tops the battery up for free, then restore the user's limit
// when the sun (or the feature) goes away. Persisted so a restart while boosted
// can still revert. Tesla's minimum settable SoC limit is 50%.
const BOOST_FILE = path.join(config.paths.root, 'data', 'boost.json');
const BOOST_REVERT_DELAY_MS = 5 * 60_000; // ride out passing clouds before reverting
(function loadBoost() {
  try {
    const b = JSON.parse(fs.readFileSync(BOOST_FILE, 'utf8'));
    if (b && typeof b === 'object') {
      state.allowLimitIncrease = !!b.allowLimitIncrease;
      savedChargeLimit = typeof b.savedChargeLimit === 'number' ? b.savedChargeLimit : null;
      state.limitBoosted = savedChargeLimit != null;
    }
  } catch { /* none yet */ }
})();
function persistBoost() {
  try {
    fs.mkdirSync(path.dirname(BOOST_FILE), { recursive: true });
    fs.writeFileSync(BOOST_FILE, JSON.stringify({ allowLimitIncrease: state.allowLimitIncrease, savedChargeLimit }, null, 2));
  } catch { /* best effort */ }
}
export function setAllowLimitIncrease(on) {
  state.allowLimitIncrease = !!on;
  persistBoost();
  emit();
  kickControl();
  return state.allowLimitIncrease;
}
// Raise/restore the car's SoC limit to capture free solar past the user's cap.
// Idempotent per cycle: only sends a command on the raise/revert transitions.
async function manageChargeLimit(d, now) {
  if (!state.teslaConfigured) return;
  const soc = state.car?.batteryLevel;
  const carLimit = state.car?.chargeLimitSoc;
  if (soc == null || carLimit == null) return; // need real telemetry to act safely
  // While boosted the car reads 100%, so the user's real cap is the stashed value.
  const baseLimit = state.limitBoosted && savedChargeLimit != null ? savedChargeLimit : carLimit;
  const haveSurplus = d.surplusW >= C.minAmps * d.voltage - C.resumeMarginWatts;
  const wantBoost = state.allowLimitIncrease && d.connected && state.mode === 'auto'
    && !state.override && !isScheduleActive() && baseLimit < 100 && soc < 100 && haveSurplus;
  if (wantBoost) {
    boostIdleSince = 0;
    if (!state.limitBoosted) {
      savedChargeLimit = carLimit; // stash the user's real limit before raising
      state.limitBoosted = true;
      persistBoost();
      await safeCmd(`raise charge limit ${carLimit}%→100% (free sun)`, () => tesla.setChargeLimit(100));
    }
    return;
  }
  if (state.limitBoosted) {
    const reason = !state.allowLimitIncrease ? 'off'
      : !d.connected ? 'unplugged'
      : state.override || isScheduleActive() || state.mode !== 'auto' ? 'manual'
      : soc >= 100 ? 'full'
      : 'no sun';
    if (reason === 'no sun') { // grace period so passing clouds don't thrash the limit
      if (!boostIdleSince) boostIdleSince = now;
      if (now - boostIdleSince < BOOST_REVERT_DELAY_MS) return;
    }
    const restore = savedChargeLimit != null ? clamp(savedChargeLimit, 50, 100) : null;
    state.limitBoosted = false;
    savedChargeLimit = null;
    boostIdleSince = 0;
    persistBoost();
    if (restore != null) await safeCmd(`revert charge limit →${restore}% (${reason})`, () => tesla.setChargeLimit(restore));
  }
}
export async function manualCharge(action) {
  if (action === 'start') {
    // A manual start resumes management. Un-pause so the control loop charges
    // (use the Override button to force a fixed rate regardless of solar).
    if (state.mode === 'pause') { state.mode = 'auto'; emit(); }
    fullChargeLatch = false; // user explicitly wants to charge
    state.fullCharge = false;
    return tesla.chargeStart();
  }
  if (action === 'stop') {
    // A manual stop must stick. Drop any override (otherwise the control loop
    // immediately re-issues charge_start to honor it) and pause auto so solar
    // surplus doesn't silently restart the charge. "Back to auto" resumes.
    state.override = null;
    state.mode = 'pause';
    emit();
    return tesla.chargeStop();
  }
  throw new Error('action must be start|stop');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Voltage-drop throttle ("Charge rate reduced" in the Tesla app): the car keeps
// charge_current_request at the set value but draws fewer amps. Detected straight
// from that car-reported gap and LATCHED — the control loop follows the car down,
// which erases the live gap, but the underlying condition usually persists until
// replug, so the banner must too.
let throttleStreak = 0;
let throttleLatch = null; // { since, requestA, actualA }
let throttleClearSince = null;
let throttleHoldUntil = 0; // while in the future, don't raise amps above the latched rate
// The car's voltage-drop limiter persists for the whole charge session, but a
// stop→start cycle resets it to full amps (same as the phone app, no replug).
let throttleResetStopAt = 0; // ts of the reset's chargeStop; 0 = no reset in flight
const THROTTLE_RESET_WAIT_MS = 30_000;
// Once the battery hits 100% stop driving the car entirely: no start commands,
// no amp changes. Cleared by a manual start/override or once the battery is
// actually used again (drops to fullResumeSoc, default 92%).
let fullChargeLatch = false;

// Pure computation shared by both loops. The Wall Connector (wc) is the preferred
// source for actual current / voltage / charging+plugged state when available.
function computeDecision(meters, car, wc) {
  const wcOk = wc && !wc.error;
  // Trust the car's own charging state; fall back to the Wall Connector only at a
  // real charge rate (>= min amps). A plugged-in car pulls a few amps of standby/
  // conditioning power (battery heat/cool, cabin preheat, Sentry) that keeps the WC
  // contactor closed and otherwise looks like a charge.
  const wcCurrent = wcOk ? (wc.currentA || 0) : 0;
  // Trust the car's state when we have it: with climate/AC on while plugged the
  // WC reports a real ≥minAmps draw that is NOT charging. The WC heuristic only
  // applies when car telemetry is unavailable.
  const carState = car?.chargingState;
  const isCharging = carState === 'Charging' || carState === 'Starting'
    || (carState == null && wcOk && wc.charging && wcCurrent >= (C.minAmps - 0.5));
  const connected = wcOk ? wc.connected : !!car?.pluggedIn;
  // Plugged in, not charging, but still drawing power = conditioning / Sentry / standby.
  const standbyW = connected && !isCharging && wcOk && wc.power > 100 ? Math.round(wc.power) : 0;
  const voltage = pickVoltage(meters, car, wc);
  const actualAmps = (wcOk ? wc.currentA : car?.chargerActualCurrent) ?? null;
  const chargeW = wcOk && wc.power != null ? wc.power : computeChargeW(car, voltage);
  const commandedAmps = car?.chargeAmps ?? lastSetAmps ?? null;
  const surplusW = meters.exportW + (isCharging ? chargeW : 0) - C.bufferWatts;
  const carMax = car?.chargeCurrentRequestMax;
  let ampCeiling = C.maxAmps;
  if (carMax && carMax > 0) ampCeiling = Math.min(ampCeiling, carMax); // car/circuit limit
  if (state.maxAmps) ampCeiling = Math.min(ampCeiling, state.maxAmps); // user-set auto cap
  // After a throttle, hold at the rate the car accepted instead of re-probing the
  // sag point every cycle; the cap lifts when the cooldown expires (re-probe).
  if (throttleLatch && Date.now() < throttleHoldUntil) {
    ampCeiling = Math.min(ampCeiling, Math.max(C.minAmps, throttleLatch.actualA));
  }
  const targetAmps = clamp(Math.floor(surplusW / voltage), C.minAmps, ampCeiling);
  // Voltage-drop throttle, read from the car's own report: it draws materially
  // fewer amps than its charge_current_request. Guard with lastSetAmps so a stale
  // car snapshot right after WE lowered the command doesn't false-positive
  // (real throttle = actual is also well below what we last set).
  const carReqAmps = car?.chargeCurrentRequest ?? commandedAmps;
  // Ignore while a throttle reset is cycling the session, and ignore sub-minAmps
  // readings — a genuine throttle trims ~25% (e.g. 20→15 A); near-zero amps is a
  // stop/start ramp, not a throttle.
  const gapNow =
    isCharging && actualAmps != null && carReqAmps != null &&
    !throttleResetStopAt && actualAmps >= C.minAmps - 0.5 &&
    carReqAmps - actualAmps >= 2 &&
    (lastSetAmps == null || actualAmps <= lastSetAmps - 2);
  if (gapNow) {
    throttleStreak++;
    throttleClearSince = null;
    if (throttleStreak >= 2) {
      if (!throttleLatch) {
        throttleLatch = { since: Date.now(), requestA: carReqAmps, actualA: Math.round(actualAmps) };
        recordEvent('throttle', `⚡ Car reduced charge rate: asked ${carReqAmps} A, drawing ${Math.round(actualAmps)} A (voltage drop)`);
      } else {
        // Re-throttled during a probe — update to the freshly accepted rate.
        throttleLatch.requestA = carReqAmps;
        throttleLatch.actualA = Math.round(actualAmps);
      }
      throttleHoldUntil = Date.now() + (C.throttleCooldownMin ?? 10) * 60_000;
    }
  } else {
    throttleStreak = 0;
    if (throttleLatch) {
      if (!connected) {
        throttleLatch = null; throttleClearSince = null; throttleHoldUntil = 0; // replug resets
      } else if (!isCharging && !throttleResetStopAt) {
        // Charge session ended (complete/stopped) — the car's limiter dies with
        // the session, so the banner shouldn't outlive it.
        throttleLatch = null; throttleClearSince = null; throttleHoldUntil = 0;
      } else if (Date.now() >= throttleHoldUntil && isCharging && actualAmps != null &&
                 carReqAmps != null && carReqAmps - actualAmps <= 1) {
        // Cooldown over and the car takes what we ask again — clear after 3 min
        // sustained so the banner disappears once the re-probe works.
        if (!throttleClearSince) throttleClearSince = Date.now();
        if (Date.now() - throttleClearSince > 3 * 60_000) { throttleLatch = null; throttleClearSince = null; }
      } else {
        throttleClearSince = null;
      }
    }
  }
  const throttled = gapNow ? throttleStreak >= 2 : !!throttleLatch;
  const enoughToCharge = surplusW >= C.minAmps * voltage - C.resumeMarginWatts;
  const throttleInfo = throttleLatch ? { ...throttleLatch, holdUntil: throttleHoldUntil } : null;
  return { voltage, chargeW, isCharging, connected, surplusW, ampCeiling, targetAmps, actualAmps, commandedAmps, throttled, throttleInfo, enoughToCharge, standbyW };
}

function setComputed(meters, d) {
  // Amps the current surplus could sustain (0 if below the minimum to charge).
  const potentialAmps = clamp(Math.floor(d.surplusW / d.voltage), 0, d.ampCeiling);
  const ov = state.override;
  // Override is charging slower than the available solar surplus could sustain, so
  // free solar is being exported instead of used. Margin avoids noise from small
  // fluctuations. (When the override draw already exceeds surplus, this is false —
  // that's "using grid", a different situation the user didn't ask to be warned of.)
  const solarCouldChargeFaster =
    !!(ov && d.isCharging && potentialAmps - ov.amps >= (C.solarFasterMarginAmps ?? 2));
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
    throttleInfo: d.throttleInfo, // latched { since, requestA, actualA } while active
    minAmps: C.minAmps,
    potentialAmps,
    solarCouldChargeFaster,
    enoughToCharge: d.enoughToCharge,
    standbyW: d.standbyW, // conditioning/Sentry draw while plugged in but not charging
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
    maybeWarnSolarFaster(now);
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

    const soc = car?.batteryLevel;
    // Only treat as full once the car actually FINISHES (it trickle-balances at
    // "100%" for a while) — latching mid-charge would fight the car's own finish.
    if (soc != null && soc >= 100 && !d.isCharging) {
      if (!fullChargeLatch) {
        fullChargeLatch = true;
        recordEvent('full', '🔋 Car fully charged — automatic charging paused');
      }
    } else if (fullChargeLatch && soc != null && soc <= (C.fullResumeSoc ?? 92)) {
      fullChargeLatch = false; // battery was used — resume solar-auto
    }
    if (eff) fullChargeLatch = false; // manual override/schedule = explicit user intent

    if (fullChargeLatch) {
      action = 'car full — auto charging paused';
    } else if (throttleResetStopAt) {
      // Throttle-reset in flight: we stopped the charge; restart after a short
      // pause and re-ramp. Abandon if it somehow lingers (e.g. car went away).
      if (now - throttleResetStopAt > 5 * 60_000) {
        throttleResetStopAt = 0;
        action = 'throttle reset abandoned';
      } else if (now - throttleResetStopAt >= THROTTLE_RESET_WAIT_MS) {
        throttleResetStopAt = 0;
        throttleStreak = 0;
        await safeCmd('restart charge (throttle reset)', () => tesla.chargeStart());
        action = await safeCmd(`set ${desired}A (throttle reset)`, () => tesla.setChargingAmps(desired));
        appliedAmps = desired;
        lastSetAmps = desired;
        bumpAdjustments();
      } else {
        action = 'throttle reset: brief charge pause';
      }
    } else if (!eff && throttleLatch && now >= throttleHoldUntil && d.isCharging &&
               haveSurplusToStart && desired >= throttleLatch.actualA + 2) {
      // Cooldown over and we want materially more than the car accepted —
      // cycle the session to clear the limiter instead of just asking again.
      throttleResetStopAt = now;
      action = await safeCmd('stop charge (throttle reset)', () => tesla.chargeStop());
    } else if (!eff && C.stopWhenInsufficient && !haveSurplusToStart) {
      if (d.isCharging) action = await safeCmd('stop charge (not enough sun)', () => tesla.chargeStop());
      else action = 'idle (not enough sun)';
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
  state.fullCharge = fullChargeLatch;
  state.fullResumeSoc = C.fullResumeSoc ?? 92;
  await manageChargeLimit(d, now);
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

// Guarded entry point: the periodic interval AND the on-demand kicks (override /
// mode / ceiling changes) both go through here so two cycles never overlap and
// double-fire Tesla commands.
async function runControl() {
  if (controlBusy) return;
  controlBusy = true;
  try { await controlCycle(); }
  finally { controlBusy = false; }
}
// Fire-and-forget control cycle for UI actions that want an immediate effect.
function kickControl() {
  runControl().catch((e) => { state.lastError = String(e?.message || e); });
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
    // A command went through — clear any stale command error so the banner
    // doesn't show a transient failure (e.g. a brief asleep 408) forever.
    if (state.lastError && state.lastError.startsWith('cmd ')) state.lastError = null;
    return r?.dryRun ? `[dry-run] ${label}` : label;
  } catch (err) {
    state.lastError = `cmd ${label}: ${err?.message || err}`;
    return `failed: ${label}`;
  }
}

export function start() {
  if (timers.length) return;
  const live = () => liveCycle().catch((e) => { state.lastError = String(e?.message || e); });
  const ctrl = () => runControl().catch((e) => { state.lastError = String(e?.message || e); });
  const car = () => carCycle().catch((e) => { state.lastError = String(e?.message || e); });
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

export default { start, stop, getState, setMode, setOverride, clearOverride, setMaxAmps, setSchedule, setAllowLimitIncrease, manualCharge, popPending, recentEvents, bus, state };
