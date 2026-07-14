# Daily stats rollups, home-dashboard periods, pause-hides-controls

Date: 2026-07-14
Branch: `home-dashboard`
Status: approved, not yet implemented

## Problem

Three requests, one of which has real engineering in it.

1. **Switching Day/Week/Month takes ~1s or more.** Confirmed by the user against the
   second PC, which holds a much larger sample history than the box this was measured on.
2. The home dashboard (`/`) has a fixed TODAY row and no way to see other periods.
3. With the charger set to Pause, controls that do nothing while paused stay on screen.

### Measured facts

Against the production DB copy (27,126 rows, 3.2 days) on this machine:

| Range | Cost |
|---|---|
| `day`, `week` | ~2 ms |
| `month`, `all` | ~35–70 ms |

`getStats` makes ~5 integration passes over every sample in the range. Cost scales
linearly with rows. Projected to the configured 60-day retention at a 10s poll
(~518k rows): **~1.4s per query**.

`node:sqlite`'s `DatabaseSync` is **synchronous**. A slow query does not just make that
request slow — it blocks the event loop, stalling the ~2s live loop and the SSE feed.
This is why the obvious fix is the wrong one: prefetching day/week/month on page load
fires three blocking queries at once and makes the whole dashboard stutter. The
aggregation has to get cheaper; hiding the latency is not enough.

`samples.ts` is already `INTEGER PRIMARY KEY`, so range scans use the index. The cost is
row deserialization plus the JS integration passes, not lookup.

## Design

### 1. Daily rollups

New table, one row per **completed** day, keyed by local-midnight ms:

```sql
CREATE TABLE IF NOT EXISTS daily_stats (
  day_ts           INTEGER PRIMARY KEY,  -- local midnight, ms
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

A finished day never changes, so it is computed once and stored forever. **Today is never
stored** — it is always recomputed live (~8,600 rows at a 10s poll, ~25 ms).

A day with no samples (server was off) stores a row of zeros rather than nothing, so it is
not recomputed on every subsequent view. `day_ts` is local midnight, so a DST day is 23 or
25 hours long; the key stays unique and the bounds come from the existing `periodBounds`,
which is already DST-safe.

Range mapping in `getStats`:

| Range | Source |
|---|---|
| `day`, offset 0 | live compute |
| `day`, offset >= 1 | rollup row; compute-and-store on miss |
| `week`, `month` | fold rollup rows in `[since, until)`, plus live today if the period contains today |
| `all` | fold every rollup row, plus live today |
| `today`, `session` | live compute, unchanged |

Fold rules:

- **Sum**: `samples`, `car_wh`, `car_solar_wh`, `car_grid_wh`, `charging_samples`,
  `adjustments`, `solar2_wh`, `solax_wh`, `export_wh`, `import_wh`, `used_wh`
- **Max**: `peak_w`, `peak_amps`
- **Re-derive from the summed parts** (never average): `solarPct = carSolarWh / carWh`,
  `chargingMinutes = round(chargingSamples * pollIntervalSec / 60)`

`allTime.peakW` / `allTime.peakAmps` keep reading `queries.peakAllTime` from `samples`.

Solar generation stays **unfloored**, consistent with the current code and the comment in
`stats.js`: `solax_w` is a cloud reading minutes behind the live grid columns, so
per-sample `max(measured, balance)` biases an energy total upward. The floor is for
instantaneous display only.

#### Correctness detail: interval attribution

`integrate` walks sample pairs and values each interval by its **left** sample
(`pick(rows[i-1])`), so the interval straddling midnight belongs to the earlier day. A
naive per-day query drops it, and `week` would not equal the sum of its days.

Each day's rollup therefore reads its samples **plus the first sample at or after the next
midnight**, used only to close the final interval. This reproduces the whole-range math
exactly.

#### Correctness detail: adjustments across midnight

`adjustments` compares each charging sample's amps against the previous charging sample,
carrying `prevAmps` across rows. The overnight schedule charges straight through midnight,
so a day computed in isolation miscounts at each boundary.

Each day's rollup also reads **one sample before its midnight**, used only to seed
`prevAmps`. Its interval is not counted.

#### Behavior change: `all` outlives sample retention

`pruneOld` deletes samples older than `sampleRetentionDays` (60). Rollups are not pruned,
so `all` will gradually cover more history than the samples do. Today `all` silently means
"last 60 days". This is an intentional improvement, accepted by the user.

#### Backfill

Lazy: the first view of an old month computes and stores ~31 day rows (~800 ms once), then
is permanent. Optionally warm missing rollups at boot **one day at a time** via
`setImmediate`, so the synchronous DB never blocks the live loop for more than one day's
compute (~25 ms) at a stretch.

Guard: only store a rollup when `day_ts < startOfToday`. A partially-elapsed day must
never be persisted.

### 2. Home dashboard periods

The period nav currently lives inline in `app.js`: the `day|week|month` list, the
prev/next handlers, `periodLabel`, the stale-response guard, and the `MAX_OFFSET` clamp.
Copying ~50 lines into `home.js` would leave two copies to drift apart.

Extract to a shared `public/period-nav.js`. There is no bundler, so both pages load it via
`<script>`; it exposes a factory that each page wires to its own tiles and its own fetch.
`app.js` and `home.js` keep their page-specific rendering.

On `/`: the `TODAY` header becomes the period label (`Today` / `Yesterday` / `This week` /
`March 2026`), with prev/next. Ranges are `day|week|month` only — Session and All are car
concepts, not home ones. The four tiles (`stSolarGen`, `stExported`, `stImported`,
`stHouseUsed`) are unchanged; only the range feeding them changes.

`home.js`'s existing 60s refresh stays, and remains meaningful only for offset 0; past
periods are static.

### 3. Pause hides the controls

In `app.js`'s render path (where `#modeSeg` active state is already applied):

```js
const paused = s.mode === 'pause';
```

toggles `.hidden` on four elements:

| Element | Change |
|---|---|
| Charge limit card (amps slider, `ovRange` / `ovApply` / `ovClear`) | add `id="limitCard"` |
| `chargeToggle` (Start charge) | has an id |
| Allow battery limit increase card (`boostEnabled`) | add `id="boostCard"` |
| Overnight charge card (`schedEnabled`) | add `id="schedCard"` |

Per the user: **all four hide**, including Start charge. Paused shows only the mode toggle.

This relies on the `[hidden] { display:none !important }` rule already in `index.html` —
without it, Tailwind's `.flex` on those cards outranks preflight's `[hidden]` and they
would stay visible.

Hidden elements are still readable from JS, so `postSchedule()` reading `$('schedEnabled')`
is unaffected. Hiding is display-only and does not touch `state.override` or mode
semantics.

## Testing

The repo has no test suite (`npm start` / `npm run dev` only). Verification is by direct
execution.

1. **Rollup equivalence (the load-bearing check).** For past ranges against a copy of the
   real DB, assert `fold(rollups)` equals the current whole-range `integrate(samples)`
   within rounding, for every field. This is what proves the rollups are not quietly wrong.
   Cover a range that includes an overnight charge crossing midnight, to exercise both the
   interval-attribution and `prevAmps`-seed paths.
2. **Isolated boot.** Run with TEST-NET meter IPs (`192.0.2.x`), no `.env`, WC and SolaX
   disabled, on a spare port, against a copy of the real DB. `lastAction` must read
   `waiting for meters`, which guarantees the control loop returns before any Tesla
   command path.
3. **API.** `/api/stats` across every range and offset, including bad input
   (`range=bogus`, `offset=-5`, `offset=99999`).
4. **Timing.** Re-measure month/all after rollups; confirm sub-100ms and no event-loop
   stall.
5. **Browser (Playwright).** Both pages: switch ranges, step prev/next, confirm the label
   and tiles track. Toggle Pause and confirm all four controls vanish and return.
6. **Live host.** Not covered by any of the above. Deploy is `home-dashboard` on the second
   PC; `state.override` and `state.mode` are in-memory, so a restart drops them and any
   active charge must have its override re-asserted.

## Out of scope

- **Historical phantom `charge_w`.** Samples recorded before the phantom-charge fix keep
  inflated peaks (21% of June samples carry `charge_w` > 100 W with `charging = 0`). They
  cannot be separated from real WC-measured conditioning draw — no source discriminator is
  stored. Rollups computed from those samples inherit the inflation. Forward-only.
- **`main` / `home-dashboard` divergence.** The branches sit ~35 and ~51 commits apart with
  duplicated-but-distinct commits on each side, so every change costs a double-port and a
  semantic-conflict review. Worth addressing separately.
