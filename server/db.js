// SQLite persistence using Node's built-in node:sqlite (no native build needed).
// One row per control cycle (samples) + lightweight session tracking so we can
// report "energy charged this session/today/total".
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';
import { LAST_CHARGING_SAMPLE_BEFORE } from './sql.js';

const db = new DatabaseSync(config.paths.db);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    ts            INTEGER PRIMARY KEY,
    grid_power    REAL,
    export_w      REAL,
    import_w      REAL,
    solar2_w      REAL,
    floor1_w      REAL,
    floor2_w      REAL,
    voltage       REAL,
    charging      INTEGER,
    charge_amps   INTEGER,
    target_amps   INTEGER,
    charge_w      REAL,
    solax_w       REAL,
    mode          TEXT,
    action        TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    INTEGER,
    ended_at      INTEGER,
    energy_wh     REAL DEFAULT 0,
    solar_wh      REAL DEFAULT 0,
    grid_wh       REAL DEFAULT 0,
    peak_w        REAL DEFAULT 0,
    peak_amps     INTEGER DEFAULT 0,
    adjustments   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    day_ts           INTEGER PRIMARY KEY,
    samples          INTEGER,
    car_wh           REAL,
    car_solar_wh     REAL,
    car_grid_wh      REAL,
    peak_w           REAL,
    peak_amps        REAL,
    charging_samples INTEGER,
    adjustments      INTEGER,
    solar2_wh        REAL,
    solax_wh         REAL,
    export_wh        REAL,
    import_wh        REAL,
    used_wh          REAL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
`);

// Add columns introduced after the initial schema (no-op if they already exist).
try { db.exec('ALTER TABLE samples ADD COLUMN solax_w REAL'); } catch { /* already exists */ }
// Per-hour grid-import + car-grid Wh histograms (JSON arrays, length 24). Stored
// on the immutable rollup so time-of-use cost survives the sample prune AND
// stays correct if the user later edits tariff band windows — bands are applied
// at READ time over these stored hours, never baked into the rollup.
try { db.exec('ALTER TABLE daily_stats ADD COLUMN import_wh_by_hour TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE daily_stats ADD COLUMN car_grid_wh_by_hour TEXT'); } catch { /* already exists */ }

const insertSample = db.prepare(`
  INSERT OR REPLACE INTO samples
    (ts, grid_power, export_w, import_w, solar2_w, floor1_w, floor2_w, voltage,
     charging, charge_amps, target_amps, charge_w, solax_w, mode, action)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

export function recordSample(s) {
  insertSample.run(
    s.ts,
    nz(s.gridPower),
    nz(s.exportW),
    nz(s.importW),
    nz(s.solarPanels2),
    nz(s.floor1W),
    nz(s.floor2W),
    nz(s.voltage),
    s.charging ? 1 : 0,
    intOrNull(s.chargeAmps),
    intOrNull(s.targetAmps),
    nz(s.chargeW),
    nz(s.solaxW),
    s.mode || null,
    s.action || null
  );
}

// Backfill rows must never clobber a live sample: INSERT OR IGNORE keeps the
// row that was recorded from the real poll if one already exists at that ts.
// Returns 1 when a row was written, 0 when one was already there.
const insertSampleIgnore = db.prepare(`
  INSERT OR IGNORE INTO samples
    (ts, grid_power, export_w, import_w, solar2_w, floor1_w, floor2_w, voltage,
     charging, charge_amps, target_amps, charge_w, solax_w, mode, action)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
export function recordSampleIgnore(s) {
  const r = insertSampleIgnore.run(
    s.ts, nz(s.gridPower), nz(s.exportW), nz(s.importW), nz(s.solarPanels2), nz(s.floor1W), nz(s.floor2W),
    nz(s.voltage), s.charging ? 1 : 0, intOrNull(s.chargeAmps), intOrNull(s.targetAmps), nz(s.chargeW), nz(s.solaxW),
    s.mode || null, s.action || null
  );
  return r.changes;
}

// --- Session management -----------------------------------------------------

const getOpenSession = db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1');
const openSessionStmt = db.prepare('INSERT INTO sessions (started_at) VALUES (?)');
const closeSessionStmt = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?');
const updateSessionStmt = db.prepare(`
  UPDATE sessions SET energy_wh=?, solar_wh=?, grid_wh=?, peak_w=?, peak_amps=?, adjustments=? WHERE id=?
`);

export function currentSession() {
  return getOpenSession.get();
}

export function startSession(ts) {
  const existing = getOpenSession.get();
  if (existing) return existing;
  const info = openSessionStmt.run(ts);
  return getOpenSession.get() || { id: Number(info.lastInsertRowid), started_at: ts, energy_wh: 0 };
}

export function endSession(ts) {
  const s = getOpenSession.get();
  if (s) closeSessionStmt.run(ts, s.id);
}

export function updateSession(s) {
  updateSessionStmt.run(
    nz(s.energy_wh),
    nz(s.solar_wh),
    nz(s.grid_wh),
    nz(s.peak_w),
    intOrNull(s.peak_amps) || 0,
    intOrNull(s.adjustments) || 0,
    s.id
  );
}

// --- Daily stats rollups ---------------------------------------------------

const saveDayRollupStmt = db.prepare(`
  INSERT INTO daily_stats
    (day_ts, samples, car_wh, car_solar_wh, car_grid_wh, peak_w, peak_amps,
     charging_samples, adjustments, solar2_wh, solax_wh, export_wh, import_wh, used_wh,
     import_wh_by_hour, car_grid_wh_by_hour)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day_ts) DO UPDATE SET
    samples=excluded.samples, car_wh=excluded.car_wh, car_solar_wh=excluded.car_solar_wh,
    car_grid_wh=excluded.car_grid_wh, peak_w=excluded.peak_w, peak_amps=excluded.peak_amps,
    charging_samples=excluded.charging_samples, adjustments=excluded.adjustments,
    solar2_wh=excluded.solar2_wh, solax_wh=excluded.solax_wh, export_wh=excluded.export_wh,
    import_wh=excluded.import_wh, used_wh=excluded.used_wh,
    import_wh_by_hour=excluded.import_wh_by_hour, car_grid_wh_by_hour=excluded.car_grid_wh_by_hour
`);

const ZERO_HOURS = () => new Array(24).fill(0);

// Parse a stored per-hour JSON histogram back to a length-24 number array.
// A NULL column (a rollup persisted BEFORE these columns existed) returns null,
// not zeros: that null is the legacy signal stats.js's dayRollup uses to decide
// whether to self-heal the row. A present-but-corrupt/wrong-length value can't
// be trusted or backfilled from here, so it degrades to zeros. foldRollups and
// the cost path both tolerate a null histogram (treated as zeros when summed).
function parseHourArr(raw) {
  if (raw == null) return null;
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) && a.length === 24 ? a : ZERO_HOURS();
  } catch {
    return ZERO_HOURS();
  }
}

// Persist one completed day's rollup. Callers must never pass today — a
// partially-elapsed day would be frozen at its mid-day value.
export function saveDayRollup(r) {
  saveDayRollupStmt.run(
    r.day_ts, r.samples, r.car_wh, r.car_solar_wh, r.car_grid_wh, r.peak_w, r.peak_amps,
    r.charging_samples, r.adjustments, r.solar2_wh, r.solax_wh, r.export_wh, r.import_wh, r.used_wh,
    JSON.stringify(r.import_wh_by_hour || ZERO_HOURS()),
    JSON.stringify(r.car_grid_wh_by_hour || ZERO_HOURS()),
  );
}

// Read a stored rollup with its per-hour histograms parsed to arrays, so a
// stored day folds identically to a freshly computed one. Returns undefined
// when the day has no stored row.
export function readDayRollup(dayStart) {
  const row = queries.dayRollup.get(dayStart);
  if (!row) return undefined;
  return {
    ...row,
    import_wh_by_hour: parseHourArr(row.import_wh_by_hour),
    car_grid_wh_by_hour: parseHourArr(row.car_grid_wh_by_hour),
  };
}

// --- Key/value settings store (billing day, tariff) ------------------------

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : undefined;
}

export function setSetting(key, value) {
  setSettingStmt.run(key, value);
}

// --- Queries used by stats.js ----------------------------------------------

export const queries = {
  samplesSince: db.prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC'),
  samplesBetween: db.prepare('SELECT * FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts ASC'),
  // Seeds prevAmps for a day's rollup — see server/sql.js for the WHY (must be
  // the last CHARGING sample, not simply the last sample). Shared as a string
  // with test/sql.test.js since db.js itself can't be imported from a test.
  sampleBefore: db.prepare(LAST_CHARGING_SAMPLE_BEFORE),
  sampleAtOrAfter: db.prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC LIMIT 1'),
  sessionsSince: db.prepare('SELECT * FROM sessions WHERE started_at >= ? ORDER BY id DESC'),
  allSessions: db.prepare('SELECT * FROM sessions ORDER BY id DESC'),
  peakAllTime: db.prepare('SELECT MAX(charge_w) AS peak_w, MAX(charge_amps) AS peak_amps FROM samples'),
  dayRollup: db.prepare('SELECT * FROM daily_stats WHERE day_ts = ?'),
  firstRollupDay: db.prepare('SELECT MIN(day_ts) AS day_ts FROM daily_stats'),
  firstSampleTs: db.prepare('SELECT MIN(ts) AS ts FROM samples'),
};

// Drop a persisted day so the next read recomputes it from samples — used
// after a backfill adds history to a day that was already rolled up.
const deleteDayRollupStmt = db.prepare('DELETE FROM daily_stats WHERE day_ts = ?');
export function deleteDayRollup(dayTs) {
  return deleteDayRollupStmt.run(dayTs).changes;
}

const pruneStmt = db.prepare('DELETE FROM samples WHERE ts < ?');
export function pruneOld() {
  pruneStmt.run(Date.now() - config.db.sampleRetentionDays * 86400_000);
}

function nz(n) {
  return n == null || Number.isNaN(n) ? 0 : n;
}
function intOrNull(n) {
  return n == null || Number.isNaN(n) ? null : Math.round(n);
}

export default db;
