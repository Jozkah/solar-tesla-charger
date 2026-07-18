# Efficiency & Fuel comparison section — design

**Date:** 2026-07-18
**Worktree / branch:** `energy-monitoring-home` on `home-dashboard` (synced to `828acce`, PR #10)
**Feature branch:** `feat/fuel-vs-petrol` (off `home-dashboard`)

## Goal

New section on the charger page (`/charger`) between the Statistics pills and
"Vehicle & charging". For the selected range (session / day / week / month /
billing / all) it shows:

- **Average Wh/km** — one lifetime figure from TeslaMate (see below), not
  per-range.
- **km** = `chargedKwh ÷ avgWhPerKm`. The distance that charge is worth.
  We deliberately do **not** sum per-drive odometer distance: TeslaMate does not
  record every drive, so a distance *total* undercounts. Deriving km from
  charged energy sidesteps that entirely.
- What those km would cost in **petrol** (98) at **10 L/100km**.
- How that compares to what the charging actually cost (grid **Charge cost**),
  i.e. money **saved vs petrol**.

## Data sources (all already reachable in this worktree)

| Value | Source |
|---|---|
| Charged kWh / range | existing `getStats().car.energyWh` (samples → rollup) |
| Grid charge cost / range | existing `getStats().chargeCost.total` (band tariff) |
| Average Wh/km (lifetime) | **new** — TeslaMateApi `GET /api/v1/cars/{carId}/drives`; energy-weighted `Σ energy_consumed_net ÷ Σ odometer_distance` over recent drives (a ratio, so missing drives cancel out); fallback `FALLBACK_WH_PER_KM` |
| 98 price | **new** — DGEG `PesquisarPostos`, **national** avg of `Gasolina especial 98`, cached daily, constant fallback |

**km is never a distance sum.** Odometer distance is used only inside the Wh/km
*ratio* (numerator and denominator both drop untracked drives, so the ratio is
unaffected). The displayed km comes from `chargedKwh ÷ avgWhPerKm`.

TeslaMateApi client (`tmaUrl` / `tmaHeaders`, config `tesla.teslamateapi.{baseUrl,carId,token}`)
is reused from `server/tesla.js`. DGEG cert is broken → fetch it through an
undici `Agent({ connect: { rejectUnauthorized: false } })` scoped to that host only.

## Architecture

Two small, isolated server modules + one thin route. Kept **separate** from
`/api/stats` so a DGEG or TeslaMate hiccup degrades to "—" without touching the
stats/cost tiles.

- **`server/drives.js`** — `avgWhPerKm()` → `{ whPerKm, estimated }`. Pulls
  recent drives once, energy-weights `Σ energy_consumed_net ÷ Σ odometer_distance`
  (respects TeslaMate `unit_of_length`; mi→km if needed; skips null/imprecise
  drives). Cached ~daily in memory. Returns `{ whPerKm: FALLBACK, estimated:true }`
  when TeslaMate is unreachable or has no usable drives. **No per-range call** —
  one lifetime average, applied to every range's chargedKwh.
- **`server/fuel.js`** — `fuel98Price()` → `{ price, currency:'EUR', date,
  scope:'national', stale }`. Fetches all 18 districts once/day, filters
  `Gasolina especial 98`, averages. Cached in memory (+ optional JSON on disk).
  Falls back to `FUEL_FALLBACK_EUR_L` (2.194) on failure.
- **Route `GET /api/fuel`** (`server/index.js`) → `{ whPerKm, whPerKmEstimated,
  price, currency, priceDate, priceScope, priceStale, iceLPer100 }`. No range
  params needed — the average Wh/km and price are period-independent. On any
  internal failure returns `200` with fallbacks (never breaks the page). Fetched
  once on page load (values change ~daily), not on every range switch.

km, petrol cost and "saved" are computed **client-side** in `renderFuel` from
`st` (already fetched, per range) + this response — the server route stays pure
(avg Wh/km + price), no re-derivation of stats/cost.

## Front-end

- `public/index.html`: new `<section>` after line 272 (end of Statistics),
  before line 274 (Vehicle & charging), with `<div id="fuelGrid" class="grid
  grid-cols-3 gap-3">` + a caption line for the price source.
- `public/app.js`:
  - `renderFuel(st, fuel)` — builds `[label,value,unit]` tiles with the existing
    `.glass rounded-2xl` template (same as `renderStats`).
  - `/api/fuel` is fetched once on load and its result cached in a module var;
    the `onData` handler (currently `onData: renderStats`, app.js:605-618) also
    calls `renderFuel(st, fuelCache)` on every range change so km/costs track the
    selected range. Missing fuel data renders tiles as "—".

**Tiles (4) + caption:**
1. `Wh/km` — lifetime avg (fallback 200, marked `~` when estimated)
2. `km` — `energyWh / whPerKm` (distance the charge is worth)
3. `Petrol cost` — `km/100 × 10 L × price` €
4. `Saved vs petrol` — `petrolCost − chargeCost.total` €
- caption: `98 @ 2.20 €/L · national avg · upd <date>` (`est.` if fallback)

Notes:
- km uses total charged kWh (solar+grid); electricity side uses
  `chargeCost.total` (grid only — solar is free), so "saved" is the true money
  delta. This is intentional and stated in the caption/labels.
- Wh/km is one lifetime average applied to every range; only chargedKwh (and
  thus km, petrol cost, saved) varies by range.

## Config (constants + `.env`, no settings-UI change)

New keys in `server/config.js` (+ `.env.example`), tunable without code:
- `FUEL_DISTRICT_SCOPE` = `national` (or a district id later)
- `FUEL_TYPE` = `Gasolina especial 98`
- `FUEL_FALLBACK_EUR_L` = `2.194`
- `ICE_L_PER_100KM` = `10`
- `FALLBACK_WH_PER_KM` = `200`

(Promotion to the existing tariff/settings panel is possible later; out of scope now.)

## Testing

- `server/drives.js`: unit-test the energy-weighted Wh/km ratio (mi→km handling,
  null/imprecise drives skipped, no-drives → fallback `estimated:true`) with a
  stubbed fetch. Include a case proving a missing drive doesn't move the ratio.
- `server/fuel.js`: unit-test price parse (`"2,201 €/litro"`, mojibake `€`),
  national averaging, fallback on fetch failure.
- Manual: load `/charger`, switch ranges, confirm km/petrol/saved track the
  range and that killing DGEG/TeslaMate degrades to "—"/fallback without
  breaking stats.

## Out of scope

- Persisting odometer into `samples` (drives API already gives real distance).
- Porting anything between worktrees (target already has cost/tariff/billing).
- A fuel-price settings UI (constants for now).
