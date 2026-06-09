// Tesla Gen-3 Wall Connector local HTTP API (read-only).
// Gives fast, cloud-independent charging telemetry: actual current, voltage,
// plugged-in / charging state, and session energy. It CANNOT set the charging
// rate — that still goes through the car command (TeslaMateApi / Fleet proxy).
import config from './config.js';

const WC = config.wallconnector || {};

export function enabled() {
  return Boolean(WC.enabled && WC.ip);
}

export async function readVitals() {
  if (!enabled()) return null;
  try {
    const r = await fetch(`http://${WC.ip}/api/1/vitals`, { signal: AbortSignal.timeout(WC.timeoutMs || 3000) });
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
      handleTempC: v.handle_temp_c,
      evseState: v.evse_state,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function round0(n) { return n == null ? n : Math.round(n); }
function round1(n) { return n == null ? n : Math.round(n * 10) / 10; }

export default { enabled, readVitals };
