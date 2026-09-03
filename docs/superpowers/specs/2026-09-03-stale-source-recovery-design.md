# Stale source detection and recovery — design

Date: 2026-09-03. Branch: `hd-stale-source-recovery` (base `home-dashboard`).

## Problem

On 2026-09-03 a Tailscale setting cut the dashboard host off the LAN for about
six hours. `shelly.readMeters()` failed every tick, `liveCycle` only set
`state.lastError`, and `state.meters` kept the last successful reading. The
control loop went on writing that frozen reading to `samples` every 10 s and
kept making charging decisions from it. The chart showed six hours of perfectly
flat solar, house, car and import lines; daily totals and cost were wrong; the
UI gave no hint anything was stale.

The same failure shape exists for the Wall Connector after its 15 s grace
window, for the car snapshot (already partly covered by `car.stale` and PR #12),
and for the SolaX cache.

## Goals

1. Never record or act on a reading the server knows is stale or frozen.
2. Make staleness visible: API, banner, tiles, chart gap.
3. Recover the lost meter history for outages longer than 10 minutes from the
   Shelly EM's own on-device energy log, so totals and cost stay right.
4. Keep polling robust to single blips: retry, then fall back to the per-channel
   endpoint before declaring the device down.

Non-goals: recovering car or Wall Connector history (neither device keeps any),
changing the charging decision logic beyond "hold while blind", and changing
sample cadence or retention.

## Facts verified on the hardware

Shelly EM Gen1 (`SHEM`, fw v1.14.0, 192.168.1.10 and .11):

- `GET /status` returns `emeters[n]` with `power`, `voltage`, `pf`, `total`
  (Wh consumed, monotonic), `total_returned` (Wh), `is_valid`.
- `GET /emeter/{n}` returns the same fields for one channel.
- `GET /emeter/{n}/em_data.csv` streams the device's energy log:
  header `Date/time UTC,Active energy Wh (1),Returned energy Wh (1),Min V,Max V`,
  one row per 10 minutes, oldest first, starting 2026-05-14. About 8 KB/s, so
  the full log takes several minutes. The `date_range` query parameter is
  ignored. A second concurrent download on the same device is refused with the
  body `Another file transfer is in progress!`.

## Components

### `server/freshness.js` (pure, unit tested)

```js
meterSignature(meters)            // string: grid.totalWh + every channel power
isActive(meters, minW = 50)       // any channel |power| >= minW
resolveFreshness({ okAt, failedSince, sigChangedAt, active, nowMs, maxAgeMs, freezeMs })
  // -> { fresh: boolean, reason: null | 'unreachable' | 'frozen', sinceMs }
```

A source is stale when its last successful read is older than `maxAgeMs`, or
when it is `frozen`: the signature has not changed for `freezeMs` while the
meter shows real activity. A quiet house with an idle counter is not frozen.
Defaults: meters `maxAgeMs` 30 s, `freezeMs` 5 min, `minW` 50 W.

### `server/shelly.js`

`readDeviceWith(dev, timeoutMs, fetchImpl, backoffMs)` (testable): try
`/status`; on failure wait `backoffMs` (250 ms) and retry once; on a second
failure try `/emeter/{i}` for each configured channel and assemble the same
shape. Only when every path fails does the device report `error`. `readMeters`
still throws when the grid channel has no reading.

### `server/controller.js`

- Track `metersOkAt`, `metersFailedSince`, `metersSigChangedAt`.
  `liveCycle` success: update `metersOkAt`, clear `metersFailedSince`, bump
  `metersSigChangedAt` when the signature changes. Failure: set
  `metersFailedSince` once. `state.meters` is no longer replaced on failure,
  but `state.stale` now says so.
- `state.stale = { meters: {fresh, reason, sinceMs} , wcAgeMs, carAgeMs }`
  recomputed every live tick and included in `/api/state` and the SSE stream.
- Control tick: when meters are stale, set `lastAction` to
  `meters stale <n>m`, remember `gapStart` (the `ts` of the last recorded
  sample), and return before decisions, commands, session tracking and
  `recordSample`. No row is written, so the chart and the rollups see a gap
  instead of a plateau.
- When meters become fresh again and the gap is at least
  `BACKFILL_MIN_GAP_MS` (10 min), call `backfill.schedule(gapStart, now)`.
  Never blocks the loops.

### `server/backfill.js`

- `parseEmData(csv)` (pure): rows `{ ts, wh, returnedWh, minV, maxV }`; `ts`
  is the UTC bucket start in ms. Malformed lines are skipped.
- `bucketsToSamples({ channels, from, to })` (pure): `channels` maps a sample
  column (`grid`, `floor1`, `floor2`, `solarPanels2`) to its parsed rows.
  Bucket interval is derived from the rows (median gap, expected 600 s).
  Signed power per bucket is `(wh - returnedWh) / hours`, matching the live
  sign convention (positive = consumption or import). Emits one sample per
  bucket that starts inside `[from, to)` with `grid_power`, `export_w`,
  `import_w`, `floor1_w`, `floor2_w`, `solar2_w`, `voltage` (mean of min and
  max), `charging 0`, `charge_w 0`, `solax_w 0`, `mode 'backfill'`,
  `action 'backfill'`. The car cannot be recovered, so its share is not
  guessed.
- `fetchEmData(ip, index, { timeoutMs = 10 min, fetchImpl })`: one download;
  the body `Another file transfer is in progress!` is an error.
- `schedule(from, to)`: single-flight. Runs the two devices in parallel and
  their two channels sequentially. Inserts with `INSERT OR IGNORE` so a live
  row that already exists at that `ts` wins, then deletes the `daily_stats`
  rows for every day touched so the next read recomputes them. On failure it
  retries up to three times, five minutes apart. Exposes
  `status()` as `state.backfill = { running, last: { from, to, rows, error, at } }`.

### `server/db.js`

`recordSampleIgnore(s)` (`INSERT OR IGNORE`), `deleteDayRollup(dayTs)`.

### `server/stats.js`

`getSeries` inserts `{ ts, gap: true }` between two consecutive rows more than
`SERIES_GAP_MS` (90 s) apart. The pure helper `withGaps(rows, gapMs)` is unit
tested.

### Frontend

- `public/app.js` and `public/home.js`: a `gap` point ends the current path
  and starts a new one; area fills are drawn per contiguous segment. The hover
  tooltip ignores gap points.
- Banner on both pages while `state.stale.meters.fresh` is false:
  `Meters unreachable since 12:03` or `Meters frozen since 12:03`. Live power
  tiles show a dash instead of the last value while stale. A short note shows
  while a backfill is running or after one finished (`Recovered 36 rows`).

## Error handling

- A backfill that fails leaves the gap as a gap; nothing is invented.
- Backfill never overwrites live rows.
- A stale gate that flaps (fresh, stale, fresh within a minute) produces at
  most one gap of a few rows and no backfill (below the 10 min threshold).
- The freeze detector cannot fire on a legitimately idle house because it
  requires activity above `minW`.

## Testing

`node --test`, pure modules only, no network:

- `test/freshness.test.js`: fresh, unreachable past max age, frozen only when
  active, idle counter never frozen, signature changes reset the timer.
- `test/shelly-read.test.js`: status ok; status fails once then ok; status
  fails twice then per-channel fallback; everything fails reports error.
- `test/backfill.test.js`: CSV parsing (header, blank lines, bad rows), bucket
  interval detection, sign convention, window clipping, voltage mean.
- `test/series-gaps.test.js`: gap markers inserted only across real holes.

Manual: cut the Shellies off (block the two IPs in the firewall for 15 min),
watch the banner, the chart gap, the `meters stale` action, and the backfill
filling the gap afterwards.
