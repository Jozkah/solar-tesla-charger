// Tesla Gen-3 Wall Connector local HTTP API (read-only).
// Gives fast, cloud-independent charging telemetry: actual current, voltage,
// plugged-in / charging state, and session energy. It CANNOT set the charging
// rate — that still goes through the car command (TeslaMateApi / Fleet proxy).
import config from './config.js';

const WC = config.wallconnector || {};

export function enabled() {
  return Boolean(WC.enabled && WC.ip);
}

// A slow/blipping WC often answers on the second try, and one retry is cheap
// against a ~2s poll cadence — UNLESS the WC is genuinely down, in which case
// retrying every tick would cost up to ~2xtimeout+backoff (~6.25s) forever,
// and that fetch runs alongside the meter read in liveCycle's Promise.all, so
// it would delay the primary sensor too. The circuit breaker below caps that:
// once the WC has failed WC_BREAKER_THRESHOLD ticks in a row, we stop
// retrying and do a single attempt (~1xtimeout, matching pre-retry behavior)
// until a success proves it's back.
const WC_RETRY_BACKOFF_MS = 250;
const WC_BREAKER_THRESHOLD = 2; // consecutive failures before we stop retrying

// Pure breaker decision — no network, no config — so it's directly
// unit-testable. `consecutiveFails` is the streak BEFORE this attempt.
export function shouldRetry(consecutiveFails, threshold = WC_BREAKER_THRESHOLD) {
  return consecutiveFails < threshold;
}

// One raw fetch+parse attempt. Split out so the retry/breaker loop below can
// be driven with a fake fetchImpl in tests, with no real socket needed.
async function fetchVitalsOnce(url, timeoutMs, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = await r.json();
  const voltage = v.voltageA_v && v.voltageA_v > 50 ? v.voltageA_v : v.grid_v;
  const currentA = v.vehicle_current_a ?? v.currentA_a ?? 0;
  return {
    connected: !!v.vehicle_connected,
    charging: !!v.contactor_closed && currentA > 0.5,
    currentA: round1(currentA),
    voltage: round1(voltage),
    power: round0(currentA * (voltage || 0)),
    sessionWh: v.session_energy_wh,
    sessionS: v.session_s,
    gridHz: v.grid_hz,
    handleTempC: v.handle_temp_c, // cable handle temperature
    pcbaTempC: v.pcba_temp_c, // charger electronics temperature
    mcuTempC: v.mcu_temp_c,
    evseState: v.evse_state,
  };
}

// Retry + circuit-breaker loop, decoupled from config/global fetch so it's
// unit-testable: pass a fake fetchImpl and a fresh `breakerState` object
// ({ fails }) to drive it without touching module state or the network.
// `backoffMs` defaults to the real backoff but can be zeroed in tests.
export async function readVitalsWith(url, timeoutMs, fetchImpl, breakerState, backoffMs = WC_RETRY_BACKOFF_MS) {
  const attempts = shouldRetry(breakerState.fails) ? 2 : 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs);
    try {
      const result = await fetchVitalsOnce(url, timeoutMs, fetchImpl);
      breakerState.fails = 0; // success resets the streak
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  breakerState.fails += 1;
  return { error: String(lastErr.message || lastErr) };
}

const breakerState = { fails: 0 };

export async function readVitals() {
  if (!enabled()) return null;
  return readVitalsWith(`http://${WC.ip}/api/1/vitals`, WC.timeoutMs || 3000, fetch, breakerState);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function round0(n) { return n == null ? n : Math.round(n); }
function round1(n) { return n == null ? n : Math.round(n * 10) / 10; }

export default { enabled, readVitals, shouldRetry, readVitalsWith };
