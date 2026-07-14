// Integration regression test for the retention-window drop bug: a stored
// daily_stats rollup older than sampleRetentionDays used to be silently
// dropped from `all`/`month` because rollupRange walked from historyStart
// (earliest SURVIVING sample) instead of knownStart (earliest thing we know
// about, including stored rollups whose backing samples are already pruned).
// walkStartMs (rollup.test.js) is pure arithmetic over a param named
// `knownStart` and cannot detect that stats.js handed it the WRONG bound —
// that defect can only be caught by actually calling rollupRange/getStats
// against a real database, which is what this test does.
//
// This requires a REAL SQLite database, which requires server/config.js and
// server/db.js to be importable outside the real deployment: server/config.js
// hardcodes config.json (gitignored, absent in a fresh clone) and server/db.js
// opens SQLite at import time from config.paths.db. The CONFIG_PATH/DB_PATH
// env overrides added to server/config.js for this test exist to make that
// possible WITHOUT weakening production — with both unset, config.js behaves
// byte-for-byte as before (see server/db.js import in the app itself, and the
// PROD_CONFIG_UNCHANGED note in the followups report).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
const dbPath = path.join(tmpDir, 'test.db');
const configPath = path.join(tmpDir, 'config.json');

// config.json.example's db.path value is irrelevant once DB_PATH is set
// (config.js prefers the env override), so a plain copy is enough — no need
// to rewrite it.
fs.copyFileSync(path.join(repoRoot, 'config.json.example'), configPath);

// MUST be set before the dynamic imports below: server/config.js (and
// transitively server/db.js) read these as an import-time side effect, so a
// static top-of-file `import` would already be too late.
process.env.CONFIG_PATH = configPath;
process.env.DB_PATH = dbPath;

const { getStats, periodBounds } = await import('../server/stats.js');
const { saveDayRollup, recordSample, default: db } = await import('../server/db.js');
const { startOfDayMs } = await import('../server/rollup.js');

test.after(() => {
  delete process.env.CONFIG_PATH;
  delete process.env.DB_PATH;
  db.close(); // release the sqlite file handle before deleting it (required on Windows)
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The pre-retention stored rollup: as if this day was viewed and persisted
// back when it was still within the retention window, and its `samples` rows
// have since been pruned (config.json.example's sampleRetentionDays is 60,
// and this day is a full 3 calendar months back — always > 60 days old
// regardless of which day this suite happens to run on). Anchored to exactly
// `periodBounds('month', 3).since` (rather than a fixed day-count) so the
// `month` assertion below is guaranteed to land on its day regardless of run
// date — no day-count-vs-calendar-month arithmetic to get wrong.
const oldMonth = periodBounds('month', 3);
saveDayRollup({
  day_ts: oldMonth.since,
  samples: 2,
  car_wh: 7000, car_solar_wh: 7000, car_grid_wh: 0,
  peak_w: 14000, peak_amps: 32,
  charging_samples: 1, adjustments: 0,
  solar2_wh: 0, solax_wh: 0, export_wh: 0, import_wh: 0, used_wh: 0,
});

// Real recent samples (~10 days ago — always inside the 60-day retention
// window, and always in a different calendar month than `oldMonth`, 3 months
// back). Two samples 30 minutes apart at 14,000 W charge power: computeDayRollup
// values each interval by its LEFT sample, so this is 14000 W * 0.5 h = 7000 Wh,
// computed live exactly like production — not hand-inserted as a rollup, so
// this half of the total exercises the ordinary (non-retention-boundary) path.
const recentDay = startOfDayMs(Date.now() - 10 * 86_400_000);
const t0 = recentDay + 10 * 3_600_000; // 10:00 local
recordSample({ ts: t0, chargeW: 14000, charging: true, chargeAmps: 32 });
recordSample({ ts: t0 + 1_800_000, chargeW: 0, charging: false });

test('getStats("all") folds a pre-retention stored rollup together with recent samples', () => {
  // 7000 (stored, samples long pruned) + 7000 (recent, live samples) = 14000.
  // Before the fix, rollupRange walked from historyStart (earliest surviving
  // sample = recentDay) and never visited oldMonth.since at all, so this
  // would report 7000, not 14000.
  const all = getStats('all');
  assert.equal(all.car.energyWh, 14000);
});

test('getStats("month", 3) returns exactly the pre-retention stored rollup\'s day', () => {
  const month = getStats('month', 3);
  assert.equal(month.car.energyWh, 7000);
});
