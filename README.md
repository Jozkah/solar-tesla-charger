# ☀️🏠 Solar-Aware Tesla Charger + Home Dashboard

A self-hosted Node.js service that turns your home energy data into two things:

1. **A solar-aware Tesla charger** — it reads your home energy meters and solar
   inverters in real time and automatically trims your **Tesla's charging amperage**
   to soak up your **solar surplus**, always keeping a small export buffer so you're
   never paying the grid to charge the car.
2. **A home dashboard** (`/home`) — a single mobile-first page that puts your
   **security cameras** (Agent DVR) and **smart plugs** (TP-Link Kasa / Tapo) next to
   the same live energy view, weather, and power chart.

Everything runs on your LAN and is meant to be opened from your phone over Wi-Fi.
There is no cloud account for this app, no build step, and no authentication — keep
it on your local network only.

> **Local-first & private.** All credentials live in a gitignored `.env`. Device
> IPs (cameras, plugs, meters) are **local-LAN addresses, not secrets**, so they live
> in `config.json`. Only credentials (tokens, account passwords) go in `.env`.

---

## Table of contents

- [What's on this branch](#whats-on-this-branch)
- [Pages](#pages)
- [Architecture](#architecture)
- [The base charger (briefly)](#the-base-charger-briefly)
  - [How the control loop works](#how-the-control-loop-works)
  - [Tesla backends](#tesla-backends)
- [Home dashboard](#home-dashboard)
  - [The `/home` page](#the-home-page)
  - [Cameras (Agent DVR)](#cameras-agent-dvr)
  - [Smart plugs (Kasa + Tapo)](#smart-plugs-kasa--tapo)
  - [Weather](#weather)
- [Setup & running](#setup--running)
- [Configuration reference](#configuration-reference)
- [HTTP API reference](#http-api-reference)
- [Running always-on (Windows)](#running-always-on-windows)
- [Security notes](#security-notes)
- [Further docs](#further-docs)

---

## What's on this branch

This is the `home-dashboard` branch. It contains the full base charger **plus** the
home-dashboard feature:

- A new **`/home`** page (`public/home.html` + `public/home.js`) that is now the app's
  landing page. The charger UI moved to **`/charger`**.
- **Security-camera tiles** backed by a local [Agent DVR](https://www.ispyconnect.com/)
  server (`server/cameras.js`).
- **Smart-plug controls** for TP-Link **Kasa** (legacy) and **Tapo** (KLAP) plugs
  (`server/kasa.js`).
- A **weather** card with current conditions and a 14-day forecast
  (`server/weather.js`, Open-Meteo, no API key).

> This branch does **not** include the later charging-UX work (sticky live-adjust
> override, solar-vs-override warning, time-to-full ETA tiles, benign-command
> handling). Those live on a different branch and are intentionally not documented here.

---

## Pages

| Path        | Served file         | What it is |
|-------------|---------------------|------------|
| `/`, `/home`| `public/home.html`  | **Home dashboard** — energy summary, power chart, weather, cameras, smart plugs. The default landing page. |
| `/charger`  | `public/index.html` | The solar-aware **Tesla charger** dashboard (auto/manual amps, stats, scheduling). |

Both pages share the same backend, the same live state, and the same Server-Sent
Events stream (`/api/stream`).

---

## Architecture

```
server/
  index.js          Express app: REST API, SSE stream, static pages, camera proxy, boot
  config.js         Merges config.json + .env into one validated config object
  controller.js     Live loop (~2s) + control loop (~10s) + gentle car loop (~90s)
  shelly.js         Polls the two Shelly EM (Gen1) meters
  wallconnector.js  Reads the Tesla Wall Connector (Gen 3) local vitals API
  tesla.js          Car data + commands (TeslaMateApi or Fleet API proxy backend)
  teslaAuth.js      Tesla Fleet API OAuth third-party-token manager
  solax.js          SolaX Cloud client (cached)
  weather.js        Open-Meteo current conditions + 14-day forecast (cached)
  cameras.js        Agent DVR: reachability, camera discovery, upstream stream/snapshot URLs
  kasa.js           TP-Link Kasa + Tapo smart plugs (local control, cached)
  notify.js         Push notifications (ntfy / Pushover / Telegram)
  stats.js          Aggregations for the statistics panel and charts
  db.js             SQLite (node:sqlite) sample/session storage
public/
  home.html, home.js     Home dashboard
  index.html, app.js     Tesla charger dashboard
  tesla.html             Tesla OAuth helper page
  style.css
config.json         Non-secret config (IPs, limits, buffers, poll intervals, camera/plug lists)
.env                Secrets (gitignored) — see .env.example
data/               SQLite DB + schedule.json (gitignored)
```

**Stack:** Node.js ≥ 18 (built-in `node:sqlite`, native `fetch`), Express, `undici`
(camera proxying), `dotenv`, `tplink-smarthome-api` (Kasa), `tp-link-tapo-connect`
(Tapo). No build step.

---

## The base charger (briefly)

The charger lives at `/charger`. Its job is to keep your Tesla charging on **solar
surplus** without exporting power you could be using, and without dipping into the
grid. It reads several data sources, each optional and degrading gracefully:

| Source | Transport | Used for |
|--------|-----------|----------|
| Shelly EM (Gen1) ×2 | local HTTP (`/status`) | grid + per-circuit power/voltage/PF (`server/shelly.js`) |
| Tesla Wall Connector (Gen 3) | local HTTP vitals | live charging amps/voltage/state/plugged (`server/wallconnector.js`) |
| Tesla (car data + commands) | TeslaMateApi **or** Fleet API proxy | set amps, start/stop, SoC, limits, location |
| SolaX inverter | SolaX Cloud API | second solar array generation |
| Growatt inverter | Shelly clamp (real-time) | first solar array generation |

State is held in `controller.js` and pushed to both dashboards over Server-Sent
Events. Samples and charging sessions are persisted to SQLite for the stats panel and
charts.

### How the control loop works

`controller.js` runs three timers:

- **Live loop** (`livePollSec`, ~2 s) — reads the Shelly meters and the Wall
  Connector, refreshes cached sources (SolaX, weather, smart plugs, camera status),
  recomputes the surplus/target, updates `state`, and emits an `update` event. **No
  Tesla calls.**
- **Control loop** (`pollIntervalSec`, ~10 s) — makes the charging decision and sends
  commands to the car, then persists a sample to SQLite.
- **Car loop** (`carPollSec`, ~90 s) — gently refreshes car telemetry (battery %,
  limits, temps, location) so the app doesn't wake/poll the car every cycle.

Single-phase, with the charging voltage read live. The car's draw is already inside
the grid meter, so:

```
exportW  = max(0, -gridPower)              # power currently flowing to the grid
surplusW = exportW + chargeW - bufferWatts # power we could feed the car, keeping the buffer
amps     = clamp(floor(surplusW / voltage), minAmps, ampCeiling)
```

`ampCeiling` is the lowest of `maxAmps`, the car's reported max, and the user-set auto
cap. A hysteresis margin (`resumeMarginWatts`) avoids flapping; when surplus can't
sustain `minAmps` and `stopWhenInsufficient` is on, charging pauses and auto-resumes
when the sun returns. A manual **override** holds a fixed amperage, and an optional
**overnight schedule** forces a fixed grid charge inside a time window.

### Tesla backends

Set `tesla.backend` in `config.json`:

- **`teslamateapi`** (default) — point at a running
  [TeslaMateApi](https://github.com/tobiasehlert/teslamateapi) instance. It reuses
  your TeslaMate tokens and command host. Configure `TESLAMATEAPI_*` in `.env`.
- **`proxy`** — talk to the official Fleet API directly through a self-hosted
  `tesla-http-proxy` for signed commands. Authorize via `/api/tesla/login`, set the
  `TESLA_*` vars in `.env`.

If neither is configured, the app runs **monitor-only** (full dashboard, no car
control). For the full charger details, see `public/index.html` and the inline docs in
`server/controller.js` / `server/tesla.js`.

---

## Home dashboard

### The `/home` page

`public/home.html` + `public/home.js`. A single mobile-first page (iOS-styled "Liquid
Glass" dark theme, Tailwind via CDN) that connects to `/api/stream` for live updates
(falling back to polling `/api/state` every 3 s if SSE drops). It renders:

- **Energy summary** — three tiles: **Solar** (kW), **Grid** (W, with an
  importing/exporting label), and **House** (estimated consumption, kW). Solar is
  derived from the Growatt Shelly clamp plus SolaX (or the floor-1 channel as a
  fallback). These come from the shared live state, not extra requests.
- **Power chart** — a canvas chart of **Export / Solar / Import** with a hover
  crosshair + tooltip and 1h / 6h / 24h range buttons. Data comes from `/api/series`
  and refreshes every 20 s.
- **Weather** — current conditions plus an hourly strip and a 7-day grid; tap for a
  14-day forecast sheet. From `/api/weather`, refreshed every 10 min.
- **Cameras** — a responsive grid of tiles. Each tile **polls a JPEG snapshot** (~1
  fps) rather than holding a permanent MJPEG stream, which avoids exhausting the
  browser's ~6-connections-per-host limit. Tapping a tile opens a **fullscreen viewer**
  that is the one live MJPEG stream (full-res, cleared on close). A status line shows
  "N cameras · Agent DVR live" or "Agent DVR offline".
- **Smart plugs** — one card per plug with an on/off toggle, live power (W), and
  voltage / today / total energy where the plug reports it. Plugs flagged with the
  `water_heater` role show a confirm dialog before switching. Cards reflect optimistic
  state while a switch is in flight and surface per-plug errors inline.

A `⚡ Tesla` button in the header links to `/charger`.

### Cameras (Agent DVR)

`server/cameras.js` integrates with a local **Agent DVR** server (default
`http://localhost:8090`). Agent DVR serves a per-camera MJPEG stream at
`/video.mjpg?oids=<oid>` and a single JPEG at `/grab.jpg?oid=<oid>`.

Key behaviors:

- **Auto-discovery** — cameras are discovered from Agent DVR's
  `command.cgi?cmd=getObjects`. Objects with `typeID === 2` are cameras; their `id`
  is the **oid**. The `cameras.list` config is only a fallback (if discovery fails) and
  a way to override a camera's display name by oid. `cameras.exclude` hides specific
  oids (e.g. a leftover test camera).
- **Reachability + discovery in one call** — `refreshStatus()` (run on the
  `statusPollSec` timer, default 45 s) probes `getObjects`; the result populates both
  the reachability flag and the discovered camera list. Status (`{ enabled, reachable,
  count, ts }`) is what the page's status line shows.
- **Credential safety** — the browser is **never** handed the raw localhost URL or any
  credentials. The server builds upstream URLs (`upstreamStreamUrl` /
  `upstreamSnapshotUrl`, optionally with `&un=&pwd=` auth) **server-side only** and
  exposes proxy routes instead. This is also what makes streams/snapshots work from a
  phone on the LAN (the phone hits this server; this server reaches Agent DVR on
  localhost).
- **Proxy routes** (see [API](#http-api-reference)):
  - `GET /api/cameras/:oid/stream` pipes the never-ending MJPEG multipart stream
    through (client timeouts disabled).
  - `GET /api/cameras/:oid/snapshot` returns a single JPEG via Agent DVR's
    `/grab.jpg`, falling back to grabbing one frame (SOI `0xFFD8` … EOI `0xFFD9`) from
    the MJPEG stream if `/grab.jpg` isn't available on that build.

Config block: `cameras.host`, `cameras.auth` (`user`/`pass`), `cameras.snapshotSize`,
`cameras.statusPollSec`, `cameras.timeoutMs`, `cameras.exclude`, `cameras.list`.
`CAMERAS_HOST` / `CAMERAS_USER` / `CAMERAS_PASS` in `.env` override host/auth (only
needed if your Agent DVR requires a login).

### Smart plugs (Kasa + Tapo)

`server/kasa.js` controls TP-Link smart plugs **locally** (no cloud round-trip). Each
plug picks its protocol via the per-plug `protocol` key:

- **`kasa`** (default) — legacy Kasa HS100 / HS110 / KP115 over TCP port 9999, via
  `tplink-smarthome-api`. No account needed.
- **`tapo`** — newer Tapo P100 / P110 / P115 over the **KLAP / secure-passthrough**
  protocol, via `tp-link-tapo-connect`. This local handshake needs your TP-Link (Tapo)
  account email and password — **`TAPO_EMAIL` / `TAPO_PASSWORD`** in `.env`. They're
  used for the local handshake, not a cloud call. Tapo session handles are cached and
  re-logged-in automatically when they expire. (Legacy Kasa plugs don't need this.)

Key behaviors:

- **Cached reads** — `getCached()` never blocks; it serves the cache and triggers a
  background `refresh()` when stale (older than `kasa.pollSec`, default 5 s). Reads
  pull on/off state and, where supported, power (W) and energy (today/total kWh). The
  live loop folds this cache into the shared state as `state.kasa`.
- **Control** — `setState(key, on)` switches a plug by its config `key`, rejects plugs
  marked `controllable: false`, then refreshes so the next `/api/state` + SSE tick
  reflects the change.
- **Errors** — per-plug errors are normalized to friendly strings (e.g. "offline /
  unreachable", "login failed — check TAPO_EMAIL / TAPO_PASSWORD") and shown on the
  card; one bad plug doesn't break the others.

Config block: `kasa.enabled`, `kasa.pollSec`, `kasa.timeoutMs`, and `kasa.plugs[]`
(each: `key`, `label`, `ip`, `role`, `controllable`, `protocol`).

### Weather

`server/weather.js` fetches current conditions and a 14-day forecast from
[Open-Meteo](https://open-meteo.com/) (free, **no API key**). Both are cached
(current refreshes ~every `pollMin`, forecast ~every `forecastMin`) and key off
`weather.lat` / `weather.lon` from `config.json` (or the car's location when
available). WMO weather codes are mapped to an emoji icon + label. Served at
`/api/weather`.

---

## Setup & running

**Requirements:** Node.js **≥ 18** (uses built-in `node:sqlite` and native `fetch`).

```bash
npm install                       # installs express, undici, dotenv, tplink-smarthome-api, tp-link-tapo-connect
cp config.json.example config.json # then edit your device IPs / channel map / lists
cp .env.example .env              # then fill in your values (credentials + WEATHER_LAT/LON)
npm start                         # serves on http://0.0.0.0:3000 (config.json server.port/host)
```

Open `http://<this-machine-LAN-IP>:3000` on your phone (same Wi-Fi); it lands on the
home dashboard. Allow inbound TCP 3000 through the firewall for LAN access.

What goes where:

- **`config.json`** — your device map and settings (IPs, channel map, camera/plug
  lists, limits). **Gitignored** — it holds your LAN layout, so it's not committed;
  copy `config.json.example` and edit it for your setup (see the reference below).
- **`.env`** — credentials only. Copy `.env.example` and fill in. Never commit it
  (it's gitignored). For the home dashboard you generally only need:
  - `TAPO_EMAIL` / `TAPO_PASSWORD` — **required if you have any Tapo plugs**.
  - `CAMERAS_USER` / `CAMERAS_PASS` (and optionally `CAMERAS_HOST`) — only if your
    Agent DVR requires a login.

> Tip: start the charger with `"dryRun": true` in `config.json` (or `DRY_RUN=1`) to
> watch computed amps without sending any commands to the car. The home dashboard,
> cameras, and plugs work regardless of dry-run.

---

## Configuration reference

### `cameras` (config.json)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch for the camera feature. |
| `host` | string | `http://localhost:8090` | Agent DVR base URL. Overridable with `CAMERAS_HOST`. |
| `auth.user` | string | `""` | Agent DVR username (only if login is required). Overridable with `CAMERAS_USER`. |
| `auth.pass` | string | `""` | Agent DVR password. Overridable with `CAMERAS_PASS`. |
| `snapshotSize` | string | `"640x360"` | `size=` query passed to Agent DVR for snapshots/streams (the fullscreen viewer requests `1280x720`). |
| `statusPollSec` | number | `45` | How often the server probes Agent DVR for reachability + discovery. |
| `timeoutMs` | number | `5000` | Timeout for the `getObjects` reachability probe. |
| `exclude` | number[] | `[7]` | Agent DVR oids to hide from the dashboard. |
| `list` | array | `[]` | Fallback/override list, `[{ oid, name }]`. Used only if auto-discovery fails, or to rename a camera by oid. |

Credentials end up in upstream URLs **server-side only** — they're never sent to the
browser.

### `kasa` (config.json)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch for the smart-plug feature. |
| `pollSec` | number | `5` | Max age of the plug cache before a background refresh. |
| `timeoutMs` | number | `3000` | Per-request timeout for legacy Kasa devices. |
| `plugs` | array | – | List of plugs (see below). |

Each entry in `kasa.plugs`:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `key` | string | – | Stable identifier used by `/api/kasa/:key` and the UI. Must be unique. |
| `label` | string | `key` | Display name on the card. |
| `ip` | string | – | Plug's LAN IP (not secret). |
| `role` | string | `"appliance"` | Tag used for the card icon and confirm prompt. `water_heater` shows a 🔥 icon + a confirm dialog before switching. |
| `controllable` | bool | `true` | If `false`, the toggle is rejected server-side (monitor-only). |
| `protocol` | string | `"kasa"` | `"kasa"` (legacy, port 9999) or `"tapo"` (KLAP, needs `TAPO_*`). |

### Relevant environment variables (`.env`)

| Var | Used by | Required? | Notes |
|-----|---------|-----------|-------|
| `TAPO_EMAIL` | smart plugs | If any `protocol: "tapo"` plug | TP-Link account email for the local KLAP handshake. |
| `TAPO_PASSWORD` | smart plugs | If any `protocol: "tapo"` plug | TP-Link account password. Used locally, not a cloud round-trip. |
| `CAMERAS_HOST` | cameras | Optional | Overrides `cameras.host`. |
| `CAMERAS_USER` | cameras | Only if Agent DVR has a login | Overrides `cameras.auth.user`. |
| `CAMERAS_PASS` | cameras | Only if Agent DVR has a login | Overrides `cameras.auth.pass`. |
| `PORT` / `HOST` | server | Optional | Override `server.port` / `server.host`. |
| `DRY_RUN` | charger | Optional | `1` forces no-command mode (safe for a second/test instance). |
| `TESLAMATEAPI_*`, `TESLA_*`, `SOLAX_*`, `NTFY_*`, … | charger | Per feature | See `.env.example` for the full base-charger list. |

> The `weather`, `solax`, `control`, `tesla`, and `shelly` blocks in `config.json`
> belong to the base charger. See `.env.example` and the inline comments in
> `server/config.js` for the full set.

---

## HTTP API reference

All routes are defined in `server/index.js`.

### Home dashboard

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET  | `/api/cameras` | – | `{ enabled, status, cameras[] }`. Each camera: `{ oid, name, stream, snapshot }` (proxy URLs only). |
| GET  | `/api/cameras/:oid/stream` | – | Proxies the live MJPEG stream from Agent DVR (used by the fullscreen viewer). `?size=` optional. |
| GET  | `/api/cameras/:oid/snapshot` | – | Single JPEG snapshot (used by the tiles, ~1 fps). Falls back to a frame grab. `?size=` optional. |
| GET  | `/api/kasa` | – | Cached smart-plug state: `{ enabled, plugs[] }`. |
| POST | `/api/kasa/:key` | `{ on: boolean }` | Switch a plug on/off. Returns the updated plug. |
| GET  | `/api/weather` | – | `{ current, forecast }` from Open-Meteo. `?lat=&lon=` optional (defaults to config). |

### Shared / base charger

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET  | `/api/state` | – | Live snapshot (meters, car, WC, SolaX, weather, kasa, cameras, computed target). |
| GET  | `/api/stream` | – | Server-Sent Events stream of live state (~2 s, plus a 25 s keepalive ping). |
| GET  | `/api/stats?range=today\|session\|all` | – | Aggregated statistics. |
| GET  | `/api/series?hours=N` | – | Downsampled time series for charts (N clamped to 1…720). |
| GET  | `/api/health` | – | `{ ok, ts }`. |
| GET  | `/api/events` | – | Recent charging events. |
| GET  | `/api/notify/pending` | – | **Drains** the queued charging notifications (for an Apple Shortcut poller). |
| GET  | `/api/notify/test` | – | Fires a test push to the configured channel. |
| POST | `/api/mode` | `{ mode:"auto"\|"pause" }` | Switch automation mode. |
| POST | `/api/override` | `{ amps, expiresInMin? }` | Hold a manual amperage. |
| POST | `/api/override/clear` | – | Drop the override. |
| POST | `/api/schedule` | `{ enabled, start, end, amps }` | Configure the overnight grid-charge window. |
| POST | `/api/maxamps` | `{ amps }` | Set the auto-charge ceiling. |
| POST | `/api/charge` | `{ action:"start"\|"stop" }` | Manual start/stop. |
| GET  | `/api/tesla/auth-status` | – | Tesla Fleet OAuth status. |
| GET  | `/api/tesla/login` | – | Start the Tesla Fleet OAuth flow (redirect). |
| GET  | `/api/tesla/callback` | – | OAuth redirect target (exchanges the code). |
| POST | `/api/tesla/exchange` | `{ code\|url, state? }` | Manual code exchange when the redirect lands elsewhere. |

See [`shortcuts/README.md`](shortcuts/README.md) for ready-made Apple Shortcuts.

---

## Running always-on (Windows)

Use Task Scheduler ("At log on" / "At startup", `node server\index.js`) or a service
wrapper like [NSSM](https://nssm.cc/). Give the machine a static DHCP lease so the LAN
IP (and your camera/plug links and Shortcuts) don't break.

---

## Security notes

- `.env` (Tesla tokens, SolaX keys, TP-Link account password, Agent DVR login, push
  tokens) is **gitignored** — keep it that way.
- `config.json` (your device IPs, channel map, coordinates were here) is **gitignored** —
  only `config.json.example` (placeholders) is committed. Home coordinates live in `.env`
  (`WEATHER_LAT`/`WEATHER_LON`), never in the tracked config.
- The dashboards and REST API have **no authentication** and the camera proxy will
  stream anything Agent DVR exposes — expose them on your **LAN only**. For remote
  access use a VPN / Tailscale, never a public port-forward.
- `data/` (the SQLite database and `schedule.json`) is gitignored.

---

## Further docs

- [`docs/home-dashboard.md`](docs/home-dashboard.md) — deep dive on cameras, smart
  plugs, weather, and the `/home` page internals.
- [`docs/configuration.md`](docs/configuration.md) — full configuration reference for
  `config.json` and `.env`.
- [`shortcuts/README.md`](shortcuts/README.md) — Apple Shortcuts for the charger API.
