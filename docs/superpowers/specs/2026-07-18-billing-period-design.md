# Billing Period + Settings UI — Design

**Date:** 2026-07-18
**Repo:** `energy monitoring` (non-saas / better-sqlite3 live dashboard)
**Branch base:** `feat/chart-day-sun-markers` (or `main`)

## Goal

Add a new **Billing** browse period alongside the existing Day / Week / Month
tabs. A user-configurable **billing day of month** anchors each billing cycle.
Cycle runs from the billing day of one month to the day before the billing day
of the next month, so period length varies naturally (28–31 days). The billing
day is set from a small in-dashboard settings UI (no restart, persisted in
SQLite).

A **cost / tariff engine** is added on top: a configurable time-of-use tariff
(up to 3 bands) turns grid-import kWh into an estimated cost per period. All
tariff values are user-editable in the settings UI and ship with **generic**
placeholder defaults (no real-world provider values baked in).

## Non-Goals

- No change to Day / Week / Month energy behavior.
- No multi-tenant / saas support. The saas subfolder dropped the period feature
  and is not touched here.
- Cost engine is a **simplified** estimate: single flat VAT %, one fixed monthly
  charge. It does not model tiered VAT bands or per-band regulated network-access
  lines separately. Users fold such extras into the band rate / fixed charges.
- No export / feed-in credit. Cost is grid import only; solar self-consumed is
  free; export is ignored for cost.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Billing behavior | New "Billing" period type; month-to-month from set day; variable length |
| Where to set day | Small in-dashboard settings UI (write endpoint, live-apply) |
| Persistence store | SQLite `settings` KV table (never rewrites config.json / secrets) |
| Nav label style | Date range, e.g. `15 Jun – 14 Jul`; current cycle = "This billing period" |
| Day picker range | Allow 1–31; clamp to last day for short months (31 → Feb 28/29) |
| Cost fidelity | Simplified TOU (energy bands + daily fixed + per-kWh levy + flat VAT + fixed monthly) |
| TOU bands | Up to 3 (peak / mid / off-peak); a band with no windows is unused |
| Cost basis | Grid import only, split by TOU band; solar free, export ignored |
| Cost visibility | Cost tile on every period tab; mid-period = cost-so-far (not projected) |

## Architecture

Five thin changes, each isolated:

### 1. Persistence — `server/db.js`

- New table (created in existing schema init):
  ```sql
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ```
- Prepared statements + helpers:
  - `getSetting(key)` → string | undefined
  - `setSetting(key, value)` → upsert (`INSERT ... ON CONFLICT(key) DO UPDATE`)
- No migration file needed — table is created idempotently at init like the
  existing tables.

### 2. Settings accessor — `server/settings.js` (new, small)

Encapsulates the billing-day setting so callers never touch raw KV strings.

- `getBillingDay()`:
  1. read `getSetting('billingDay')`
  2. if present → `parseInt`, validate 1–31, return
  3. else fall back to `config.stats?.billingDay ?? 1` (new optional config key)
- `setBillingDay(day)`:
  - coerce to int, validate `Number.isInteger(day) && day >= 1 && day <= 31`
  - throw a typed error on invalid input (caught by the route → 400)
  - `setSetting('billingDay', String(day))`

Rationale: keeps validation in one place, shared by the route and
`periodBounds`. `config.stats.billingDay` is only the default seed.

### 3. Period math — `server/stats.js`

Add a `'billing'` branch to `periodBounds(range, offset)` (currently L11-37).
Reuses the existing local-midnight seed `d` (L14-15).

Algorithm (billing day = `B`, offset = `O` cycles back, `O >= 0`):

1. `B = getBillingDay()`.
2. Determine the anchor cycle-start month for *today*:
   - if `today.date >= clampDay(B, today.year, today.month)` → anchor month =
     current month
   - else → anchor month = previous month
3. Step back `O` months from the anchor month.
4. `since = cycleStart(anchorYear, anchorMonth, B)` at 00:00 local.
5. `until = cycleStart(nextMonth, B)` at 00:00 local.
6. Return `{ since, until }` (half-open, same contract as other ranges).

Helper `clampDay(day, year, monthIdx)` = `Math.min(day, daysInMonth(year, monthIdx))`,
and `cycleStart` builds the Date with the clamped day to avoid JS
`setDate(31)` roll-over into the next month.

`getStats` needs no change beyond `periodBounds` returning a non-null window —
it already routes `until != null` through `samplesBetween`.

### 4. API — `server/index.js`

- Extend the `/api/stats` range whitelist (L42-44) to include `'billing'`.
  Offset clamp (`0..1000`) unchanged.
- `GET /api/settings` → `{ billingDay: getBillingDay(), tariff: getTariff() }`.
- `POST /api/settings` → body may carry `billingDay` and/or `tariff`; validate
  each (see §6/§7); on any validation error return `400 { error }` and persist
  nothing; on success return the full new `{ billingDay, tariff }`. JSON body
  parsing uses the existing middleware (confirm during implementation; add
  `express.json()` if not already mounted).

### 5. Tariff model + accessor — `server/tariff.js` (new)

Stored as a JSON string under key `tariff` in the same `settings` table.

```jsonc
{
  "currency": "€",
  "bands": [
    { "name": "peak",    "rate": 0.20, "windows": [[8, 22]] },
    { "name": "mid",     "rate": 0.15, "windows": [] },
    { "name": "offpeak", "rate": 0.10, "windows": [[0, 8], [22, 24]] }
  ],
  "dailyFixed":   0.50,
  "perKwhLevy":   0.001,
  "fixedMonthly": 1.00,
  "vatPct":       23
}
```

- `getTariff()` → parsed stored tariff, or built-in **generic** default (above).
  Never throws; malformed stored JSON falls back to default.
- `validateTariff(t)` → throws typed error unless: ≥ 1 band; each band `rate ≥ 0`;
  each window is `[start, end]` integers `0 ≤ start < end ≤ 24`; `dailyFixed`,
  `perKwhLevy`, `fixedMonthly` finite `≥ 0`; `vatPct` finite `0–100`;
  `currency` a short non-empty string.
- `setTariff(t)` → `validateTariff` then `setSetting('tariff', JSON.stringify(t))`.
- `hourBandMap(bands)` → `Int8Array(24)` mapping each local hour to a band
  index. Fill from `windows` (`[start,end)`); later bands overwrite on overlap;
  hours left unassigned → band `0`. Pure, unit-tested.

### 6. Cost computation — `server/stats.js`

Cost is derived inside `getStats`, reusing the period `rows` and window.

- Extend the grid-import integration: for each dt-slice between consecutive
  samples (same gap-skip rule as `integrate`), classify by `hourBandMap` at the
  slice **midpoint** local hour, accumulating `importKwhByBand[bandIndex]`.
  Only the positive import portion counts (grid import, not export).
- `elapsedDays = (Math.min(nowMs, until) − since) / 86_400_000` (≥ 0).
- Cost:
  ```
  energyCost = Σ_b importKwhByBand[b] × bands[b].rate
  levy       = (Σ_b importKwhByBand[b]) × perKwhLevy
  daily      = elapsedDays × dailyFixed
  total      = (energyCost + levy + daily + fixedMonthly) × (1 + vatPct/100)
  ```
- Added to the stats response as:
  ```jsonc
  "cost": {
    "currency": "€",
    "total": 42.31,
    "elapsedDays": 12.4,
    "bands": [ { "name": "peak", "kwh": 88.1, "rate": 0.20, "cost": 17.62 }, ... ],
    "vatPct": 23
  }
  ```
- Cost is computed for any range that yields a window (day/week/month/billing).
  For `all`/`session` (open-ended or non-tariff windows) `cost` may be `null`
  and the client hides the tile.

### 7. Frontend — `public/index.html` + `public/app.js`

**index.html**
- Add a **Billing** button to `#rangeSeg` (`data-range="billing"`).
- Add a small **settings** affordance: a gear button that toggles a tiny inline
  panel; hidden by default via the existing `[hidden]{display:none!important}`
  rule. Panel fields:
  - Billing day: numeric input (`min=1 max=31`).
  - Tariff: currency; 3 band rows (name shown read-only, editable `rate` +
    `windows` text like `0-8,22-24`); `dailyFixed`, `perKwhLevy`,
    `fixedMonthly`, `vatPct`.
  - Save button.
- Add a **Cost** tile to the stats grid (near the home tiles, L596-599 area).

**app.js**
- Add `'billing'` to `PERIOD_RANGES` (L628) so the prev/next nav shows for it.
- `periodLabel(st)` (L630-646): new billing branch.
  - `offset === 0` → `"This billing period"`.
  - else → format `"<d MMM> – <d MMM>"` from `st.since` / `st.until − 1 day`.
- On load: `GET /api/settings`, store `billingDay` + `tariff`, pre-fill inputs.
- Save handler: build `{ billingDay, tariff }` from inputs (parse windows text
  → `[[s,e],...]`), `POST /api/settings`; on `400` show inline error and keep
  old values; on success update local state, close panel, `statsOffset = 0`,
  `refreshStats()`.
- Cost tile render: from `st.cost` — show `total` + currency; hide tile when
  `st.cost == null`. Optional band breakdown from `st.cost.bands`.
- Range button handler already resets `statsOffset = 0` (L694-698) — billing
  inherits this.

## Data Flow

```
[gear] --> POST /api/settings {billingDay,tariff}
   --> setBillingDay / setTariff (validate) --> setSetting (SQLite)
                                                          |
range=billing --> GET /api/stats?range=billing&offset=O  |
   server: periodBounds('billing', O) --> getBillingDay()-+
          --> since/until --> samplesBetween --> getStats
              --> energy Wh math (existing)
              --> cost: importKwhByBand (hourBandMap) × getTariff() rates
   client: periodLabel --> "15 Jun – 14 Jul";  Cost tile <-- st.cost
```

## Error Handling

- Invalid `billingDay` (non-int, <1, >31): `setBillingDay` throws → route → `400`.
  Client shows an inline error, keeps the old value.
- Invalid `tariff` (bad window, negative rate, vat out of range): `validateTariff`
  throws → route → `400 { error }`, nothing persisted.
- Missing/blank settings: `getBillingDay` / `getTariff` fall back to defaults,
  never throw — periods and cost always resolvable.
- Malformed stored tariff JSON: `getTariff` catches parse error → default.
- `POST /api/settings` with malformed JSON body: express json middleware → 400.
- Clamp guarantees `since`/`until` are always valid dates for any month.

## Testing

Unit (period math is the risk area):
- `periodBounds('billing', 0)` with `B=15`, today = 20th → cycle = [15th, next 15th).
- Same with today = 10th → cycle = [prev 15th, this 15th).
- `B=31` in a February → since clamps to 28/29; `until` clamps to next month end.
- Offset stepping: `offset=1` returns the immediately-prior cycle, contiguous
  with `offset=0` (`until(1) === since(0)`).
- `B=1` → billing cycles equal calendar months (parity with `month`).
- `getBillingDay` fallback when KV empty; validation rejects 0, 32, `"x"`, 15.5.

Cost / tariff (unit):
- `hourBandMap` — off-peak `[[0,8],[22,24]]` + peak `[[8,22]]` → hours 0–7 & 22–23
  = off-peak, 8–21 = peak; empty mid band never selected.
- `hourBandMap` overlap: later band wins; uncovered hour → band 0.
- `validateTariff` rejects: 0 bands, negative rate, window `[8,8]`, `[22,25]`,
  `vatPct` 150; accepts the default.
- Cost math: known `importKwhByBand` + tariff → expected `total` (hand-computed).
- `getTariff` fallback on empty KV and on malformed stored JSON.

Integration:
- `GET /api/settings` returns defaults, then persisted values after `POST`.
- `POST /api/settings` invalid billingDay or tariff → 400, values unchanged.
- `GET /api/stats?range=billing&offset=0` returns `since/until` matching the
  configured day and a `cost` object with per-band kWh.

Manual:
- Set billing day + tariff in UI, confirm Billing tab window + label, Cost tile
  total, prev/next steps by cycle, no restart required.

## Files Touched

| File | Change |
|------|--------|
| `server/db.js` | `settings` table + `getSetting`/`setSetting` |
| `server/settings.js` (new) | `getBillingDay` / `setBillingDay` + validation |
| `server/tariff.js` (new) | `getTariff`/`setTariff`/`validateTariff`/`hourBandMap` + defaults |
| `server/stats.js` | `'billing'` branch, `clampDay`/`cycleStart`, per-band import + cost |
| `server/index.js` | range whitelist + `GET`/`POST /api/settings`, ensure json body |
| `public/index.html` | Billing button + settings gear/panel (day + tariff) + Cost tile |
| `public/app.js` | `PERIOD_RANGES`, `periodLabel` billing, settings load/save, Cost tile |
| `config.json.example` | document optional `stats.billingDay` default |
