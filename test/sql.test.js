import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LAST_CHARGING_SAMPLE_BEFORE } from '../server/sql.js';

// Minimal in-memory schema: the query selects *, but only these three columns
// matter for its WHERE/ORDER BY behavior.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE samples (
      ts          INTEGER PRIMARY KEY,
      charging    INTEGER,
      charge_amps REAL
    );
  `);
  return db;
}

test('returns the last CHARGING sample before ts, not the nearer non-charging one', () => {
  // Reproduces the production shape that broke: an earlier charging sample
  // (amps 9) and a later, closer-to-midnight non-charging sample carrying a
  // stale charge_amps (12). The stale row must be skipped.
  const db = makeDb();
  db.exec('INSERT INTO samples (ts, charging, charge_amps) VALUES (1000, 1, 9)');
  db.exec('INSERT INTO samples (ts, charging, charge_amps) VALUES (2000, 0, 12)');

  const row = db.prepare(LAST_CHARGING_SAMPLE_BEFORE).get(3000);

  assert.equal(row.charging, 1);
  assert.equal(row.charge_amps, 9);
});

test('returns undefined when no charging sample exists before ts', () => {
  const db = makeDb();
  db.exec('INSERT INTO samples (ts, charging, charge_amps) VALUES (1000, 0, 12)');

  const row = db.prepare(LAST_CHARGING_SAMPLE_BEFORE).get(3000);

  assert.equal(row, undefined);
});
