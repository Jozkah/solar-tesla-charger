# Billing Period + Cost Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable **Billing** browse period (billing-day-anchored, variable length) plus a simplified time-of-use **cost estimate**, both driven by an in-dashboard settings UI persisted in SQLite.

**Architecture:** Pure logic (`period.js`, `cost.js`) holds all risk-bearing math with no DB coupling so it is unit-testable in isolation. A thin DB-coupled `settings.js` persists `billingDay` + `tariff` in a new SQLite KV table. `stats.js` feeds the billing window + tariff into the existing energy aggregation to derive cost. `index.js` exposes `GET/POST /api/settings`. Frontend adds a Billing tab, a settings panel, and a Cost tile.

**Tech Stack:** Node ≥22 (ESM), `node:sqlite` (`DatabaseSync`), Express 4, `node:test` + `node:assert` for tests, vanilla JS + Tailwind CDN frontend.

## Global Constraints

- ESM only (`"type": "module"`); use `import`/`export`, no `require`.
- Zero new npm dependencies. Tests use built-in `node:test`.
- Persistence store is the SQLite `settings` KV table only. NEVER write to `config.json` (holds Shelly/WallConnector/SolaX/Tesla secrets).
- Public defaults must be **generic** placeholders — no real provider/user tariff values in committed code.
- Billing day range: integer 1–31; clamp to last day of month for short months.
- Half-open period windows `[since, until)`, matching existing day/week/month.
- Cost currency default `"€"`; VAT is a single flat percent; cost basis is grid import only.
- Commit after each task with a `feat:`/`test:`/`docs:` conventional message.

---

### Task 1: Pure period math — `server/period.js`

Move `periodBounds` out of `stats.js` into a pure module and add the `billing` branch. Deterministic via an injected `now`.

**Files:**
- Create: `server/period.js`
- Create: `test/period.test.js`
- Modify: `server/stats.js:5-37` (remove local `periodBounds`, import + re-export from `period.js`; pass `billingDay` + `now` at call site L58)

**Interfaces:**
- Produces: `periodBounds(range: string, offset?: number, billingDay?: number, now?: number): { since: number, until: number } | null`
- Produces: `daysInMonth(year: number, monthIdx: number): number`, `clampDay(day: number, year: number, monthIdx: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/period.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodBounds, daysInMonth, clampDay } from '../server/period.js';

// A fixed "now": 2026-06-20 12:00 local.
const NOW = new Date(2026, 5, 20, 12, 0, 0, 0).getTime();
const atMidnight = (y, m, d) => new Date(y, m, d, 0, 0, 0, 0).getTime();

test('daysInMonth handles February leap and non-leap', () => {
  assert.equal(daysInMonth(2024, 1), 29);
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2026, 3), 30); // April
});

test('clampDay caps to month length', () => {
  assert.equal(clampDay(31, 2026, 1), 28); // Feb 2026
  assert.equal(clampDay(15, 2026, 1), 15);
});

test('billing offset 0: today past billing day -> starts this month', () => {
  // billingDay 15, today the 20th -> [Jun 15, Jul 15)
  const b = periodBounds('billing', 0, 15, NOW);
  assert.equal(b.since, atMidnight(2026, 5, 15));
  assert.equal(b.until, atMidnight(2026, 6, 15));
});

test('billing offset 0: today before billing day -> starts previous month', () => {
  // billingDay 25, today the 20th -> [May 25, Jun 25)
  const b = periodBounds('billing', 0, 25, NOW);
  assert.equal(b.since, atMidnight(2026, 4, 25));
  assert.equal(b.until, atMidnight(2026, 5, 25));
});

test('billing offset 1 is the immediately-prior contiguous cycle', () => {
  const cur = periodBounds('billing', 0, 15, NOW);
  const prev = periodBounds('billing', 1, 15, NOW);
  assert.equal(prev.until, cur.since); // contiguous
  assert.equal(prev.since, atMidnight(2026, 4, 15)); // May 15
});

test('billing day 31 clamps in short months', () => {
  // today 2026-03-05, billingDay 31, today(5) < clamp(31,Mar)=31 -> prev cycle
  const now = new Date(2026, 2, 5, 12).getTime();
  const b = periodBounds('billing', 0, 31, now);
  assert.equal(b.since, atMidnight(2026, 1, 28)); // Feb 28 (clamped)
  assert.equal(b.until, atMidnight(2026, 2, 31)); // Mar 31
});

test('billing day 1 equals the calendar month', () => {
  const billing = periodBounds('billing', 0, 1, NOW);
  const month = periodBounds('month', 0, 1, NOW);
  assert.equal(billing.since, month.since);
  assert.equal(billing.until, month.until);
});

test('day/week/month unaffected by billingDay and honor injected now', () => {
  const day = periodBounds('day', 0, 15, NOW);
  assert.equal(day.since, atMidnight(2026, 5, 20));
  assert.equal(day.until, atMidnight(2026, 5, 21));
  const month = periodBounds('month', 0, 15, NOW);
  assert.equal(month.since, atMidnight(2026, 5, 1));
  assert.equal(month.until, atMidnight(2026, 6, 1));
});

test('unknown range returns null', () => {
  assert.equal(periodBounds('all', 0, 15, NOW), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/period.test.js`
Expected: FAIL — `Cannot find module '../server/period.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/period.js`:

```js
// Pure period-boundary math (no DB / config coupling) so it is unit-testable.
// [since, until) bounds for a period, `offset` periods back from the current one
// (offset 0 = today / this week / this month / this billing cycle).
// `now` is injectable for deterministic tests; defaults to the real clock.

export function daysInMonth(year, monthIdx) {
  // Day 0 of the next month === last day of this month. Date normalizes overflow.
  return new Date(year, monthIdx + 1, 0).getDate();
}

export function clampDay(day, year, monthIdx) {
  return Math.min(day, daysInMonth(year, monthIdx));
}

// Local-midnight timestamp for the billing day of a given year/month, clamped.
function cycleStart(year, monthIdx, billingDay) {
  const day = clampDay(billingDay, year, monthIdx);
  return new Date(year, monthIdx, day, 0, 0, 0, 0).getTime();
}

export function periodBounds(range, offset = 0, billingDay = 1, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);

  if (range === 'day') {
    d.setDate(d.getDate() - offset);
    const since = d.getTime();
    d.setDate(d.getDate() + 1);
    return { since, until: d.getTime() };
  }
  if (range === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow - offset * 7);
    const since = d.getTime();
    d.setDate(d.getDate() + 7);
    return { since, until: d.getTime() };
  }
  if (range === 'month') {
    d.setDate(1);
    d.setMonth(d.getMonth() - offset);
    const since = d.getTime();
    d.setMonth(d.getMonth() + 1);
    return { since, until: d.getTime() };
  }
  if (range === 'billing') {
    const year = d.getFullYear();
    let monthIdx = d.getMonth();
    // Anchor month = current month if today is on/after this month's billing day,
    // else the previous month. Date ctor normalizes negative/overflow month.
    if (d.getDate() < clampDay(billingDay, year, monthIdx)) monthIdx -= 1;
    monthIdx -= offset;
    return {
      since: cycleStart(year, monthIdx, billingDay),
      until: cycleStart(year, monthIdx + 1, billingDay),
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/period.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Wire `stats.js` to the new module**

In `server/stats.js`, delete the local `periodBounds` function (current L11-37) and its comment block. At the top, after the existing imports (L1-3), add:

```js
import { periodBounds } from './period.js';
export { periodBounds } from './period.js'; // preserve the previous public export
```

Change the call site (was L58) from:

```js
  const bounds = periodBounds(range, offset);
```

to (note: `now` is already defined just above as `const now = Date.now()`):

```js
  const bounds = periodBounds(range, offset, getBillingDay(), now);
```

Add the settings import to the top of `stats.js` (needed for `getBillingDay`; `getBillingDay` is delivered in Task 3 — this import will resolve once Task 3 lands, so run stats only after Task 3):

```js
import { getBillingDay } from './settings.js';
```

> Note for the executor: `stats.js` will not run standalone until Task 3 creates `settings.js`. The `period.test.js` suite does not import `stats.js`, so Task 1 stays green on its own.

- [ ] **Step 6: Commit**

```bash
git add server/period.js test/period.test.js server/stats.js
git commit -m "feat: pure period module with billing-cycle bounds"
```

---

### Task 2: Pure cost engine — `server/cost.js`

All tariff logic with no DB: defaults, validation, hour→band map, per-band import integration, and cost computation.

**Files:**
- Create: `server/cost.js`
- Create: `test/cost.test.js`

**Interfaces:**
- Produces: `DEFAULT_TARIFF` (object)
- Produces: `validateTariff(t): t` (throws `Error` with `.code = 'INVALID_TARIFF'` on bad input)
- Produces: `hourBandMap(bands): Int8Array(24)` (hour → band index)
- Produces: `importKwhByBand(rows, map, bandCount): number[]` (kWh per band; `rows` are `{ ts, import_w }`)
- Produces: `computeCost({ bandKwh, tariff, elapsedDays }): { currency, total, elapsedDays, vatPct, bands: [{ name, rate, kwh, cost }] }`

- [ ] **Step 1: Write the failing test**

Create `test/cost.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TARIFF, validateTariff, hourBandMap, importKwhByBand, computeCost,
} from '../server/cost.js';

test('DEFAULT_TARIFF is valid', () => {
  assert.doesNotThrow(() => validateTariff(DEFAULT_TARIFF));
});

test('hourBandMap: off-peak 0-8 & 22-24, peak 8-22', () => {
  const bands = [
    { name: 'peak', rate: 0.2, windows: [[8, 22]] },
    { name: 'mid', rate: 0.15, windows: [] },
    { name: 'offpeak', rate: 0.1, windows: [[0, 8], [22, 24]] },
  ];
  const map = hourBandMap(bands);
  assert.equal(map[0], 2);   // off-peak
  assert.equal(map[7], 2);   // off-peak
  assert.equal(map[8], 0);   // peak
  assert.equal(map[21], 0);  // peak
  assert.equal(map[22], 2);  // off-peak
  assert.equal(map[23], 2);  // off-peak
});

test('hourBandMap: overlap -> later band wins; uncovered -> band 0', () => {
  const bands = [
    { name: 'a', rate: 1, windows: [[0, 24]] },
    { name: 'b', rate: 2, windows: [[10, 12]] },
  ];
  const map = hourBandMap(bands);
  assert.equal(map[11], 1); // b overwrites a
  assert.equal(map[9], 0);  // a
  const none = hourBandMap([{ name: 'x', rate: 1, windows: [[0, 1]] }]);
  assert.equal(none[5], 0); // uncovered -> band 0
});

test('validateTariff rejects bad shapes', () => {
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: -1, windows: [] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: 1, windows: [[8, 8]] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, bands: [{ name: 'p', rate: 1, windows: [[22, 25]] }] }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, vatPct: 150 }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, dailyFixed: -1 }));
  assert.throws(() => validateTariff({ ...DEFAULT_TARIFF, currency: '' }));
});

test('importKwhByBand buckets by sample midpoint hour, import only', () => {
  // Two 30-min slices: one at 09:00 (peak), one at 02:00 (off-peak). Export ignored.
  const h = (hr) => new Date(2026, 5, 20, hr, 0, 0, 0).getTime();
  const rows = [
    { ts: h(9),          import_w: 2000 }, // slice start -> midpoint 09:15 peak
    { ts: h(9) + 1800e3, import_w: -500 }, // export sample; its own slice would be band by midpoint but import<=0 skips
    { ts: h(2),          import_w: 1000 }, // NOTE rows must be time-ordered in real use; see below
  ];
  // Use a clean ordered set instead:
  const ordered = [
    { ts: h(2),          import_w: 1000 }, // 02:00
    { ts: h(2) + 1800e3, import_w: 0 },    // 02:30 -> prev slice import 1000W * 0.5h = 500Wh off-peak
    { ts: h(9),          import_w: 2000 }, // gap > 0.5h between 02:30 and 09:00 -> skipped
    { ts: h(9) + 1800e3, import_w: 0 },    // 09:30 -> prev slice 2000W * 0.5h = 1000Wh peak
  ];
  const map = hourBandMap(DEFAULT_TARIFF.bands);
  const kwh = importKwhByBand(ordered, map, DEFAULT_TARIFF.bands.length);
  assert.ok(Math.abs(kwh[0] - 1.0) < 1e-9);  // peak band index 0 = 1.0 kWh
  assert.ok(Math.abs(kwh[2] - 0.5) < 1e-9);  // off-peak band index 2 = 0.5 kWh
  assert.equal(kwh[1], 0);                    // mid unused
  void rows;
});

test('computeCost applies rates, levy, daily, fixed and VAT', () => {
  const tariff = {
    currency: '$', vatPct: 10, dailyFixed: 1, perKwhLevy: 0.01, fixedMonthly: 2,
    bands: [{ name: 'peak', rate: 0.2, windows: [[8, 22]] }, { name: 'off', rate: 0.1, windows: [[0, 8]] }],
  };
  const r = computeCost({ bandKwh: [10, 20], tariff, elapsedDays: 5 });
  // energy = 10*0.2 + 20*0.1 = 4 ; levy = 30*0.01 = 0.3 ; daily = 5*1 = 5 ; fixed = 2
  // preVat = 11.3 ; total = 11.3 * 1.1 = 12.43
  assert.equal(r.total, 12.43);
  assert.equal(r.currency, '$');
  assert.equal(r.vatPct, 10);
  assert.equal(r.bands[0].kwh, 10);
  assert.equal(r.bands[0].cost, 2); // 10 * 0.2
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cost.test.js`
Expected: FAIL — `Cannot find module '../server/cost.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/cost.js`:

```js
// Pure tariff / cost logic (no DB). Grid-import-only, simplified time-of-use.

export const DEFAULT_TARIFF = {
  currency: '€',
  bands: [
    { name: 'peak', rate: 0.20, windows: [[8, 22]] },
    { name: 'mid', rate: 0.15, windows: [] },
    { name: 'offpeak', rate: 0.10, windows: [[0, 8], [22, 24]] },
  ],
  dailyFixed: 0.50,
  perKwhLevy: 0.001,
  fixedMonthly: 1.00,
  vatPct: 23,
};

function invalid(msg) {
  const e = new Error(msg);
  e.code = 'INVALID_TARIFF';
  throw e;
}

export function validateTariff(t) {
  if (!t || typeof t !== 'object') invalid('tariff must be an object');
  if (typeof t.currency !== 'string' || !t.currency.trim() || t.currency.length > 8) {
    invalid('currency must be a non-empty string up to 8 chars');
  }
  if (!Array.isArray(t.bands) || t.bands.length < 1 || t.bands.length > 3) {
    invalid('tariff needs 1–3 bands');
  }
  for (const b of t.bands) {
    if (!b || typeof b.name !== 'string' || !b.name.trim()) invalid('each band needs a name');
    if (!Number.isFinite(b.rate) || b.rate < 0) invalid('band rate must be a number ≥ 0');
    if (!Array.isArray(b.windows)) invalid('band windows must be an array');
    for (const w of b.windows) {
      if (!Array.isArray(w) || w.length !== 2) invalid('each window must be [start, end]');
      const [s, e] = w;
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) {
        invalid('window hours must be integers with 0 ≤ start < end ≤ 24');
      }
    }
  }
  for (const k of ['dailyFixed', 'perKwhLevy', 'fixedMonthly']) {
    if (!Number.isFinite(t[k]) || t[k] < 0) invalid(`${k} must be a number ≥ 0`);
  }
  if (!Number.isFinite(t.vatPct) || t.vatPct < 0 || t.vatPct > 100) invalid('vatPct must be 0–100');
  return t;
}

// hour (0-23) -> band index. Later bands overwrite on overlap; uncovered -> band 0.
export function hourBandMap(bands) {
  const map = new Int8Array(24); // zero-filled => default band 0
  bands.forEach((b, idx) => {
    for (const [s, e] of (b.windows || [])) {
      for (let h = s; h < e && h < 24; h++) if (h >= 0) map[h] = idx;
    }
  });
  return map;
}

// Integrate positive grid import (W) over time-ordered samples -> kWh per band.
// Same gap-skip rule as stats.integrate (dt > 0.5h treated as a gap).
export function importKwhByBand(rows, map, bandCount) {
  const wh = new Array(bandCount).fill(0);
  for (let i = 1; i < rows.length; i++) {
    const dtMs = rows[i].ts - rows[i - 1].ts;
    const dtH = dtMs / 3_600_000;
    if (dtH <= 0 || dtH > 0.5) continue;
    const imp = Math.max(0, rows[i - 1].import_w || 0);
    if (imp <= 0) continue;
    const midHour = new Date(rows[i - 1].ts + dtMs / 2).getHours();
    wh[map[midHour]] += imp * dtH;
  }
  return wh.map((x) => x / 1000);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeCost({ bandKwh, tariff, elapsedDays }) {
  const bands = tariff.bands.map((b, i) => {
    const kwh = bandKwh[i] || 0;
    return { name: b.name, rate: b.rate, kwh: round2(kwh), cost: round2(kwh * b.rate) };
  });
  const energyCost = tariff.bands.reduce((a, b, i) => a + (bandKwh[i] || 0) * b.rate, 0);
  const totalKwh = bandKwh.reduce((a, b) => a + b, 0);
  const levy = totalKwh * tariff.perKwhLevy;
  const daily = elapsedDays * tariff.dailyFixed;
  const preVat = energyCost + levy + daily + tariff.fixedMonthly;
  const total = preVat * (1 + tariff.vatPct / 100);
  return {
    currency: tariff.currency,
    total: round2(total),
    elapsedDays: round2(elapsedDays),
    vatPct: tariff.vatPct,
    bands,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cost.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cost.js test/cost.test.js
git commit -m "feat: pure time-of-use cost engine (tariff, bands, compute)"
```

---

### Task 2b: package.json test script

**Files:**
- Modify: `package.json:7-10` (add `test` script)

- [ ] **Step 1: Add the script**

In `package.json` `"scripts"`, add a `test` entry so the runner discovers `test/*.test.js`:

```json
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Run all tests so far**

Run: `npm test`
Expected: PASS — period + cost suites green.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add node --test script"
```

---

### Task 3: SQLite settings store — `server/db.js` + `server/settings.js`

Add the KV table + accessors, a `DB_PATH` test override, and the DB-coupled settings layer (`billingDay` + `tariff`).

**Files:**
- Modify: `server/db.js:10-42` (add `settings` table), `:113-119` (add `getSetting`/`setSetting` exports)
- Modify: `server/config.js:24` (allow `DB_PATH` env override for tests)
- Create: `server/settings.js`
- Create: `test/settings.test.js`

**Interfaces:**
- Consumes: `DEFAULT_TARIFF`, `validateTariff` from `./cost.js`
- Produces (db.js): `getSetting(key): string | undefined`, `setSetting(key, value): void`
- Produces (settings.js): `getBillingDay(): number`, `setBillingDay(day): number`, `getTariff(): object`, `setTariff(t): object`, `validateBillingDay(day): number`, `applySettings({ billingDay?, tariff? }): { billingDay, tariff }`

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.js`. It points the DB at a throwaway temp file via `DB_PATH` **before** importing anything that loads `config.js`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let settings;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-settings-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  settings = await import('../server/settings.js'); // imports db.js -> opens temp DB
});

test('getBillingDay falls back to default (1) when unset', () => {
  assert.equal(settings.getBillingDay(), 1);
});

test('setBillingDay persists and getBillingDay reads it back', () => {
  settings.setBillingDay(15);
  assert.equal(settings.getBillingDay(), 15);
});

test('setBillingDay rejects out-of-range and non-integers', () => {
  assert.throws(() => settings.setBillingDay(0));
  assert.throws(() => settings.setBillingDay(32));
  assert.throws(() => settings.setBillingDay(15.5));
  assert.throws(() => settings.setBillingDay('x'));
});

test('getTariff returns default until set, then persisted value', () => {
  const def = settings.getTariff();
  assert.equal(def.currency, '€');
  const custom = { ...def, currency: '$', vatPct: 10 };
  settings.setTariff(custom);
  assert.equal(settings.getTariff().currency, '$');
  assert.equal(settings.getTariff().vatPct, 10);
});

test('setTariff rejects invalid tariff', () => {
  assert.throws(() => settings.setTariff({ currency: '€', bands: [], dailyFixed: 0, perKwhLevy: 0, fixedMonthly: 0, vatPct: 10 }));
});

test('applySettings validates all before persisting (atomic)', () => {
  const before = settings.getBillingDay();
  const badTariff = { currency: '€', bands: [{ name: 'p', rate: -1, windows: [] }], dailyFixed: 0, perKwhLevy: 0, fixedMonthly: 0, vatPct: 10 };
  assert.throws(() => settings.applySettings({ billingDay: 9, tariff: badTariff }));
  assert.equal(settings.getBillingDay(), before, 'billingDay must not persist when tariff is invalid');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings.test.js`
Expected: FAIL — `Cannot find module '../server/settings.js'`.

- [ ] **Step 3: Add the `DB_PATH` override in `config.js`**

In `server/config.js`, change the db path line (L24) from:

```js
    db: path.resolve(ROOT, fileConfig.db.path),
```

to:

```js
    db: path.resolve(ROOT, process.env.DB_PATH || fileConfig.db.path),
```

- [ ] **Step 4: Add the `settings` table + accessors in `db.js`**

In `server/db.js`, inside the existing `db.exec(\`...\`)` schema block (before the closing `` ` ``, after the `idx_samples_ts` index at L41), add:

```sql
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
```

Then, near the other prepared statements (after the `queries` export block, around L119), add:

```js
// --- Key/value settings store (billing day, tariff) -------------------------
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
```

- [ ] **Step 5: Create `server/settings.js`**

```js
// DB-coupled settings layer: persists billing day + tariff in the SQLite KV
// store. Pure validation/defaults live in cost.js; config.json only seeds the
// billing-day default. Never writes to config.json (keeps secrets untouched).
import { getSetting, setSetting } from './db.js';
import config from './config.js';
import { DEFAULT_TARIFF, validateTariff } from './cost.js';

export function validateBillingDay(day) {
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    const e = new Error('billingDay must be an integer 1–31');
    e.code = 'INVALID_SETTING';
    throw e;
  }
  return n;
}

export function getBillingDay() {
  const raw = getSetting('billingDay');
  if (raw != null) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  }
  const def = config.stats?.billingDay;
  return Number.isInteger(def) && def >= 1 && def <= 31 ? def : 1;
}

export function setBillingDay(day) {
  const n = validateBillingDay(day);
  setSetting('billingDay', String(n));
  return n;
}

export function getTariff() {
  const raw = getSetting('tariff');
  if (raw != null) {
    try {
      return validateTariff(JSON.parse(raw));
    } catch {
      /* corrupt/invalid stored tariff -> fall back to default */
    }
  }
  return DEFAULT_TARIFF;
}

export function setTariff(t) {
  validateTariff(t);
  setSetting('tariff', JSON.stringify(t));
  return t;
}

// Validate everything present, THEN persist, so a partial/invalid POST writes
// nothing.
export function applySettings({ billingDay, tariff } = {}) {
  if (billingDay !== undefined) validateBillingDay(billingDay);
  if (tariff !== undefined) validateTariff(tariff);
  if (billingDay !== undefined) setBillingDay(billingDay);
  if (tariff !== undefined) setTariff(tariff);
  return { billingDay: getBillingDay(), tariff: getTariff() };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/settings.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite (period + cost + settings)**

Run: `npm test`
Expected: PASS — all three suites.

- [ ] **Step 8: Commit**

```bash
git add server/db.js server/config.js server/settings.js test/settings.test.js
git commit -m "feat: SQLite settings store for billing day + tariff"
```

---

### Task 4: Cost in `getStats` — `server/stats.js`

Feed the period window + tariff into the existing aggregation to attach a `cost` object. Also completes the Task 1 wiring (`getBillingDay` now exists).

**Files:**
- Modify: `server/stats.js` (imports; `getStats` cost block; response object L128-133)

**Interfaces:**
- Consumes: `getBillingDay`, `getTariff` from `./settings.js`; `hourBandMap`, `importKwhByBand`, `computeCost` from `./cost.js`
- Produces: `getStats` response gains `cost: { currency, total, elapsedDays, vatPct, bands } | null`

- [ ] **Step 1: Write the failing test**

Create `test/stats-cost.test.js`. It seeds a temp DB with two import samples, then asserts `getStats('day', 0)` returns a matching cost. Uses the default tariff.

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let stats, db;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-statscost-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  stats = await import('../server/stats.js');

  // Two 30-min slices earlier today at 02:00 (off-peak) and 09:00 (peak).
  const now = new Date();
  const at = (hr, min) => { const d = new Date(now); d.setHours(hr, min, 0, 0); return d.getTime(); };
  const insert = db.prepare('INSERT OR REPLACE INTO samples (ts, import_w) VALUES (?, ?)');
  insert.run(at(2, 0), 1000);
  insert.run(at(2, 30), 0);   // prev slice: 1000W * 0.5h = 500Wh off-peak
  insert.run(at(9, 0), 2000);
  insert.run(at(9, 30), 0);   // prev slice: 2000W * 0.5h = 1000Wh peak
});

test('getStats day includes a cost object with per-band kWh', () => {
  const s = stats.getStats('day', 0);
  assert.ok(s.cost, 'cost present for a bounded period');
  assert.equal(s.cost.currency, '€');
  // Default bands: index 0 peak, index 2 off-peak.
  assert.ok(Math.abs(s.cost.bands[0].kwh - 1.0) < 1e-6);
  assert.ok(Math.abs(s.cost.bands[2].kwh - 0.5) < 1e-6);
  assert.ok(s.cost.total > 0);
});

test('open-ended ranges have null cost', () => {
  const s = stats.getStats('all', 0);
  assert.equal(s.cost, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stats-cost.test.js`
Expected: FAIL — `s.cost` is `undefined` (no cost block yet), assertion fails.

- [ ] **Step 3: Add the cost imports to `stats.js`**

At the top of `server/stats.js`, ensure these imports exist (the `getBillingDay` import was added in Task 1; add `getTariff` and the cost helpers):

```js
import { getBillingDay, getTariff } from './settings.js';
import { hourBandMap, importKwhByBand, computeCost } from './cost.js';
```

- [ ] **Step 4: Compute cost inside `getStats`**

In `server/stats.js`, immediately after the `rows`/`peakAll` lines (was L66-67), add:

```js
  // Estimated grid-import cost for bounded periods (day/week/month/billing).
  let cost = null;
  if (until != null) {
    const tariff = getTariff();
    const map = hourBandMap(tariff.bands);
    const bandKwh = importKwhByBand(rows, map, tariff.bands.length);
    const elapsedDays = Math.max(0, (Math.min(now, until) - since) / 86_400_000);
    cost = computeCost({ bandKwh, tariff, elapsedDays });
  }
```

Then add `cost` to the returned object. Change the head of the `return { ... }` (was L128-134) so it reads:

```js
  return {
    range,
    offset,
    since,
    until,
    now,
    cost,
    samples: rows.length,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/stats-cost.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — period, cost, settings, stats-cost.

- [ ] **Step 7: Commit**

```bash
git add server/stats.js test/stats-cost.test.js
git commit -m "feat: attach grid-import cost estimate to period stats"
```

---

### Task 5: API — `server/index.js`

Whitelist the `billing` range and expose `GET/POST /api/settings`.

**Files:**
- Modify: `server/index.js:6-8` (import settings), `:40-47` (range whitelist), add two routes near the other `/api/*` handlers.

**Interfaces:**
- Consumes: `getBillingDay`, `getTariff`, `applySettings` from `./settings.js`
- Produces: `GET /api/settings` → `{ billingDay, tariff }`; `POST /api/settings` → `{ billingDay, tariff }` (200) or `{ error }` (400)

- [ ] **Step 1: Add the settings import**

In `server/index.js`, after the existing `import * as stats from './stats.js';` (L6), add:

```js
import * as settings from './settings.js';
```

- [ ] **Step 2: Whitelist the `billing` range**

Change the range whitelist (L41) from:

```js
  const range = ['today', 'session', 'all', 'day', 'week', 'month'].includes(req.query.range)
```

to:

```js
  const range = ['today', 'session', 'all', 'day', 'week', 'month', 'billing'].includes(req.query.range)
```

- [ ] **Step 3: Add the settings routes**

In `server/index.js`, after the `/api/series` handler (L52), add:

```js
app.get('/api/settings', (req, res) => {
  res.json({ billingDay: settings.getBillingDay(), tariff: settings.getTariff() });
});

app.post('/api/settings', (req, res) => {
  try {
    const saved = settings.applySettings(req.body || {});
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Manual smoke test (server running)**

Start the server (`npm start`) in one terminal, then in another:

```bash
curl -s http://localhost:3000/api/settings
# -> {"billingDay":1,"tariff":{...defaults...}}

curl -s -X POST http://localhost:3000/api/settings -H 'Content-Type: application/json' -d '{"billingDay":15}'
# -> {"billingDay":15,"tariff":{...}}

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/settings -H 'Content-Type: application/json' -d '{"billingDay":99}'
# -> 400

curl -s "http://localhost:3000/api/stats?range=billing&offset=0" | head -c 200
# -> JSON with "range":"billing" and a "cost" object
```

Expected: matches the comments above. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat: /api/settings endpoints + billing range in stats API"
```

---

### Task 6: Frontend — `public/index.html` + `public/app.js`

Billing tab, settings panel (billing day + tariff), and Cost tile.

**Files:**
- Modify: `public/index.html:269-282` (Billing button, settings toggle + panel)
- Modify: `public/app.js:628` (`PERIOD_RANGES`), `:630-647` (`periodLabel`), `:667-680` (Cost tile cell), and add settings load/save wiring near the controls block (L689+); call `loadSettings()` at init.

**Interfaces:**
- Consumes: `GET/POST /api/settings`; `st.cost` from `/api/stats`

- [ ] **Step 1: Add the Billing button + settings UI in `index.html`**

Replace the stats `<div class="seg" id="rangeSeg">…</div>` block (L269-275) — add the Billing button:

```html
    <div class="seg" id="rangeSeg">
      <button data-range="session">Session</button>
      <button data-range="day" class="active">Day</button>
      <button data-range="week">Week</button>
      <button data-range="month">Month</button>
      <button data-range="billing">Billing</button>
      <button data-range="all">All</button>
    </div>
```

Then, immediately after the `#periodNav` div (ends L280) and before `#statsGrid` (L281), insert the settings toggle + panel:

```html
    <div class="flex justify-end">
      <button id="settingsToggle" class="lg-btn lg-btn-ghost px-3 py-1 text-[12px]">⚙ Tariff &amp; billing</button>
    </div>
    <div id="settingsPanel" class="glass rounded-2xl p-3.5 flex flex-col gap-3" hidden>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">Billing day</span>
          <input id="setBillingDay" type="number" min="1" max="31" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">Currency</span>
          <input id="setCurrency" type="text" maxlength="8" class="px-2 py-1.5 rounded-xl text-[14px]" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
      </div>
      <div class="text-[10px] text-mut uppercase">Bands — rate (per kWh) &amp; hours (e.g. 0-8,22-24)</div>
      <div id="tariffBands" class="flex flex-col gap-2"></div>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">Daily fixed</span>
          <input id="setDailyFixed" type="number" step="0.0001" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">Per-kWh levy</span>
          <input id="setLevy" type="number" step="0.0001" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">Fixed monthly</span>
          <input id="setFixedMonthly" type="number" step="0.01" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
        <label class="flex flex-col gap-1"><span class="text-[10px] text-mut uppercase">VAT %</span>
          <input id="setVat" type="number" step="0.1" min="0" max="100" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" /></label>
      </div>
      <div id="settingsError" class="text-[11px]" style="color:#FF453A" hidden></div>
      <button id="settingsSave" class="lg-btn px-4 py-2 text-[13px] self-start">Save</button>
    </div>
```

- [ ] **Step 2: Extend `PERIOD_RANGES` and `periodLabel` in `app.js`**

Change L628:

```js
const PERIOD_RANGES = ['day', 'week', 'month', 'billing'];
```

In `periodLabel` (L630-647), add a `billing` branch just before the final month lines. After the closing `}` of the `week` block (L644) and before `if (st.offset === 0) return 'This month';`, insert:

```js
  if (st.range === 'billing') {
    if (st.offset === 0) return 'This billing period';
    const end = new Date(st.until - 86400_000);
    const s = since.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const e = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${s} – ${e}`;
  }
```

- [ ] **Step 3: Add the Cost tile**

In `refreshStats`, after the `cells` array is built (after L680, before the `$('statsGrid').innerHTML = …` line L681), append a cost cell when present:

```js
  if (st.cost) cells.push(['Cost', st.cost.total.toFixed(2), st.cost.currency]);
```

- [ ] **Step 4: Add settings load/save wiring**

At the end of `public/app.js`, add:

```js
// --- Settings (billing day + tariff) ---------------------------------------
let tariffState = null;

function winToStr(windows) {
  return (windows || []).map(([s, e]) => `${s}-${e}`).join(',');
}
function parseWindows(str) {
  const out = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) throw new Error(`bad window "${part}" — use e.g. 0-8,22-24`);
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}
function fillTariffForm(t) {
  $('setCurrency').value = t.currency;
  $('setDailyFixed').value = t.dailyFixed;
  $('setLevy').value = t.perKwhLevy;
  $('setFixedMonthly').value = t.fixedMonthly;
  $('setVat').value = t.vatPct;
  $('tariffBands').innerHTML = t.bands.map((b, i) =>
    `<div class="grid grid-cols-3 gap-2 items-center">
       <span class="text-[12px]">${b.name}</span>
       <input id="band${i}Rate" type="number" step="0.0001" value="${b.rate}" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" />
       <input id="band${i}Win" type="text" value="${winToStr(b.windows)}" placeholder="0-8,22-24" class="px-2 py-1.5 rounded-xl text-[13px]" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" />
     </div>`).join('');
}
async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    $('setBillingDay').value = s.billingDay;
    tariffState = s.tariff;
    fillTariffForm(s.tariff);
  } catch { /* leave form empty */ }
}
async function saveSettings() {
  const err = $('settingsError');
  err.hidden = true;
  try {
    const bands = tariffState.bands.map((b, i) => ({
      name: b.name,
      rate: Number($(`band${i}Rate`).value),
      windows: parseWindows($(`band${i}Win`).value),
    }));
    const body = {
      billingDay: Number($('setBillingDay').value),
      tariff: {
        currency: $('setCurrency').value,
        bands,
        dailyFixed: Number($('setDailyFixed').value),
        perKwhLevy: Number($('setLevy').value),
        fixedMonthly: Number($('setFixedMonthly').value),
        vatPct: Number($('setVat').value),
      },
    };
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'save failed'); }
    const saved = await res.json();
    tariffState = saved.tariff;
    fillTariffForm(saved.tariff);
    $('settingsPanel').hidden = true;
    statsOffset = 0;
    refreshStats();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}
$('settingsToggle').addEventListener('click', () => { $('settingsPanel').hidden = !$('settingsPanel').hidden; });
$('settingsSave').addEventListener('click', saveSettings);
loadSettings();
```

- [ ] **Step 5: Manual browser verification**

Start `npm start`, open `http://localhost:3000`.
- Click **Billing** → nav shows "This billing period"; a **Cost** tile appears in the grid.
- Click ⚙ **Tariff & billing** → panel opens pre-filled with defaults. Change billing day to 15, Save → panel closes, stats refresh. Reopen → 15 persisted.
- Enter an invalid window like `8-8` in a band → Save shows an inline red error, values unchanged.
- Use ‹ / › to step billing cycles; label shows date ranges like `15 May – 14 Jun`.

Expected: all behaviors as described, no restart needed.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: Billing tab, tariff/billing settings panel, Cost tile"
```

---

### Task 7: Document the default in `config.json.example`

**Files:**
- Modify: `config.json.example` (add optional `stats.billingDay` seed)

- [ ] **Step 1: Add the documented default**

Open `config.json.example` and add a `stats` section (generic default day `1`) alongside the existing sections, e.g.:

```json
  "stats": {
    "billingDay": 1
  },
```

Keep JSON valid (comma placement). This is only the **seed** default; the live value is set from the dashboard settings panel and stored in SQLite.

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.json.example','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add config.json.example
git commit -m "docs: document optional stats.billingDay default"
```

---

## Self-Review

**Spec coverage:**
- §1 Persistence (settings table + get/setSetting) → Task 3 ✓
- §2 settings accessor (getBillingDay/setBillingDay) → Task 3 ✓
- §3 period math billing branch + clamp → Task 1 ✓
- §4 API (/api/settings, billing whitelist) → Task 5 ✓
- §5 Tariff model (getTariff/setTariff/validateTariff/hourBandMap + defaults) → Task 2 (pure) + Task 3 (persistence) ✓
- §6 Cost computation (per-band import + formula) → Task 2 (pure) + Task 4 (in getStats) ✓
- §7 Frontend (Billing button, periodLabel, settings panel day+tariff, Cost tile) → Task 6 ✓
- Error handling (invalid billingDay/tariff → 400; malformed stored tariff → default; atomic apply) → Tasks 2/3/5 ✓
- Testing (period math, hourBandMap, validate, cost, getBillingDay fallback, API) → Tasks 1–5 ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The one forward-reference (`stats.js` importing `settings.js` before Task 3) is called out explicitly with test isolation preserved.

**Type consistency:** `periodBounds(range, offset, billingDay, now)` consistent across period.js, stats.js, tests. `computeCost({ bandKwh, tariff, elapsedDays })` and its return shape (`{ currency, total, elapsedDays, vatPct, bands:[{name,rate,kwh,cost}] }`) consistent across cost.js, stats-cost test, and frontend (`st.cost.total`, `st.cost.currency`, `st.cost.bands`). `applySettings({ billingDay, tariff })` matches the POST body and route usage. Band index convention (0=peak, 2=off-peak with default) consistent in cost tests and stats-cost test.
