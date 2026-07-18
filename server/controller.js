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
import * as kasa from './kasa.js';
import * as cameras from './cameras.js';
import * as db from './db.js';
import * as stats from './stats.js';
import { resolveWcReading } from './wc-resolve.js';

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
  kasa: null, // home dashboard: TP-Link smart plugs (cached)
  cameras: null, // home dashboard: Agent DVR reachability status
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
  return state.allowLimitIncrease;
}
export async function manualCharge(action) {
  if (action === 'start') {
    fullChargeLatch = false; // user explicitly wants to charge
    state.fullCharge = false;
    return tesla.chargeStart();
  }
  if (action === 'stop') return tesla.chargeStop();
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
// Soft-start: pushing high amps right after plug-in/start trips the charger
// (drops to 0 A). Track when the current charge began and cap the ramp.
let chargeStartedAt = 0;
let wasCharging = false;
let lastConnSeen = null; // WC plugged state, to detect replug and refresh the car
let lastAmpCmdAt = 0; // throttle set_charging_amps to conserve Fleet API command quota
// The WC's veto over a car-claimed charge only counts once it has held for a
// while: vitals are unsmoothed, so one odd read (contactor closed, momentary
// 0 A) would flip isCharging for a single live tick — enough to push a bogus
// "charging stopped" notification and re-issue a start command. A phantom charge
// lasts minutes, so waiting costs nothing; the car's own poll is 90s behind.
let wcStoppedSince = 0; // first tick the WC reported no current (0 = current flowing)
const WC_VETO_MS = 15_000;

// The WC is usually reachable but blips (slow/dropped poll). Carrying the last
// successful reading through a short grace window keeps one bad poll from
// flipping the whole decision onto laggy car telemetry. 15s covers a blip or
// two at the ~2s live-poll cadence while bounding staleness: a carried reading
// can be up to 15s old, but it self-corrects on the very next success — far
// better than one blip triggering the car-telemetry fallback.
let lastGoodWc = null;
let lastGoodWcAt = 0;
const WC_GRACE_MS = 15_000;

// --- Battery capacity auto-estimate ------------------------------------------
// Learned from real charges: capacity ≈ charge_energy_added / SoC gained (the
// same math TeslaMate uses). Segments with ≥10% SoC gain are kept (last 10),
// the median wins. Config batteryKwh is only the fallback until enough data.
const BATTERY_FILE = path.join(config.paths.root, 'data', 'battery.json');
let capEstimates = [];
(function loadBattery() {
  try {
    const b = JSON.parse(fs.readFileSync(BATTERY_FILE, 'utf8'));
    if (Array.isArray(b.estimates)) capEstimates = b.estimates;
  } catch { /* none yet */ }
})();
function persistBattery() {
  try {
    fs.mkdirSync(path.dirname(BATTERY_FILE), { recursive: true });
    fs.writeFileSync(BATTERY_FILE, JSON.stringify({ estimates: capEstimates }, null, 2));
  } catch { /* best effort */ }
}
function autoBatteryKwh() {
  if (capEstimates.length < 2) return null; // trust it only after a few charges
  const s = capEstimates.map((e) => e.kwh).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
let capSeg = null; // { soc0, e0, soc1, e1 } for the charge segment in progress
function finalizeCapSeg() {
  if (!capSeg) return;
  const dSoc = capSeg.soc1 - capSeg.soc0, dE = capSeg.e1 - capSeg.e0;
  capSeg = null;
  if (dSoc >= 10 && dE > 0) {
    const kwh = +((dE / dSoc) * 100).toFixed(1);
    if (kwh > 30 && kwh < 130) { // sanity band
      capEstimates.push({ ts: Date.now(), kwh, dSoc });
      if (capEstimates.length > 10) capEstimates = capEstimates.slice(-10);
      persistBattery();
    }
  }
}
function trackCapacity(car, isCharging) {
  const soc = car?.batteryLevel, e = car?.chargeEnergyAdded;
  if (isCharging && soc != null && e != null) {
    // energy counter dropped = the car started a new session — close the old segment
    if (!capSeg || e < capSeg.e1 - 0.05) { finalizeCapSeg(); capSeg = { soc0: soc, e0: e, soc1: soc, e1: e }; }
    else { capSeg.soc1 = soc; capSeg.e1 = e; }
  } else if (capSeg) {
    finalizeCapSeg();
  }
}

// Pure computation shared by both loops. The Wall Connector (wc) is the preferred
// source for actual current / voltage / charging+plugged state when available.
function computeDecision(meters, car, wc) {
  const wcOk = wc && !wc.error;
  // A plugged-in Tesla keeps the Wall Connector contactor closed and pulls a few
  // amps of standby/conditioning power (battery heat/cool, cabin preheat, Sentry)
  // WITHOUT charging — the WC alone then reads ~1–4 A and looks like a charge. Trust
  // the car's own state; fall back to the WC only at a real charge rate (>= min amps).
  const wcCurrent = wcOk ? (wc.currentA || 0) : 0;
  // Trust the car's state when we have it: with climate/AC on while plugged the
  // WC reports a real ≥minAmps draw that is NOT charging. The WC heuristic only
  // applies when car telemetry is unavailable.
  //
  // But the car/API can miss a stop (TeslaMateApi outage, TeslaMate lag): a frozen
  // 'Charging' snapshot would otherwise report a phantom charge forever, and the
  // phantom chargeW inflates the displayed solar via the energy-balance floor.
  // Two guards: a stale snapshot loses its charging-asserting vote (only those —
  // a frozen 'Stopped'/'Complete' must keep blocking the WC fallback, or a
  // conditioning draw would read as a charge), and the WC — local ground truth
  // for current actually flowing — vetoes a claimed charge once it has read no
  // current for WC_VETO_MS. 'Starting' is exempt (contactor hasn't closed yet).
  const rawState = car?.chargingState;
  const carState = car?.stale && (rawState === 'Charging' || rawState === 'Starting') ? null : rawState;
  // A WC reading no current can't veto while we're mid-throttle-reset: we issued
  // that stop ourselves and restart within seconds, so the session continues.
  const wcNoCurrent = wcOk && !wc.charging;
  // Hold the timer at zero for the whole throttle-reset window, not just while
  // deciding wcSaysStopped: the reset's own chargeStop makes wcNoCurrent true
  // and would otherwise let wcStoppedSince start counting during the stop, so
  // by the time the reset clears (~30s) and the charge restarts, the timer is
  // already ~30s old and the veto fires on the FIRST tick — before the car has
  // drawn any current. That flips isCharging false, fires a bogus "charging
  // stopped" push, splits one session into two, and re-issues chargeStart —
  // exactly the flapping the debounce exists to prevent. Resetting the timer
  // here instead gives the restart a fresh full WC_VETO_MS window once current
  // genuinely stops flowing again.
  if (!wcNoCurrent || throttleResetStopAt) wcStoppedSince = 0;
  else if (!wcStoppedSince) wcStoppedSince = Date.now();
  const wcSaysStopped = wcNoCurrent && !throttleResetStopAt
    && Date.now() - wcStoppedSince >= WC_VETO_MS;
  const isCharging = !!(carState === 'Starting'
    || (carState === 'Charging' && !wcSaysStopped)
    || (carState == null && wcOk && wc.charging && wcCurrent >= (C.minAmps - 0.5)));
  // A charging car is by definition plugged in; also accept either the Wall
  // Connector's or the car's plugged signal (one may be stale, e.g. when the
  // Fleet API is rate-limited and car telemetry goes stale).
  const connected = isCharging || (wcOk && wc.connected) || !!car?.pluggedIn;
  // Plugged in, not charging, but still drawing power = conditioning / Sentry / standby.
  const standbyW = connected && !isCharging && wcOk && wc.power > 100 ? Math.round(wc.power) : 0;
  if (isCharging && !wasCharging) chargeStartedAt = Date.now();
  wasCharging = isCharging;
  const voltage = pickVoltage(meters, car, wc);
  const actualAmps = (wcOk ? wc.currentA : car?.chargerActualCurrent) ?? null;
  // WC power is measured and always trustworthy. The car-derived fallback is only
  // meaningful during a real charge — a stale snapshot's charger_power would
  // otherwise report phantom watts after the car already stopped.
  const chargeW = wcOk && wc.power != null ? wc.power : (isCharging ? computeChargeW(car, voltage) : 0);
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
  // Soft-start ramp: hold ≤ rampMaxAmps for the first rampUpMin minutes of any
  // charge — jumping straight to 20 A on a fresh plug-in trips the charger.
  if (isCharging && chargeStartedAt && Date.now() - chargeStartedAt < (C.rampUpMin ?? 5) * 60_000) {
    ampCeiling = Math.min(ampCeiling, Math.max(C.minAmps, C.rampMaxAmps ?? 15));
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
    batteryKwh: autoBatteryKwh() ?? C.batteryKwh ?? 60, // learned from charges, config fallback
    solarMaxW: C.solarMaxW ?? null, // rated solar ceiling; caps the energy-balance floor
    solaxMaxW: C.solaxMaxW ?? null, // SolaX rating; floor can't exceed live Growatt + this
    batteryKwhLearned: autoBatteryKwh() != null,
    minAmps: C.minAmps,
    // Amps the current surplus could sustain (0 if below the minimum to charge).
    potentialAmps: clamp(Math.floor(d.surplusW / d.voltage), 0, d.ampCeiling),
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

// setInterval(live, ~2s) has no natural back-pressure: if a tick runs long
// (e.g. a hung WC even at the capped ~1xtimeout), the next tick fires anyway
// and cycles pile up concurrently, each racing to write state.meters/state.wc.
// This guard makes a slow tick skip the next one instead of overlapping it.
let liveBusy = false;

async function liveCycle() {
  if (liveBusy) return;
  liveBusy = true;
  const now = Date.now();
  try {
    const [meters, wcRead] = await Promise.all([shelly.readMeters(), wallconnector.readVitals()]);
    state.meters = meters;
    const { wc, good } = resolveWcReading({ read: wcRead, lastGood: lastGoodWc, lastGoodAt: lastGoodWcAt, nowMs: now, graceMs: WC_GRACE_MS });
    state.wc = wc;
    // Math.max guards against a stale write if ticks ever resolve out of
    // order (the liveBusy guard above already prevents overlap, but this
    // keeps lastGoodWcAt monotonic even so — belt and suspenders).
    if (good) { lastGoodWc = wcRead; lastGoodWcAt = Math.max(lastGoodWcAt, now); }
    state.solax = solax.getCached(); // cached; refreshes itself at most once per pollSec
    const loc = state.car?.location;
    state.weather = weather.getCached(loc?.lat, loc?.lon); // cached; refreshes ~every pollMin
    state.kasa = kasa.getCached(); // cached; refreshes itself at most once per pollSec
    state.cameras = cameras.getStatus(); // reachability only; video flows via proxy routes
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
  } finally {
    liveBusy = false;
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
    if (restore == null || carLimit <= restore) {
      // Nothing to undo (no stash, or the car is already at/below the user's
      // limit because they set it themselves) — just drop the flag.
      state.limitBoosted = false; savedChargeLimit = null; boostIdleSince = 0; persistBoost();
      return;
    }
    // Don't wake a sleeping car just to set a limit; wait until it's awake.
    if (state.car?.stale) return;
    // Issue the revert FIRST and only forget we were boosted once it succeeds —
    // a failed command (car asleep/offline) must NOT orphan the limit at 100%.
    const r = await safeCmd(`revert charge limit →${restore}% (${reason})`, () => tesla.setChargeLimit(restore));
    if (!String(r).startsWith('failed')) {
      state.limitBoosted = false; savedChargeLimit = null; boostIdleSince = 0; persistBoost();
    }
  }
}

async function controlCycle() {
  const now = Date.now();
  state.lastCycleAt = now;
  // Plug state changed (e.g. replugged after a drive) — refresh car telemetry
  // right away so SoC/limit aren't minutes stale.
  const connNow = state.wc && !state.wc.error ? state.wc.connected : null;
  if (connNow != null && lastConnSeen != null && connNow !== lastConnSeen) {
    await carCycle();
  }
  if (connNow != null) lastConnSeen = connNow;
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
    fullChargeLatch = false; // unplugged — the "full" pause belongs to that plug session
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
      const delta = current == null ? Infinity : Math.abs(desired - current);
      // Conserve Fleet API command quota: small solar-driven tweaks go out at most
      // once per minAmpCmdIntervalSec; a big jump or a manual override goes now.
      const bigJump = delta >= (C.ampCmdForceStep ?? 5);
      const dueByTime = (now - lastAmpCmdAt) / 1000 >= (C.minAmpCmdIntervalSec ?? 60);
      if (current == null || eff || bigJump || (delta >= C.minAmpStepChange && dueByTime)) {
        action = await safeCmd(`set ${desired}A${sched && !state.override ? ' (schedule)' : ''}`, () => tesla.setChargingAmps(desired));
        appliedAmps = desired;
        lastSetAmps = desired;
        lastAmpCmdAt = now;
        bumpAdjustments();
      } else {
        action = `hold ${current}A`;
        appliedAmps = current;
        // A previously failed command is moot once the car is already at target.
        if (state.lastError && state.lastError.startsWith('cmd ')) state.lastError = null;
      }
    }
  }

  state.lastAction = action;
  trackCapacity(car, d.isCharging);
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

// Backfill missing daily_stats rows so a day's samples get rolled up while
// they still exist — otherwise a day nobody happened to view before it ages
// out of sampleRetentionDays loses its data from `all` forever, and the first
// `all`/`month` view after a long-uptime deploy would stall the loop rolling
// up a big backlog in one go. One day per setImmediate tick: warmNextRollupDay
// does at most one dayRollup compute (~25ms worst case) then returns, so this
// never blocks the ~2s live loop, the SSE feed, or the control loop that
// commands the car. Already-persisted days are skipped almost for free, so
// this is safe and cheap to run from scratch on every boot. Harmless if the
// process exits mid-warm — the next boot just resumes the scan.
//
// Run once at boot (async, warmRollupsStep) AND re-armed on the daily timer
// (synchronous, warmRollupsDrain — see start()), ahead of pruneOld(): a day
// is only persistable for a ~sampleRetentionDays window (shouldPersistDay
// refuses anything before retentionStart), and that window slides forward
// every day. A boot-only warm-up covers history up to the day it ran; on a
// machine that stays up longer than the retention window, every day *since*
// boot would otherwise never get scanned (warmCursor already sat at "today"
// from the first run) and would eventually age out of retention and get
// pruned — losing that day's data from `all` for good. Re-arming daily lets
// the cursor resume from wherever it stopped and catch up.
let warmFailStreak = 0;
const WARM_MAX_FAIL_STREAK = 5; // give up for this run after this many in a row

// Runs exactly one warm-up day and returns whether there's more to do.
// Shared by the async boot chain (warmRollupsStep) and the synchronous daily
// drain (warmRollupsDrain) below so both get the same error handling: a
// background backfill failure is not user-actionable, so it must not hijack
// the dashboard's error banner (state.lastError) — log it instead, prefixed
// so it's identifiable in the logs. warmCursor has already advanced past the
// failing day inside warmNextRollupDay, so retrying moves on to the next day
// rather than looping on the same one; the streak counter just bounds how
// long we keep trying if failures persist (e.g. a corrupt run of days) so
// this can't retry forever.
function warmRollupsTick() {
  try {
    const more = stats.warmNextRollupDay();
    warmFailStreak = 0;
    return more;
  } catch (e) {
    warmFailStreak++;
    console.error(`rollup warm: ${e?.message || e}`);
    return warmFailStreak < WARM_MAX_FAIL_STREAK;
  }
}

// Boot warm-up: one day per event-loop tick via setImmediate, so the
// synchronous DB work (~25ms/day worst case) never blocks the ~2s live loop,
// the SSE feed, or the control loop that commands the car for more than one
// day at a stretch — see the big comment above for the full rationale.
function warmRollupsStep() {
  if (warmRollupsTick()) setImmediate(warmRollupsStep);
}

// Daily re-arm: drains the backlog SYNCHRONOUSLY, in the same tick, before
// pruneOld() runs right after it (see start()). This is what actually makes
// good on "the day that just aged into the persistable window gets its
// chance before pruneOld can delete its samples" — a fully async chain (as
// warmRollupsStep uses for the boot warm-up) is NOT guaranteed to have
// reached that day by the time this callback returns and pruneOld() fires;
// nothing here says "and the rest happens eventually" so it must not promise
// "happens before X" while actually being async.
//
// Safe to do synchronously specifically here, unlike the boot warm-up: this
// timer fires once every 24h, and under normal operation the boot warm-up
// (or yesterday's run of this very drain) has already caught warmCursor up
// to "today - 1" long before the next tick — so this loop typically runs
// ONE ~25ms step, not a multi-day backfill. WARM_MAX_FAIL_STREAK still bounds
// it if a run of days keeps throwing. If a deployment goes down for weeks and
// wakes up with a huge backlog, that backlog is instead drained by the async
// boot warm-up (setImmediate chain) well before this interval ever fires.
function warmRollupsDrain() {
  while (warmRollupsTick());
}

export function start() {
  if (timers.length) return;
  const live = () => liveCycle().catch((e) => { state.lastError = String(e?.message || e); });
  const ctrl = () => controlCycle().catch((e) => { state.lastError = String(e?.message || e); });
  const car = () => carCycle().catch((e) => { state.lastError = String(e?.message || e); });
  const camStatus = () => cameras.refreshStatus().catch(() => {}); // home dashboard reachability
  live();
  camStatus();
  setTimeout(car, 1500); // first car read shortly after meters
  setTimeout(ctrl, 2500); // let meters + car populate first
  setImmediate(warmRollupsStep); // backfill missing daily_stats rows, one day per tick
  timers.push(setInterval(live, (C.livePollSec || 2) * 1000));
  timers.push(setInterval(ctrl, C.pollIntervalSec * 1000));
  timers.push(setInterval(car, (C.carPollSec || 90) * 1000));
  timers.push(setInterval(camStatus, (config.cameras?.statusPollSec || 45) * 1000));
  // Re-arm the warm-up ahead of the prune so a day that just became eligible
  // to persist gets its chance before pruneOld can delete its samples — see
  // warmRollupsDrain's comment for why this must be the synchronous drain,
  // not warmRollupsStep's async chain. warmFailStreak resets here too: it
  // otherwise only clears on success, so a run that ended at the 5-failure
  // cap would leave the next day's re-arm with just ONE attempt before
  // hitting that same stale cap again, instead of a fresh 5.
  timers.push(setInterval(() => { warmFailStreak = 0; warmRollupsDrain(); db.pruneOld(); }, 86_400_000));
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
