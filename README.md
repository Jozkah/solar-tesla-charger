# ☀️ Solar-Aware Tesla Charger

A self-hosted Node.js service that reads your home energy meters and solar inverters in
real time, then automatically adjusts your **Tesla's charging amperage** to soak up your
**solar surplus** — always leaving a small export buffer so you're never paying the grid
to charge the car. Ships with a mobile-first, iOS-styled dashboard (usable on your phone
over the LAN) and a REST API for Apple Shortcuts.

> **Local-first & private.** All credentials live in a gitignored `.env`. Nothing is
> committed to source control. The dashboard is meant for your LAN only.

---

## Features

- **Solar-surplus charging** — computes available amps from live grid export and ramps the
  Tesla up/down, keeping a configurable export buffer (default 500 W).
- **Voltage-aware** — uses the real charging voltage (handles local voltage sag/swell), and
  detects Tesla's voltage-drop current throttle.
- **Auto + manual** — automatic loop with a manual amp override, pause, and a single
  state-aware Start/Stop charge button.
- **Real-time dashboard** — Server-Sent Events push live updates (~2 s); iOS 26 "Liquid
  Glass" styling; interactive power chart with hover tooltip and 1h/6h/24h/7d ranges.
- **Whole-home view** — per-circuit power, voltage, current and power factor; grid
  import/export; estimated home consumption.
- **Multiple data sources**, each optional and degrading gracefully:
  | Source | Transport | Used for |
  |--------|-----------|----------|
  | Shelly EM (Gen1) ×2 | local HTTP | grid + per-circuit power/voltage/PF |
  | Tesla Wall Connector (Gen 3) | local HTTP | live charging amps/voltage/state/session kWh |
  | Tesla (car commands + data) | TeslaMateApi **or** Fleet API proxy | set amps, start/stop, SoC |
  | SolaX inverter | SolaX Cloud API | second solar array generation |
  | Growatt inverter | Shelly clamp (real-time) | first solar array generation |
- **Statistics** (SQLite) — energy charged, % from solar, peak power/amps, charging time,
  solar generated, exported/imported, estimated home usage; Session / Today / All-time.

---

## Architecture

```
server/
  index.js         Express app: REST API, SSE stream, static dashboard, boot
  config.js        Loads config.json + .env into one config object
  shelly.js        Polls the two Shelly EM (Gen1) meters
  wallconnector.js Reads the Tesla Wall Connector local vitals API
  tesla.js         Car data + commands (TeslaMateApi or Fleet API proxy backend)
  solax.js         SolaX Cloud client (cached, rate-limit friendly)
  controller.js    Live loop (~2 s) + control loop (~10 s): surplus → amps decision
  stats.js         Aggregations for the statistics panel and charts
  db.js            SQLite (node:sqlite) sample/session storage
public/            Mobile-first dashboard (index.html, app.js, style via Tailwind CDN)
config.json        Non-secret config (IPs, limits, buffers, poll intervals)
.env               Secrets (gitignored) — see .env.example
```

**Stack:** Node.js ≥ 18 (uses built-in `node:sqlite`, native `fetch`), Express, `undici`,
`dotenv`. No build step.

---

## How the control loop works

Single-phase, voltage read live. The car's draw is already inside the grid meter, so:

```
exportW  = max(0, -gridPower)            # power currently flowing to the grid
surplusW = exportW + carChargeW - buffer # power we could feed the car, keeping the buffer
amps     = clamp(floor(surplusW / V), minAmps, maxAmps)
```

A hysteresis band avoids flapping; below the minimum sustainable surplus, charging pauses
and auto-resumes when the sun returns. A manual **override** holds a fixed amperage on
top of (or instead of) the auto logic.

---

## Setup

```bash
npm install
cp .env.example .env     # then fill in your values
npm start                # serves on http://0.0.0.0:3000
```

Open `http://<this-machine-LAN-IP>:3000` on your phone (same Wi-Fi). Allow inbound TCP
3000 through the firewall for LAN access.

### Configuration

- **`config.json`** — non-secret settings: Shelly device IPs + channel→label mapping,
  Wall Connector IP, control parameters (`bufferWatts`, `minAmps`/`maxAmps`, `voltage`,
  `pollIntervalSec`, `livePollSec`, `stopWhenInsufficient`, `dryRun`), SolaX poll interval.
- **`.env`** — all secrets. Copy `.env.example` and fill in. Never commit this file.

> Start with `"dryRun": true` in `config.json` to watch the computed amps without sending
> any commands to the car. Flip to `false` when you're satisfied.

### Tesla control (two interchangeable backends)

Set `tesla.backend` in `config.json`:

- **`teslamateapi`** — point at a running [TeslaMateApi](https://github.com/tobiasehlert/teslamateapi)
  instance (reuses your TeslaMate tokens + command host). Requires `ENABLE_COMMANDS=true`
  and `COMMANDS_CHARGING=true` on that container. Your TeslaMate must be on the **Fleet API**
  (the legacy Owner API is shut down).
- **`proxy`** — talk to the official Fleet API directly through a Fleet command proxy
  (self-hosted `tesla-http-proxy`, or a managed proxy). Set the `TESLA_*` vars in `.env`.

If neither is configured, the app runs **monitor-only** (full dashboard, no car control).

---

## REST API

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET  | `/api/state` | – | live snapshot (meters, car, wall connector, SolaX, computed target) |
| GET  | `/api/stream` | – | Server-Sent Events stream of live state |
| GET  | `/api/stats?range=today\|session\|all` | – | aggregated statistics |
| GET  | `/api/series?hours=N` | – | downsampled time series for charts (N up to 720) |
| POST | `/api/mode` | `{mode:"auto"\|"pause"}` | switch automation |
| POST | `/api/override` | `{amps,expiresInMin?}` | manual amp hold |
| POST | `/api/override/clear` | – | drop the override |
| POST | `/api/charge` | `{action:"start"\|"stop"}` | manual start/stop |

See [`shortcuts/README.md`](shortcuts/README.md) for ready-made Apple Shortcuts.

---

## Run it always-on (Windows)

Use Task Scheduler ("At log on" / "At startup", `node server\index.js`) or a service
wrapper like [NSSM](https://nssm.cc/). Give the machine a static DHCP lease so the LAN IP
(and your Shortcuts) don't break.

---

## Security notes

- `.env` (tokens, API keys, cloud auth keys, device IDs) is **gitignored** — keep it that way.
- The dashboard and REST API have **no authentication**; expose them on your LAN only. For
  remote access use a VPN/Tailscale, never a public port-forward.
- `data/` (the SQLite database) is gitignored.
