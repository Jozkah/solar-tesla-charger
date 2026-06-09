# Home dashboard — deep dive

This document covers the `/home` page and its three backend modules: cameras
(`server/cameras.js`), smart plugs (`server/kasa.js`), and weather
(`server/weather.js`). For the project overview and the base charger, see the
top-level [`README.md`](../README.md).

## Contents

- [The `/home` page](#the-home-page)
- [Cameras (Agent DVR)](#cameras-agent-dvr)
- [Smart plugs (Kasa + Tapo)](#smart-plugs-kasa--tapo)
- [Weather](#weather)
- [How it plugs into the live state](#how-it-plugs-into-the-live-state)

---

## The `/home` page

Files: `public/home.html`, `public/home.js`.

The home page is the default landing page (`/` and `/home` both serve `home.html`;
`server/index.js`). It is a single-file, mobile-first page with an iOS-styled dark
("Liquid Glass") theme, Tailwind loaded from a CDN, and no build step.

### Live data flow

`home.js` opens an `EventSource` on `/api/stream`. Each SSE tick carries the full
shared state from `controller.js`. If SSE errors, it falls back to polling
`/api/state` every 3 s and shows a "reconnecting" indicator. From each state object it
renders:

- **Energy summary** — `renderEnergy()` reads `state.meters` (and `state.solax`):
  - **Solar (kW)** — `solarTotal()`: the Growatt clamp (`meters.solarPanels2`, negative
    = generating) plus SolaX AC power when available, otherwise the floor-1 channel as a
    fallback.
  - **Grid (W)** — `meters.gridPower` (positive = import, negative = export) shown as an
    absolute value with an "importing" (red) / "exporting" (green) label.
  - **House (kW)** — estimated consumption: `max(0, solar + gridPower)`.
- **Smart plugs** — `renderPlugs()` reads `state.kasa` (cards are (re)built when the
  set of plug keys changes). See [Smart plugs](#smart-plugs-kasa--tapo).
- **Camera status line** — `renderCamStatus()` reads `state.cameras` (reachability
  only); the actual camera list comes from a separate `/api/cameras` call.

### Power chart

`loadChart()` fetches `/api/series?hours=<1|6|24>` and draws Export / Solar / Import on
a `<canvas>` with a hover crosshair + tooltip (pointer events) and a range segmented
control. Refreshes every 20 s. Solar per-point is computed the same way as the live
summary (`seriesSolar()`).

### Weather

`loadWeather()` fetches `/api/weather` and renders the current conditions, an hourly
strip, and a 7-day grid; the "14-day ›" button (and tapping the card) opens a modal
sheet listing all forecast days with sunrise/sunset. Refreshes every 10 min.

### Cameras

- **Tiles** poll `/api/cameras/:oid/snapshot?t=<ts>` roughly once per second
  (`REFRESH_MS = 900`) using a throwaway `Image()` probe, so a failed frame marks the
  tile "No signal" without tearing down the poller. Polling pauses while the tab is
  hidden. This avoids holding many permanent MJPEG connections (which would hit the
  browser's ~6-per-host limit and blank tiles).
- **Fullscreen viewer** is the one live MJPEG stream:
  `/api/cameras/:oid/stream?size=1280x720`. It's cleared on close (Esc or tapping the
  backdrop) so the stream is released.
- The camera list is fetched once via `/api/cameras`; if it comes back empty it retries
  once after 3 s (discovery may not have completed yet).

---

## Cameras (Agent DVR)

File: `server/cameras.js`. Routes in `server/index.js`.

[Agent DVR](https://www.ispyconnect.com/) runs locally (default
`http://localhost:8090`) and exposes:

- `GET /command.cgi?cmd=getObjects` — JSON object list (cameras, mics, …).
- `GET /video.mjpg?oids=<oid>` — per-camera MJPEG (multipart) stream.
- `GET /grab.jpg?oid=<oid>` — single JPEG snapshot.

### Discovery + reachability

`refreshStatus()` calls `getObjects` once and does double duty:

- **Discovery** — objects with `typeID === 2` are cameras (`typeID 1` = microphone);
  their `id` becomes the camera **oid** and `name` the display name. Discovered cameras
  replace the config list when present.
- **Reachability** — a successful response sets `status.reachable = true`. Status is
  `{ enabled, reachable, count, ts }` and is exposed via `getStatus()` (folded into the
  live state as `state.cameras` and shown on the page status line).

It runs on the `statusPollSec` timer (default 45 s; `controller.js` `start()`).

### The config list (`cameras.list`)

Auto-discovery is the primary source. `cameras.list` (`[{ oid, name }]`) is used only:

- as a **fallback** if discovery hasn't succeeded, and
- to **override a camera's display name** by oid.

`cameras.exclude` (array of oids) hides specific cameras (e.g. a leftover test camera;
the default config excludes oid `7`).

### Credential safety + proxying

The browser never receives the raw Agent DVR URL or any credentials. The server builds
the upstream URLs **server-side only**:

- `upstreamStreamUrl(oid, size)` → `${host}/video.mjpg?oids=<oid>&size=<size>&un=&pwd=`
- `upstreamSnapshotUrl(oid, size)` → `${host}/grab.jpg?oid=<oid>&size=<size>&un=&pwd=`

(`&un=&pwd=` are only appended when `cameras.auth.user` is set.) `listCameras()` returns
only the **proxy** URLs (`/api/cameras/:oid/stream` and `/snapshot`).

Proxy routes (`server/index.js`):

| Route | Behavior |
|-------|----------|
| `GET /api/cameras/:oid/stream` | Pipes the never-ending MJPEG multipart stream through `undici` with client timeouts disabled (`headersTimeout: 0`, `bodyTimeout: 0`); destroys the upstream when the client disconnects. Also makes streams reachable from a phone on the LAN (the phone hits this server; the server reaches Agent DVR on localhost). |
| `GET /api/cameras/:oid/snapshot` | Returns Agent DVR's `/grab.jpg` (6 s timeout). If that endpoint isn't available on the build, falls back to `grabFrame()`, which reads the MJPEG stream until it sees one complete JPEG (SOI `0xFFD8` … EOI `0xFFD9`). |

### Config keys

`enabled`, `host`, `auth.user` / `auth.pass`, `snapshotSize`, `statusPollSec`,
`timeoutMs`, `exclude`, `list`. Env overrides: `CAMERAS_HOST`, `CAMERAS_USER`,
`CAMERAS_PASS` (only needed if Agent DVR requires a login — Server Settings → Users).

---

## Smart plugs (Kasa + Tapo)

File: `server/kasa.js`. Routes in `server/index.js`.

Controls TP-Link plugs **locally**, no cloud round-trip. Protocol is chosen per-plug
via the `protocol` config key.

### Kasa (legacy)

`protocol: "kasa"` (default). Legacy HS100 / HS110 / KP115 over TCP port 9999, via the
`tplink-smarthome-api` package. No account needed. Devices are cached by IP. Where the
device supports an energy meter (`supportsEmeter`), reads include voltage, current,
power, and total kWh (normalized from the device's `*_mv` / `*_ma` / `*_mw` / `*_wh`
fields).

### Tapo (KLAP)

`protocol: "tapo"`. Newer P100 / P110 / P115 over the **KLAP / secure-passthrough**
protocol, via `tp-link-tapo-connect` (`loginDeviceByIp`). This local handshake needs
the TP-Link (Tapo) **account email + password** — `TAPO_EMAIL` / `TAPO_PASSWORD` in
`.env`. They authenticate the *local* handshake, not a cloud call. If they're missing,
the plug reports `login failed — check TAPO_EMAIL / TAPO_PASSWORD`. Logged-in handles
are cached per plug key and dropped + re-logged-in automatically when a session
expires. Energy-capable Tapo plugs (P110/P115) report power (W) and today's kWh;
P100/P105 have no meter and simply omit those fields.

### Caching, control, errors

- `getCached()` is used by the live loop and never blocks: it returns the cache and
  triggers a background `refresh()` when the cache is older than `kasa.pollSec`
  (default 5 s). `refresh()` reads every plug in parallel (`Promise.all`), so one slow
  plug doesn't block the rest; an inflight guard prevents overlapping refreshes.
- `setState(key, on)` switches a plug by its config `key`. It rejects unknown keys and
  any plug with `controllable: false`, then refreshes so the next `/api/state` + SSE
  tick reflects the new state. Exposed at `POST /api/kasa/:key` with body
  `{ on: boolean }`.
- Errors are normalized by `cleanErr()` into short, friendly strings ("offline /
  unreachable", "login failed — check TAPO_EMAIL / TAPO_PASSWORD", or a truncated
  message) and shown per-card.

### Config keys

`kasa.enabled`, `kasa.pollSec`, `kasa.timeoutMs`, and `kasa.plugs[]` with fields
`key`, `label`, `ip`, `role`, `controllable`, `protocol`. The `role` drives the card
icon and, for `water_heater`, a confirm dialog before switching. `TAPO_EMAIL` /
`TAPO_PASSWORD` (in `.env`) feed the merged `kasa.tapo` object used by the Tapo path.

---

## Weather

File: `server/weather.js`. Route: `GET /api/weather`.

Fetches from [Open-Meteo](https://open-meteo.com/) — free, **no API key**:

- **Current conditions** — temperature, apparent temperature, humidity, day/night,
  weather code, cloud cover, wind, and shortwave radiation (useful solar context).
  Refreshed at most once per `pollMin` (default 10 min).
- **Forecast** — hourly (next ~24 h) and daily (14 days: max/min temp, precip
  probability, sunrise/sunset). Refreshed at most once per `forecastMin` (default 30
  min). The hourly list is aligned to the location's local hour using the API's UTC
  offset.

Both cache by location and key off `weather.lat` / `weather.lon` in `config.json` (or
the car's location when supplied to the endpoint). WMO weather codes are mapped to an
emoji icon + label. `getCached()` / `getForecast()` never block — they serve the cache
and refresh in the background. Set `weather.enabled: false` to disable.

---

## How it plugs into the live state

`controller.js` owns the shared `state` and the timers. On each **live-loop** tick
(~2 s) it folds the home-dashboard sources into the state the dashboards consume:

```js
state.kasa     = kasa.getCached();      // cached plug state (background refresh)
state.cameras  = cameras.getStatus();   // reachability only; video flows via proxy routes
state.weather  = weather.getCached(...); // cached current conditions
```

Camera **reachability/discovery** runs on its own `statusPollSec` timer
(`cameras.refreshStatus()`), separate from the video proxy routes. The page consumes
`state.kasa` and `state.cameras` over SSE, and calls `/api/cameras`, `/api/weather`,
and `/api/series` directly for the heavier payloads (camera list, full forecast, chart
series).
