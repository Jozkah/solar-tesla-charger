// Recovers lost meter history from the Shelly EM's on-device energy log.
//
// Gen1 EM keeps `GET /emeter/{n}/em_data.csv`: one row per 10 minutes of
// consumed / returned Wh plus min/max voltage, oldest first, from the day the
// device was installed. It is slow (~8 KB/s, minutes for the whole log), the
// `date_range` parameter is ignored, and a device serves one download at a
// time ("Another file transfer is in progress!"). So this runs strictly in the
// background, one channel at a time per device, and only for gaps worth it.
//
// This file is the pure, network-free half (plus fetchEmData, which takes an
// injectable fetch); server/backfill.js wires it to config, the DB and timers.

export const BUSY_BODY = 'Another file transfer is in progress!';
export const DEFAULT_INTERVAL_MS = 600_000;

// "2026-05-14 22:30" (UTC) -> epoch ms
function parseUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

// CSV text -> [{ ts, wh, returnedWh, minV, maxV }] sorted by ts. Header and
// malformed lines are skipped; a partial last line (cut transfer) is dropped.
export function parseEmData(csv) {
  const out = [];
  for (const raw of String(csv || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^date/i.test(line)) continue;
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const ts = parseUtc(cols[0]);
    const wh = Number(cols[1]), returnedWh = Number(cols[2]);
    if (ts == null || !Number.isFinite(wh) || !Number.isFinite(returnedWh)) continue;
    const minV = Number(cols[3]), maxV = Number(cols[4]);
    out.push({
      ts, wh, returnedWh,
      minV: Number.isFinite(minV) ? minV : null,
      maxV: Number.isFinite(maxV) ? maxV : null,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Median spacing between consecutive rows; falls back to 10 min when there
// are too few rows to tell.
export function bucketInterval(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].ts - rows[i - 1].ts;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return DEFAULT_INTERVAL_MS;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// channels: { grid?, floor1?, floor2?, solarPanels2? } -> parsed rows each.
// Returns one sample per bucket that STARTS inside [from, to), in the shape
// db.recordSample expects. Signed power matches the live convention:
// positive = consumption / import, negative = generation / export.
export function bucketsToSamples({ channels, from, to }) {
  const byTs = new Map();
  const intervals = {};
  for (const [key, rows] of Object.entries(channels)) {
    if (!rows || !rows.length) continue;
    const intervalMs = bucketInterval(rows);
    intervals[key] = intervalMs;
    const hours = intervalMs / 3_600_000;
    for (const r of rows) {
      if (r.ts < from || r.ts >= to) continue;
      let s = byTs.get(r.ts);
      if (!s) { s = { ts: r.ts, vSum: 0, vN: 0 }; byTs.set(r.ts, s); }
      s[key] = (r.wh - r.returnedWh) / hours;
      if (r.minV != null && r.maxV != null) { s.vSum += (r.minV + r.maxV) / 2; s.vN++; }
    }
  }
  const out = [];
  for (const s of [...byTs.values()].sort((a, b) => a.ts - b.ts)) {
    const gridPower = s.grid ?? null;
    out.push({
      ts: s.ts,
      gridPower,
      exportW: gridPower != null && gridPower < 0 ? -gridPower : 0,
      importW: gridPower != null && gridPower > 0 ? gridPower : 0,
      solarPanels2: s.solarPanels2 ?? null,
      floor1W: s.floor1 ?? null,
      floor2W: s.floor2 ?? null,
      voltage: s.vN ? round1(s.vSum / s.vN) : null,
      charging: false,
      chargeAmps: null,
      targetAmps: null,
      chargeW: 0, // the Wall Connector keeps no history; never guess the car's share
      solaxW: 0,
      mode: 'backfill',
      action: 'backfill',
    });
  }
  return out;
}

// One download. The device answers 200 with BUSY_BODY when another transfer
// is running, so that body is an error, not data.
// Never abort a transfer early: the device would keep its transfer flag set
// until it reboots. The full log is a few MB at ~8 KB/s, so allow a long time.
export async function fetchEmData(ip, index, { timeoutMs = 30 * 60_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`http://${ip}/emeter/${index}/em_data.csv`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.startsWith(BUSY_BODY)) throw new Error('device busy with another transfer');
  return text;
}

function round1(n) { return Math.round(n * 10) / 10; }
