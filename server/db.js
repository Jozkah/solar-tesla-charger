// SQLite persistence using Node's built-in node:sqlite (no native build needed).
// One row per control cycle (samples) + lightweight session tracking so we can
// report "energy charged this session/today/total".
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

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

  CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
`);

// Add columns introduced after the initial schema (no-op if they already exist).
try { db.exec('ALTER TABLE samples ADD COLUMN solax_w REAL'); } catch { /* already exists */ }

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

// --- Queries used by stats.js ----------------------------------------------

export const queries = {
  samplesSince: db.prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC'),
  sessionsSince: db.prepare('SELECT * FROM sessions WHERE started_at >= ? ORDER BY id DESC'),
  allSessions: db.prepare('SELECT * FROM sessions ORDER BY id DESC'),
  peakAllTime: db.prepare('SELECT MAX(charge_w) AS peak_w, MAX(charge_amps) AS peak_amps FROM samples'),
};

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
