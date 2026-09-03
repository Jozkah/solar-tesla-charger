// Polls both Shelly EM (Gen1) meters and normalizes their readings into labeled
// channels plus the key derived values the rest of the app cares about.
//
// Gen1 EM HTTP API: GET http://<ip>/status returns { emeters: [ {power, voltage,
// total, total_returned, is_valid, ...}, ... ] }. emeters[0] == channel/string 1,
// emeters[1] == channel/string 2. `power` is signed: negative = exporting/generating.
// GET http://<ip>/emeter/<n> returns the same fields for a single channel.
import config from './config.js';

const RETRY_BACKOFF_MS = 250;

async function fetchJson(url, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function normalize(dev, idx, meta, em) {
  const power = round1(em.power);
  const voltage = round1(em.voltage);
  return {
    key: meta.key,
    label: meta.label,
    role: meta.role,
    ip: dev.ip,
    channel: Number(idx),
    power,
    voltage,
    pf: em.pf == null ? null : round2(em.pf), // power factor (-1..1)
    // Apparent/derived current (Gen1 EM doesn't report amps directly).
    current: voltage && voltage > 50 && power != null ? round2(Math.abs(power) / voltage) : null,
    // Gen1 totals are in Wh (consumed) / Wh (returned).
    totalWh: em.total,
    totalReturnedWh: em.total_returned,
    valid: em.is_valid !== false,
  };
}

function failed(dev, meta, err) {
  return {
    key: meta.key,
    label: meta.label,
    role: meta.role,
    ip: dev.ip,
    power: null,
    voltage: null,
    valid: false,
    error: String(err.message || err),
  };
}

// One device, three chances: /status, /status again after a short backoff,
// then the per-channel /emeter/<n> endpoints. A Shelly that is slow or busy
// (an em_data.csv download in flight, a WiFi blip) usually answers on the
// second try; the per-channel path survives a /status handler that stalls.
// Returns { channels: {key -> channel}, error: string|null }. Decoupled from
// config and global fetch so it is unit-testable.
export async function readDeviceWith(dev, timeoutMs, fetchImpl = fetch, backoffMs = RETRY_BACKOFF_MS) {
  const channels = {};
  const entries = Object.entries(dev.channels);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(backoffMs);
    try {
      const status = await fetchJson(`http://${dev.ip}/status`, timeoutMs, fetchImpl);
      const emeters = status.emeters || [];
      for (const [idx, meta] of entries) {
        const em = emeters[Number(idx)];
        if (em) channels[meta.key] = normalize(dev, idx, meta, em);
      }
      return { channels, error: null };
    } catch (err) {
      lastErr = err;
    }
  }
  // Fallback: per-channel endpoint. Partial success is still success for the
  // channels that answered; the rest are marked failed.
  let anyOk = false;
  for (const [idx, meta] of entries) {
    try {
      const em = await fetchJson(`http://${dev.ip}/emeter/${Number(idx)}`, timeoutMs, fetchImpl);
      channels[meta.key] = normalize(dev, idx, meta, em);
      anyOk = true;
    } catch (err) {
      channels[meta.key] = failed(dev, meta, err);
      lastErr = err;
    }
  }
  return { channels, error: anyOk ? null : String(lastErr?.message || lastErr) };
}

// Returns a flat map keyed by channel `key` (floor1, grid, ...) with normalized data,
// plus convenience aggregates. Throws only if a *grid* reading can't be obtained.
export async function readMeters() {
  const { devices, timeoutMs } = config.shelly;
  const channels = {};
  const errors = [];

  await Promise.all(
    devices.map(async (dev) => {
      const r = await readDeviceWith(dev, timeoutMs);
      Object.assign(channels, r.channels);
      if (r.error) errors.push({ ip: dev.ip, error: r.error });
    })
  );

  const grid = channels.grid;
  if (!grid || grid.power == null) {
    const e = new Error('Could not read grid meter (192.168.1.x ch0).');
    e.partial = { channels, errors };
    throw e;
  }

  // Aggregate solar = explicit solar channels + the solar injected into floor1.
  // floor1 (load_with_solar) net power already nets solarPanel1 against floor1 load,
  // so we expose both the raw channel and a best-effort total generation figure.
  const solarPanels2 = channels.solarPanels2?.power ?? 0;

  const gridPower = grid.power; // signed: + import, - export
  const exportW = gridPower < 0 ? -gridPower : 0;
  const importW = gridPower > 0 ? gridPower : 0;

  // Reference voltage for amp math: prefer the grid clamp's live voltage.
  const voltage = grid.voltage && grid.voltage > 100 ? grid.voltage : config.control.voltage;

  return {
    ts: Date.now(),
    channels,
    grid,
    gridPower,
    exportW: round1(exportW),
    importW: round1(importW),
    solarPanels2: round1(solarPanels2),
    voltage: round1(voltage),
    errors,
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
function round1(n) {
  if (n == null || Number.isNaN(n)) return n;
  return Math.round(n * 10) / 10;
}
function round2(n) {
  if (n == null || Number.isNaN(n)) return n;
  return Math.round(n * 100) / 100;
}

export default { readMeters, readDeviceWith };
