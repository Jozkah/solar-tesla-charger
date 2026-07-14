# Daily Stats Rollups + Home Periods + Pause-Hides-Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Day/Week/Month stats switch instantly by folding immutable per-day rollups instead of re-integrating every sample, then add period navigation to the home dashboard and hide the charger controls that do nothing while paused.

**Architecture:** A `daily_stats` table stores one pre-aggregated row per completed day. `week`/`month`/`all` fold those rows; only today is computed live from `samples`. The per-day computation and the fold are pure functions over plain arrays, so they are unit-testable without a database. The period nav moves from `public/app.js` into a shared `public/period-nav.js` that both pages load.

**Tech Stack:** Node 18+ ESM, Express, `node:sqlite` (`DatabaseSync`, **synchronous**), `node:test` (built-in, no new dependency), vanilla browser JS + Tailwind CDN, Playwright for browser checks.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-stats-rollups-and-ui-design.md`. Read it before starting.
- Branch: `hd-stats-rollups`, off `home-dashboard`. **Never target `main`** — `home-dashboard` is what the production PC runs.
- `node:sqlite`'s `DatabaseSync` is synchronous: any query blocks the ~2s live loop and the SSE feed. Never add a query to a hot path that scans a whole range.
- Solar generation stays **unfloored** in stats. Do not "fix" this — `solax_w` lags the live grid columns by minutes, so flooring biases an energy total upward. See the comment in `server/stats.js`.
- Today (`day_ts >= startOfToday`) must **never** be written to `daily_stats`.
- Match existing style: 2-space indent, single quotes, semicolons, `_` numeric separators (`3_600_000`). Comments explain *why*, not *what*.
- No new npm dependencies.
- Do not start a server against real hardware. Isolated boot only (Task 9).

---

### Task 1: Pure per-day rollup computation

**Files:**
- Create: `server/rollup.js` (pure math, **no imports**)
- Create: `test/rollup.test.js`
- Modify: `package.json` (add `test` script)

**Why a new file rather than adding to `server/stats.js`:** `stats.js` imports
`config.js` (which reads `config.json`) and `db.js` (which opens SQLite at import
time). `config.json` is gitignored, so importing `stats.js` from a test crashes in
any fresh clone, and it would open a database as a side effect of a unit test.
`server/rollup.js` must import nothing — that is what makes it testable.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeDayRollup(rows, dayStart, dayEnd) -> rollup`, where `rollup` is
  `{ day_ts, samples, car_wh, car_solar_wh, car_grid_wh, peak_w, peak_amps, charging_samples, adjustments, solar2_wh, solax_wh, export_wh, import_wh, used_wh }`.
  `rows` is a time-ordered sample array that may include one sample **before** `dayStart` (seeds `prevAmps`, its interval is not counted) and the first sample **at or after** `dayEnd` (closes the final interval).

- [ ] **Step 1: Add the test script to `package.json`**

In the `"scripts"` block, add `test` alongside the existing entries:

```json
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/rollup.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayRollup } from '../server/rollup.js';

const DAY = 86_400_000;
const d0 = new Date(2026, 0, 5).setHours(0, 0, 0, 0); // local midnight

// One sample every 10s, matching the production poll interval.
function sample(ts, o = {}) {
  return {
    ts,
    grid_power: 0, export_w: 0, import_w: 0, solar2_w: 0, solax_w: 0,
    charge_w: 0, charge_amps: null, charging: 0, ...o,
  };
}

// NOTE ON INTERVAL LENGTHS: integrate() skips any interval longer than 0.5h as
// a gap, and computeDayRollup must keep that behavior. Every sample spacing
// below is <= 30 minutes on purpose. Do not "fix" the 0.5h threshold to make a
// test pass — it is established production behavior and changing it would
// silently alter every energy figure on the dashboard.

test('sums energy from the left sample of each interval', () => {
  // Two 30-minute intervals at 1000 W => 500 + 500 = 1000 Wh. The third sample
  // only closes the second interval and contributes no energy of its own.
  const rows = [
    sample(d0, { charge_w: 1000, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 1000, charging: 1 }),
    sample(d0 + 3_600_000, { charge_w: 0 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_wh), 1000);
  assert.equal(r.samples, 3);
  assert.equal(r.peak_w, 1000);
});

test('skips gaps longer than 30 minutes', () => {
  const rows = [
    sample(d0, { charge_w: 1000 }),
    sample(d0 + 3_600_000 * 2, { charge_w: 1000 }), // 2h gap => not counted
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_wh), 0);
});

test('does not count the lookbehind sample interval or its peak', () => {
  // The lookbehind sample belongs to the previous day: its 9000 W peak and its
  // interval must not leak into this day. One 30-minute in-day interval at
  // 1000 W => 500 Wh.
  const rows = [
    sample(d0 - 10_000, { charge_w: 9000, charge_amps: 32, charging: 1 }),
    sample(d0, { charge_w: 1000, charge_amps: 16, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 1000, charge_amps: 16, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.peak_w, 1000);
  assert.equal(r.samples, 2);
  assert.equal(Math.round(r.car_wh), 500);
});

test('seeds prevAmps from the lookbehind sample so midnight does not miscount', () => {
  // Overnight charge crossing midnight at a steady 32 A. Without the seed the
  // first in-day sample would look like a fresh adjustment.
  const rows = [
    sample(d0 - 10_000, { charge_w: 7000, charge_amps: 32, charging: 1 }),
    sample(d0, { charge_w: 7000, charge_amps: 32, charging: 1 }),
    sample(d0 + 10_000, { charge_w: 7000, charge_amps: 32, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.adjustments, 0);
});

test('counts a real amp change after midnight as one adjustment', () => {
  const rows = [
    sample(d0 - 10_000, { charge_amps: 32, charging: 1 }),
    sample(d0, { charge_amps: 32, charging: 1 }),
    sample(d0 + 10_000, { charge_amps: 20, charging: 1 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(r.adjustments, 1);
});

test('splits car energy into solar and grid shares', () => {
  // 2000 W charge with 500 W imported, over 30 minutes => 250 Wh grid,
  // 750 Wh solar.
  const rows = [
    sample(d0, { charge_w: 2000, import_w: 500, charging: 1 }),
    sample(d0 + 1_800_000, { charge_w: 0 }),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.car_grid_wh), 250);
  assert.equal(Math.round(r.car_solar_wh), 750);
});

test('house consumption is generation plus grid power, floored at zero', () => {
  // Growatt generation reads negative; solax reads positive. Over 30 minutes:
  // 1500 W generated - 200 W exported = 1300 W consumed => 650 Wh.
  const rows = [
    sample(d0, { solar2_w: -1000, solax_w: 500, grid_power: -200 }),
    sample(d0 + 1_800_000, {}),
  ];
  const r = computeDayRollup(rows, d0, d0 + DAY);
  assert.equal(Math.round(r.solar2_wh), 500);
  assert.equal(Math.round(r.solax_wh), 250);
  assert.equal(Math.round(r.used_wh), 650);
});

test('returns a zero row for a day with no samples', () => {
  const r = computeDayRollup([], d0, d0 + DAY);
  assert.equal(r.day_ts, d0);
  assert.equal(r.samples, 0);
  assert.equal(r.car_wh, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module ... server/rollup.js`

- [ ] **Step 4: Implement `computeDayRollup`**

Create `server/rollup.js`. It imports nothing — that is deliberate, see the note above:

```js
// One day's aggregates, computed in a single pass.
//
// `rows` must be time-ordered and may include two samples outside the day:
//   * one BEFORE dayStart — seeds prevAmps so an overnight charge crossing
//     midnight isn't miscounted as a fresh adjustment. Its interval is not
//     counted; it belongs to the previous day.
//   * the first sample AT/AFTER dayEnd — closes the day's final interval.
// Each interval is valued by its LEFT sample and attributed to that sample's
// day, matching integrate(), so a week folded from days equals the same week
// integrated whole.
export function computeDayRollup(rows, dayStart, dayEnd) {
  const out = {
    day_ts: dayStart,
    samples: 0,
    car_wh: 0, car_solar_wh: 0, car_grid_wh: 0,
    peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0,
    solar2_wh: 0, solax_wh: 0, export_wh: 0, import_wh: 0, used_wh: 0,
  };
  let prevAmps = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const inDay = r.ts >= dayStart && r.ts < dayEnd;

    // prevAmps tracks across the boundary; only in-day changes are counted.
    if (r.charging) {
      if (inDay && prevAmps != null && r.charge_amps != null && r.charge_amps !== prevAmps) out.adjustments++;
      prevAmps = r.charge_amps;
    }
    if (!inDay) continue;

    out.samples++;
    if ((r.charge_w || 0) > out.peak_w) out.peak_w = r.charge_w;
    if ((r.charge_amps || 0) > out.peak_amps) out.peak_amps = r.charge_amps;
    if (r.charging) out.charging_samples++;

    const next = rows[i + 1];
    if (!next) continue;
    const dtH = (next.ts - r.ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue; // skip gaps

    const cw = Math.max(0, r.charge_w || 0);
    out.car_wh += cw * dtH;
    if (cw > 0) {
      const gridShare = (r.import_w || 0) > 0 ? Math.min(r.import_w, cw) : 0;
      out.car_grid_wh += gridShare * dtH;
      out.car_solar_wh += (cw - gridShare) * dtH;
    }
    const growatt = -Math.min(0, r.solar2_w || 0); // generation reads negative
    const solax = Math.max(0, r.solax_w || 0);
    out.solar2_wh += growatt * dtH;
    out.solax_wh += solax * dtH;
    out.export_wh += Math.max(0, r.export_w || 0) * dtH;
    out.import_wh += Math.max(0, r.import_w || 0) * dtH;
    out.used_wh += Math.max(0, growatt + solax + (r.grid_power || 0)) * dtH;
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 8 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json test/rollup.test.js server/rollup.js
git commit -m "feat(stats): pure per-day rollup computation"
```

---

### Task 2: Fold rollups into a range total

**Files:**
- Modify: `server/rollup.js` (add exported `foldRollups`)
- Modify: `test/rollup.test.js`

**Interfaces:**
- Consumes: `computeDayRollup` from Task 1.
- Produces: `foldRollups(days) -> totals` with the same field names as a rollup (minus `day_ts`). Energies, `samples`, `charging_samples` and `adjustments` sum; `peak_w` and `peak_amps` take a max.

- [ ] **Step 1: Write the failing test**

Append to `test/rollup.test.js`:

```js
import { foldRollups } from '../server/rollup.js';

test('fold sums energies and maxes peaks', () => {
  const a = { day_ts: 1, samples: 2, car_wh: 100, car_solar_wh: 60, car_grid_wh: 40,
    peak_w: 3000, peak_amps: 16, charging_samples: 5, adjustments: 1,
    solar2_wh: 10, solax_wh: 5, export_wh: 7, import_wh: 3, used_wh: 20 };
  const b = { day_ts: 2, samples: 3, car_wh: 200, car_solar_wh: 150, car_grid_wh: 50,
    peak_w: 7000, peak_amps: 32, charging_samples: 6, adjustments: 2,
    solar2_wh: 20, solax_wh: 5, export_wh: 3, import_wh: 1, used_wh: 30 };
  const t = foldRollups([a, b]);
  assert.equal(t.samples, 5);
  assert.equal(t.car_wh, 300);
  assert.equal(t.car_solar_wh, 210);
  assert.equal(t.adjustments, 3);
  assert.equal(t.peak_w, 7000);   // max, not sum
  assert.equal(t.peak_amps, 32);  // max, not sum
  assert.equal(t.used_wh, 50);
});

test('fold of nothing is all zeros', () => {
  const t = foldRollups([]);
  assert.equal(t.samples, 0);
  assert.equal(t.car_wh, 0);
  assert.equal(t.peak_w, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — no export named `foldRollups`.

- [ ] **Step 3: Implement `foldRollups`**

In `server/rollup.js`, after `computeDayRollup`:

```js
// Combine day rollups into one range total. Peaks take a max; everything else
// sums. Ratios (solarPct) and chargingMinutes are derived by the caller from
// the summed parts — never averaged across days.
export function foldRollups(days) {
  const out = {
    samples: 0,
    car_wh: 0, car_solar_wh: 0, car_grid_wh: 0,
    peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0,
    solar2_wh: 0, solax_wh: 0, export_wh: 0, import_wh: 0, used_wh: 0,
  };
  for (const d of days) {
    out.samples += d.samples;
    out.car_wh += d.car_wh;
    out.car_solar_wh += d.car_solar_wh;
    out.car_grid_wh += d.car_grid_wh;
    out.charging_samples += d.charging_samples;
    out.adjustments += d.adjustments;
    out.solar2_wh += d.solar2_wh;
    out.solax_wh += d.solax_wh;
    out.export_wh += d.export_wh;
    out.import_wh += d.import_wh;
    out.used_wh += d.used_wh;
    out.peak_w = Math.max(out.peak_w, d.peak_w || 0);
    out.peak_amps = Math.max(out.peak_amps, d.peak_amps || 0);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add test/rollup.test.js server/rollup.js
git commit -m "feat(stats): fold day rollups into a range total"
```

---

### Task 3: Equivalence — folded days must equal the whole range

This is the load-bearing check. If it fails, the rollups are silently wrong and every number on the dashboard is wrong with them.

**Files:**
- Create: `test/equivalence.test.js`

**Interfaces:**
- Consumes: `computeDayRollup`, `foldRollups`.
- Produces: nothing. Test-only.

- [ ] **Step 1: Write the test**

Create `test/equivalence.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDayRollup, foldRollups } from '../server/rollup.js';

const DAY = 86_400_000;
const START = new Date(2026, 0, 5).setHours(0, 0, 0, 0); // Monday, local

// Reference implementation: the whole-range math as it exists today, copied
// verbatim in spirit from getStats. The rollup fold must reproduce it exactly.
function referenceWholeRange(rows) {
  const out = { car_wh: 0, car_solar_wh: 0, car_grid_wh: 0, peak_w: 0, peak_amps: 0,
    charging_samples: 0, adjustments: 0, solar2_wh: 0, solax_wh: 0,
    export_wh: 0, import_wh: 0, used_wh: 0, samples: rows.length };
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const r = rows[i - 1];
    const cw = Math.max(0, r.charge_w || 0);
    out.car_wh += cw * dtH;
    if (cw > 0) {
      const gridShare = (r.import_w || 0) > 0 ? Math.min(r.import_w, cw) : 0;
      out.car_grid_wh += gridShare * dtH;
      out.car_solar_wh += (cw - gridShare) * dtH;
    }
    const growatt = -Math.min(0, r.solar2_w || 0);
    const solax = Math.max(0, r.solax_w || 0);
    out.solar2_wh += growatt * dtH;
    out.solax_wh += solax * dtH;
    out.export_wh += Math.max(0, r.export_w || 0) * dtH;
    out.import_wh += Math.max(0, r.import_w || 0) * dtH;
    out.used_wh += Math.max(0, growatt + solax + (r.grid_power || 0)) * dtH;
  }
  let prevAmps = null;
  for (const r of rows) {
    if ((r.charge_w || 0) > out.peak_w) out.peak_w = r.charge_w;
    if ((r.charge_amps || 0) > out.peak_amps) out.peak_amps = r.charge_amps;
    if (r.charging) out.charging_samples++;
    if (r.charging && prevAmps != null && r.charge_amps != null && r.charge_amps !== prevAmps) out.adjustments++;
    if (r.charging) prevAmps = r.charge_amps;
  }
  return out;
}

// Three days at a 10s poll with an overnight charge that runs 22:00 -> 06:00
// across BOTH midnights, changing amps a few times. This is the shape that
// breaks a naive per-day rollup.
function buildSamples() {
  const rows = [];
  for (let t = START; t < START + 3 * DAY; t += 10_000) {
    const hour = new Date(t).getHours();
    const overnight = hour >= 22 || hour < 6;
    const amps = overnight ? (hour % 3 === 0 ? 20 : 32) : null;
    const sun = hour > 8 && hour < 18 ? -2000 : 0;
    rows.push({
      ts: t,
      grid_power: overnight ? 7000 : sun / 2,
      export_w: overnight ? 0 : Math.max(0, -sun / 2),
      import_w: overnight ? 7000 : 0,
      solar2_w: sun,
      solax_w: overnight ? 0 : 800,
      charge_w: overnight ? amps * 230 : 0,
      charge_amps: amps,
      charging: overnight ? 1 : 0,
    });
  }
  return rows;
}

// The samples a day's rollup gets: its own, plus one lookbehind and one lookahead.
function windowFor(rows, dayStart, dayEnd) {
  const inDay = rows.filter((r) => r.ts >= dayStart && r.ts < dayEnd);
  const before = rows.filter((r) => r.ts < dayStart).slice(-1);
  const after = rows.find((r) => r.ts >= dayEnd);
  return [...before, ...inDay, ...(after ? [after] : [])];
}

test('folded days equal the same range integrated whole', () => {
  const rows = buildSamples();
  const days = [0, 1, 2].map((i) => {
    const s = START + i * DAY;
    return computeDayRollup(windowFor(rows, s, s + DAY), s, s + DAY);
  });
  const folded = foldRollups(days);
  const whole = referenceWholeRange(rows);

  for (const k of ['car_wh', 'car_solar_wh', 'car_grid_wh', 'solar2_wh', 'solax_wh',
                   'export_wh', 'import_wh', 'used_wh']) {
    assert.ok(Math.abs(folded[k] - whole[k]) < 0.01, `${k}: ${folded[k]} != ${whole[k]}`);
  }
  for (const k of ['samples', 'charging_samples', 'adjustments', 'peak_w', 'peak_amps']) {
    assert.equal(folded[k], whole[k], `${k}: ${folded[k]} != ${whole[k]}`);
  }
});

test('adjustments across midnight match the whole-range count exactly', () => {
  // Guards the prevAmps seed specifically: this is the field a naive per-day
  // rollup gets wrong, once per boundary, only when a charge spans midnight.
  const rows = buildSamples();
  const days = [0, 1, 2].map((i) => {
    const s = START + i * DAY;
    return computeDayRollup(windowFor(rows, s, s + DAY), s, s + DAY);
  });
  assert.equal(foldRollups(days).adjustments, referenceWholeRange(rows).adjustments);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test`
Expected: PASS — 12 tests total.

If the equivalence test fails, **do not adjust the test to match the code.** The reference implementation is the current production behavior; a mismatch means `computeDayRollup` is wrong. Fix Task 1's implementation.

- [ ] **Step 3: Commit**

```bash
git add test/equivalence.test.js
git commit -m "test(stats): folded days must equal the whole range integrated"
```

---

### Task 4: `daily_stats` table and persistence

**Files:**
- Modify: `server/db.js` (schema + queries)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `queries.dayRollup` — `SELECT * FROM daily_stats WHERE day_ts = ?`
  - `queries.firstRollupDay` — `SELECT MIN(day_ts) AS day_ts FROM daily_stats`
  - `queries.firstSampleTs` — `SELECT MIN(ts) AS ts FROM samples`
  - `queries.sampleBefore` — `SELECT * FROM samples WHERE ts < ? ORDER BY ts DESC LIMIT 1`
  - `queries.sampleAtOrAfter` — `SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC LIMIT 1`
  - `saveDayRollup(r)` — upsert one rollup row.

- [ ] **Step 1: Add the schema**

In `server/db.js`, next to the existing `CREATE TABLE` statements, add:

```sql
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
```

Note: `pruneOld` deletes old `samples` but must **not** touch `daily_stats` — the rollups are the only surviving record once samples age out. Do not add a prune for this table.

- [ ] **Step 2: Add the queries**

In the `queries` object in `server/db.js`, alongside `samplesBetween`:

```js
  sampleBefore: db.prepare('SELECT * FROM samples WHERE ts < ? ORDER BY ts DESC LIMIT 1'),
  sampleAtOrAfter: db.prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC LIMIT 1'),
  dayRollup: db.prepare('SELECT * FROM daily_stats WHERE day_ts = ?'),
  firstRollupDay: db.prepare('SELECT MIN(day_ts) AS day_ts FROM daily_stats'),
  firstSampleTs: db.prepare('SELECT MIN(ts) AS ts FROM samples'),
```

- [ ] **Step 3: Add the upsert**

In `server/db.js`, near `updateSession`:

```js
const saveDayRollupStmt = db.prepare(`
  INSERT INTO daily_stats
    (day_ts, samples, car_wh, car_solar_wh, car_grid_wh, peak_w, peak_amps,
     charging_samples, adjustments, solar2_wh, solax_wh, export_wh, import_wh, used_wh)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day_ts) DO UPDATE SET
    samples=excluded.samples, car_wh=excluded.car_wh, car_solar_wh=excluded.car_solar_wh,
    car_grid_wh=excluded.car_grid_wh, peak_w=excluded.peak_w, peak_amps=excluded.peak_amps,
    charging_samples=excluded.charging_samples, adjustments=excluded.adjustments,
    solar2_wh=excluded.solar2_wh, solax_wh=excluded.solax_wh, export_wh=excluded.export_wh,
    import_wh=excluded.import_wh, used_wh=excluded.used_wh
`);

// Persist one completed day's rollup. Callers must never pass today — a
// partially-elapsed day would be frozen at its mid-day value.
export function saveDayRollup(r) {
  saveDayRollupStmt.run(
    r.day_ts, r.samples, r.car_wh, r.car_solar_wh, r.car_grid_wh, r.peak_w, r.peak_amps,
    r.charging_samples, r.adjustments, r.solar2_wh, r.solax_wh, r.export_wh, r.import_wh, r.used_wh,
  );
}
```

- [ ] **Step 4: Verify the schema loads**

Run: `node -e "import('./server/db.js').then(() => console.log('db ok'))"`
Expected: prints `db ok` (an `ExperimentalWarning` about SQLite is normal).

- [ ] **Step 5: Commit**

```bash
git add server/db.js
git commit -m "feat(db): daily_stats rollup table, queries and upsert"
```

---

### Task 5: Wire `getStats` to the rollups

**Files:**
- Modify: `server/stats.js` (`getStats`)

**Interfaces:**
- Consumes: `computeDayRollup`, `foldRollups`, and the Task 4 queries.
- Produces: `getStats(range, offset)` with an unchanged response shape. `home.js` depends on `?range=today` returning a full `home` block — do not change it.

- [ ] **Step 1: Add the day-rollup accessor**

In `server/stats.js`, after `foldRollups`:

```js
// One day's rollup: stored rows for completed days, live compute for today.
// A completed day is immutable, so it's computed once and kept forever — this
// is what makes week/month/all cheap.
function dayRollup(dayStart) {
  const dayEnd = dayStart + 86_400_000;
  const isToday = dayStart >= startOfTodayMs();
  if (!isToday) {
    const hit = queries.dayRollup.get(dayStart);
    if (hit) return hit;
  }
  const before = queries.sampleBefore.get(dayStart);   // seeds prevAmps
  const after = queries.sampleAtOrAfter.get(dayEnd);   // closes the last interval
  const rows = [
    ...(before ? [before] : []),
    ...queries.samplesBetween.all(dayStart, dayEnd),
    ...(after ? [after] : []),
  ];
  const r = computeDayRollup(rows, dayStart, dayEnd);
  // Never freeze a day that's still running. Empty days are stored too, so a
  // day the server was off isn't recomputed on every future view.
  if (!isToday) saveDayRollup(r);
  return r;
}

// Fold every day in [since, until) — the calendar ranges.
function rollupRange(since, until) {
  const days = [];
  for (let d = since; d < until; d += 86_400_000) days.push(dayRollup(d));
  return foldRollups(days);
}

function startOfDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 'all' spans from the earliest thing we know about — a stored rollup (whose
// samples may already be pruned) or the oldest surviving sample, whichever is
// older — through today. Going day-by-day rather than reading only the stored
// rollups matters: a day that was never viewed has no row yet, and folding
// only stored rows would silently drop it.
function allTimeTotals() {
  const firstRollup = queries.firstRollupDay.get()?.day_ts ?? null;
  const firstSample = queries.firstSampleTs.get()?.ts ?? null;
  const starts = [firstRollup, firstSample == null ? null : startOfDayMs(firstSample)]
    .filter((v) => v != null);
  if (!starts.length) return foldRollups([]); // empty database
  return rollupRange(Math.min(...starts), startOfTodayMs() + 86_400_000);
}
```

Update the imports at the top of `server/stats.js` — `saveDayRollup` from `db.js`, and
the pure math from the new `rollup.js`:

```js
import { queries, currentSession, saveDayRollup } from './db.js';
import config from './config.js';
import { computeDayRollup, foldRollups } from './rollup.js';
```

- [ ] **Step 2: Route the calendar ranges through the rollups**

In `getStats`, replace the row-fetch and the five integration passes for the rollup-backed ranges. The `session`/`today`/`all` handling and the response shape stay as they are, except `all` now folds rollups.

Replace the body from `const rows = ...` down to (but not including) `const session = currentSession();` with:

```js
  const peakAll = queries.peakAllTime.get() || {};

  // Calendar ranges fold immutable per-day rollups; session/today stay live.
  let t;
  let sampleCount;
  if (bounds) {
    t = rollupRange(since, Math.min(until, startOfTodayMs() + 86_400_000));
    sampleCount = t.samples;
  } else if (range === 'all') {
    // Every day we have any record of. Rollups outlive the sample prune, so
    // 'all' now covers more than the sampleRetentionDays window the samples
    // table holds — but it must also include sample days never rolled up yet,
    // or a day nobody happened to view would vanish from the total.
    t = allTimeTotals();
    sampleCount = t.samples;
  } else {
    const rows = queries.samplesSince.all(since);
    t = computeDayRollup(rows, since, now + 1);
    sampleCount = rows.length;
  }

  const carWh = t.car_wh;
  const carSolarWh = t.car_solar_wh;
  const carGridWh = t.car_grid_wh;
  const exportWh = t.export_wh;
  const importWh = t.import_wh;
  const solar2Wh = t.solar2_wh;
  const solaxWh = t.solax_wh;
  const usedWh = t.used_wh;
  // Total solar generation = Growatt clamp (generation is negative) + SolaX cloud.
  // Deliberately NOT floored by the energy balance the way the live dashboard tile
  // is: solax_w is a cloud reading minutes behind the live grid/charge columns, so
  // per-sample max(measured, balance) would grab each ramp peak without the
  // matching trough and bias the total up (~+7% over the June history). The floor
  // fixes an instantaneous display; an energy total has to stay measured.
  const solarGenWh = solar2Wh + solaxWh;
  const peakW = t.peak_w;
  const peakAmps = t.peak_amps;
  const chargingMinutes = Math.round(t.charging_samples * config.control.pollIntervalSec / 60);
  const adjustments = t.adjustments;
```

Then update the response to use `sampleCount`:

```js
    samples: sampleCount,
```

Delete the now-unused `integrate` helper and the old inline loops if nothing else references them. Run `grep -n "integrate(" server/stats.js` — if `getSeries` doesn't use it, remove it.

Note: `session`/`today` reuse `computeDayRollup` with the range as its own "day" and `now + 1` as the end. `dayStart`/`dayEnd` are only used for the in-range test, so this computes the whole span in one pass — no lookbehind seed, matching today's behavior for those ranges.

- [ ] **Step 3: Verify the numbers are unchanged**

Copy the real DB and compare old vs new for a past range:

```bash
cp "/c/Users/Jozkah/Desktop/Coding/energy-monitoring-home/data/energy.db" data/energy.db
node --input-type=module -e "
const { getStats } = await import('./server/stats.js');
for (const [r,o] of [['day',1],['week',0],['month',1],['all',0],['today',0],['session',0]]) {
  const s = getStats(r,o);
  console.log(r, o, 'n='+s.samples, 'car='+(s.car.energyWh/1000).toFixed(3), 'gen='+(s.home.solarGeneratedWh/1000).toFixed(3), 'used='+(s.home.usedWh/1000).toFixed(3));
}
"
```

Expected: the same figures as `git stash && <rerun> && git stash pop` produces on the pre-change code, to 3 decimals. `all` may now report **more** than before if rollups exist for pruned days — that is the intended behavior change.

- [ ] **Step 4: Verify `all` counts days that were never viewed**

`all` must not depend on which periods happen to have been browsed. Starting from
a database with no `daily_stats` rows at all, `all` must match the pre-change
number immediately:

```bash
node --input-type=module -e "
const { getStats } = await import('./server/stats.js');
const { queries } = await import('./server/db.js');
console.log('rollup rows before:', queries.firstRollupDay.get()?.day_ts ?? 'none');
const cold = getStats('all').car.energyWh;   // no rollups exist yet
const warm = getStats('all').car.energyWh;   // now they all do
console.log('cold', Math.round(cold), '| warm', Math.round(warm), '| equal:', Math.round(cold) === Math.round(warm));
"
```

Expected: `equal: true`, and the value matches the pre-change `all`. Run it against a
**fresh copy** of the DB (delete `data/energy.db` and re-copy first) so no rollups
are pre-seeded — that is the whole point of the check.

- [ ] **Step 5: Verify it got fast**

```bash
node --input-type=module -e "
const { getStats } = await import('./server/stats.js');
getStats('month', 1); // warm the rollups
const t = process.hrtime.bigint(); getStats('month', 1); const t2 = process.hrtime.bigint();
console.log('warm month:', Number(t2-t)/1e6, 'ms');
"
```

Expected: under 10ms warm.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS — 12 tests.

- [ ] **Step 6: Commit**

```bash
git add server/stats.js
git commit -m "perf(stats): fold day rollups for calendar ranges instead of re-integrating"
```

---

### Task 6: Extract the shared period nav

**Files:**
- Create: `public/period-nav.js`
- Modify: `public/app.js` (remove the inline nav, use the module)
- Modify: `public/index.html` (load the module before `app.js`)

**Interfaces:**
- Consumes: nothing.
- Produces: global `createPeriodNav({ navEl, labelEl, prevEl, nextEl, segEl, onData })` returning `{ refresh() }`. It owns the range/offset state, the fetch, the stale-response guard, the `MAX_OFFSET` clamp and the label text; the caller only renders `onData(stats)`.

- [ ] **Step 1: Create the module**

Create `public/period-nav.js`:

```js
// Shared period navigation for the stats blocks on /charger and /.
// Owns range + offset state, fetching, and the label; callers just render.
(function () {
  const PERIOD_RANGES = ['day', 'week', 'month'];
  // Matches the server's clamp — past it the response echoes a different offset
  // and the stale-response guard would drop every update.
  const MAX_OFFSET = 1000;

  function periodLabel(st) {
    if (!PERIOD_RANGES.includes(st.range)) return '';
    const since = new Date(st.since);
    if (st.range === 'day') {
      if (st.offset === 0) return 'Today';
      if (st.offset === 1) return 'Yesterday';
      return since.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }
    if (st.range === 'week') {
      if (st.offset === 0) return 'This week';
      const end = new Date(st.until - 86400_000);
      const s = since.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const e = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `${s} – ${e}`;
    }
    if (st.offset === 0) return 'This month';
    return since.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // navEl/labelEl/prevEl/nextEl required; segEl optional (pages without a
  // range switcher just navigate within one range).
  window.createPeriodNav = function createPeriodNav({ navEl, labelEl, prevEl, nextEl, segEl, onData, initialRange = 'day' }) {
    let range = initialRange;
    let offset = 0;

    async function refresh() {
      let st;
      try {
        st = await (await fetch(`/api/stats?range=${range}&offset=${offset}`)).json();
      } catch { return; }
      // Stale response from a range/offset the user already navigated away from.
      if (st.range !== range || (PERIOD_RANGES.includes(range) && st.offset !== offset)) return;

      const isPeriod = PERIOD_RANGES.includes(range);
      if (navEl) navEl.hidden = !isPeriod;
      if (isPeriod && labelEl) labelEl.textContent = periodLabel(st);
      if (isPeriod && nextEl) {
        nextEl.disabled = offset === 0;
        nextEl.style.opacity = offset === 0 ? '.35' : '1';
      }
      onData(st);
    }

    if (prevEl) prevEl.addEventListener('click', () => { if (offset < MAX_OFFSET) { offset++; refresh(); } });
    if (nextEl) nextEl.addEventListener('click', () => { if (offset > 0) { offset--; refresh(); } });
    if (segEl) {
      segEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        range = b.dataset.range;
        offset = 0;
        segEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        refresh();
      }));
    }
    return { refresh };
  };
})();
```

- [ ] **Step 2: Load it in `index.html`**

In `public/index.html`, before the `app.js` script tag:

```html
  <script src="/period-nav.js"></script>
```

- [ ] **Step 3: Replace the inline nav in `app.js`**

Delete from `public/app.js`: the `PERIOD_RANGES` const, `periodLabel`, the `range`/`statsOffset` module variables, the `MAX_OFFSET` const, the `#rangeSeg` click handler, and the `periodPrev`/`periodNext` handlers. Replace `refreshStats` with:

```js
const statsNav = createPeriodNav({
  navEl: $('periodNav'), labelEl: $('periodLabel'),
  prevEl: $('periodPrev'), nextEl: $('periodNext'), segEl: $('rangeSeg'),
  onData: renderStats,
});
const refreshStats = () => statsNav.refresh();

// Car-focused tiles only — the whole-home totals live on the home dashboard.
function renderStats(st) {
  const c = st.car || {};
  const cells = [
    ['Charged', fmtKwh(c.energyWh), 'kWh'],
    ['Using solar', fmtKwh(c.solarWh), 'kWh'],
    ['Using grid', fmtKwh(c.gridWh), 'kWh'],
    ['From solar', c.solarPct != null ? c.solarPct : '–', '%'],
    ['Peak', ((c.peakW || 0) / 1000).toFixed(1), 'kW'],
    ['Peak amps', c.peakAmps || 0, 'A'],
    ['Charge time', fmtDur(c.chargingMinutes), ''],
    ['Adjusts', c.adjustments || 0, ''],
  ];
  $('statsGrid').innerHTML = cells.map(([k, v, u]) =>
    `<div class="glass rounded-2xl p-3.5 flex flex-col gap-1">
       <span class="text-[10px] font-semibold text-mut uppercase tracking-wider">${k}</span>
       <span class="text-[15px] font-bold tnum">${v}<span class="text-[11px] font-normal text-mut"> ${u}</span></span>
     </div>`).join('');
}
```

The existing `refreshStats()` boot call and `setInterval(refreshStats, 15000)` keep working unchanged.

- [ ] **Step 4: Verify no leftover references**

Run: `grep -nE "statsOffset|PERIOD_RANGES|periodLabel|MAX_OFFSET" public/app.js`
Expected: no output.

Run: `node --check public/app.js && node --check public/period-nav.js`
Expected: no output (both parse).

- [ ] **Step 5: Commit**

```bash
git add public/period-nav.js public/app.js public/index.html
git commit -m "refactor(ui): extract the period nav into a shared module"
```

---

### Task 7: Period navigation on the home dashboard

**Files:**
- Modify: `public/home.html` (TODAY header -> period nav + range seg)
- Modify: `public/home.js` (use `createPeriodNav`)

**Interfaces:**
- Consumes: `createPeriodNav` from Task 6.
- Produces: nothing.

- [ ] **Step 1: Replace the TODAY header in `home.html`**

`public/home.html:152` currently reads:

```html
    <div class="text-[11px] font-bold tracking-widest text-mut mt-4 mb-2 px-1">TODAY</div>
```

Replace it with a range switcher plus the nav. Session/All are car concepts and are deliberately absent:

```html
    <div class="seg mt-4 mb-2" id="homeRangeSeg">
      <button data-range="day" class="active">Day</button>
      <button data-range="week">Week</button>
      <button data-range="month">Month</button>
    </div>
    <div id="homePeriodNav" class="flex justify-between items-center px-1 mb-2" hidden>
      <button id="homePeriodPrev" class="lg-btn lg-btn-ghost px-4 py-1.5 text-[15px]">‹</button>
      <span id="homePeriodLabel" class="text-[13px] font-semibold"></span>
      <button id="homePeriodNext" class="lg-btn lg-btn-ghost px-4 py-1.5 text-[15px]">›</button>
    </div>
```

Then add the module before `home.js`'s script tag:

```html
  <script src="/period-nav.js"></script>
```

Check that `home.html` has the `[hidden] { display:none !important; }` rule that `index.html` has — without it Tailwind's `.flex` outranks `[hidden]` and `homePeriodNav` will never hide. Run `grep -n "\[hidden\]" public/home.html`; if absent, add it to the `<style>` block:

```css
  /* Tailwind's display utilities (.flex etc.) outrank preflight's [hidden] rule,
     so el.hidden alone would not hide an element that carries one. */
  [hidden] { display:none !important; }
```

- [ ] **Step 2: Rewrite `loadStats` in `home.js`**

Replace the `loadStats` function (`public/home.js:478-486`) with:

```js
const statsNav = createPeriodNav({
  navEl: $('homePeriodNav'), labelEl: $('homePeriodLabel'),
  prevEl: $('homePeriodPrev'), nextEl: $('homePeriodNext'), segEl: $('homeRangeSeg'),
  onData: renderStats,
});
function loadStats() { statsNav.refresh(); }

function renderStats(st) {
  const h = st.home || {};
  $('stSolarGen').textContent = fmtKwh(h.solarGeneratedWh);
  $('stExported').textContent = fmtKwh(h.exportedWh);
  $('stImported').textContent = fmtKwh(h.importedWh);
  $('stHouseUsed').textContent = fmtKwh(h.usedWh);
}
```

The existing boot `loadStats()` call and `setInterval(loadStats, 60_000)` keep working. The interval only matters for offset 0; refreshing a past period is harmless.

- [ ] **Step 3: Verify**

Run: `node --check public/home.js`
Expected: no output.

Run: `grep -n "range=today" public/home.js`
Expected: no output — the pinned range is gone.

- [ ] **Step 4: Commit**

```bash
git add public/home.html public/home.js
git commit -m "feat(home): browse whole-home totals by day, week or month"
```

---

### Task 8: Hide the charger controls while paused

**Files:**
- Modify: `public/index.html` (add ids to three cards)
- Modify: `public/app.js` (toggle in the render path)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add ids to the three cards**

In `public/index.html`, add an id to each card's outer `glass` div:

- The amps card containing `ovLabel` / `ovRange` / `ovApply` (`index.html:200`) -> `id="limitCard"`
- The card containing `boostEnabled` (`index.html:220`) -> `id="boostCard"`
- The card containing `schedEnabled` (`index.html:235`) -> `id="schedCard"`

For example the first becomes:

```html
    <div id="limitCard" class="glass rounded-3xl p-5 flex flex-col gap-4">
```

`chargeToggle` already has an id.

- [ ] **Step 2: Toggle them in the render path**

In `public/app.js`, next to the existing line that syncs the mode buttons:

```js
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
```

add:

```js
  // Paused means paused: hide every control that only acts on a live charge.
  // Relies on the [hidden] !important rule — Tailwind's .flex on these cards
  // outranks preflight's [hidden] on its own.
  const paused = s.mode === 'pause';
  for (const id of ['limitCard', 'chargeToggle', 'boostCard', 'schedCard']) $(id).hidden = paused;
```

- [ ] **Step 3: Verify**

Run: `node --check public/app.js`
Expected: no output.

Run: `grep -cE "id=\"(limitCard|boostCard|schedCard)\"" public/index.html`
Expected: `3`

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat(ui): hide charge limit, boost and overnight cards while paused"
```

---

### Task 9: End-to-end verification on an isolated server

Nothing above proves the pages actually render or that the server boots. This task does, without any chance of touching the car.

**Files:**
- None. Verification only.

- [ ] **Step 1: Build an isolated config**

From the worktree root. TEST-NET-1 (RFC 5737) addresses are guaranteed unroutable, so no real meter can answer:

```bash
cp "/c/Users/Jozkah/Desktop/Coding/energy-monitoring-home/data/energy.db" data/energy.db
node -e "
const fs=require('fs');
const c = JSON.parse(fs.readFileSync('C:/Users/Jozkah/Desktop/Coding/energy monitoring/config.json','utf8'));
c.server.port = 3099; c.server.host = '127.0.0.1';
c.shelly.devices.forEach((d,i) => d.ip = '192.0.2.'+(10+i));
c.shelly.timeoutMs = 500;
c.wallconnector.enabled = false; c.solax.enabled = false;
if (c.weather) c.weather.enabled = false;
if (c.kasa) c.kasa.enabled = false;
if (c.cameras) c.cameras.enabled = false;
fs.writeFileSync('config.json', JSON.stringify(c,null,2));
"
```

`config.json` is gitignored, so this cannot be committed by accident. Confirm there is no `.env` in the worktree (`ls -a | grep .env` -> nothing).

- [ ] **Step 2: Boot and confirm the command path is unreachable**

```bash
node server/index.js &
sleep 4
curl -s http://127.0.0.1:3099/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('lastAction:',s.lastAction);})"
```

Expected: `lastAction: waiting for meters`

**This is a safety gate, not a formality.** `controlCycle` returns at `if (!meters)` before any Tesla command. If it says anything else, stop and kill the server — the config did not take.

- [ ] **Step 3: Exercise the API**

```bash
for q in "range=day&offset=0" "range=day&offset=1" "range=week&offset=0" "range=month&offset=1" "range=all" "range=today" "range=session" "range=bogus&offset=-5" "range=month&offset=99999"; do
  echo -n "$q -> "; curl -s "http://127.0.0.1:3099/api/stats?$q" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('range='+s.range,'offset='+s.offset,'n='+s.samples);})"
done
```

Expected: `bogus` -> `range=today offset=0`; `offset=-5` -> `offset=0`; `offset=99999` -> `offset=1000`. No 500s.

- [ ] **Step 4: Drive both pages with Playwright**

Load `http://127.0.0.1:3099/charger`:
- The range seg shows `Session | Day | Week | Month | All`.
- Click Week, then Month — the tiles update and `#periodLabel` reads `This week` / `This month`.
- Click `#periodPrev` — the label moves to the previous period and `#periodNext` becomes enabled.
- Console has no errors other than a `favicon.ico` 404.

Load `http://127.0.0.1:3099/`:
- The range seg shows `Day | Week | Month` where TODAY used to be.
- Stepping prev/next moves the label and the four tiles change.

Pause behavior on `/charger`: with the server isolated, `/api/mode` still flips `state.mode`, so:

```bash
curl -s -X POST http://127.0.0.1:3099/api/mode -H 'Content-Type: application/json' -d '{"mode":"pause"}'
```

Reload `/charger` and confirm the amps card, Start charge, Allow battery limit increase and Overnight charge are all gone, and that switching back to Auto restores them:

```bash
curl -s -X POST http://127.0.0.1:3099/api/mode -H 'Content-Type: application/json' -d '{"mode":"auto"}'
```

- [ ] **Step 5: Stop the server**

```bash
powershell -Command "Get-NetTCPConnection -LocalPort 3099 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
```

Confirm nothing of yours is left running.

- [ ] **Step 6: Open the PR**

Base `home-dashboard`, never `main`:

```bash
git push -u origin hd-stats-rollups
gh pr create --base home-dashboard --head hd-stats-rollups --title "Daily stats rollups, home periods, pause hides controls"
```

The PR body must state what was verified and what was not: the live host is not covered, and `all` now covers more history than the 60-day sample window.

---

## Deployment note

The production PC runs `home-dashboard`. After merging: pull, restart, hard-refresh the browser (`public/*.js` changed). `state.override` and `state.mode` are in-memory, so a restart drops them and the solar-auto loop can cut a live charge — re-assert any active override immediately:

```
POST http://127.0.0.1:3000/api/override {"amps":N}
```

Use `127.0.0.1`, not `localhost` — the server binds IPv4.

## Known-unfixable

Samples recorded before the phantom-charge fix carry inflated `charge_w` (21% of June samples have `charge_w` > 100 W with `charging = 0`). Rollups computed from them inherit it. They cannot be separated from real WC-measured conditioning draw — no source discriminator is stored. Peaks on historical periods will stay wrong; days recorded after that fix are clean.
