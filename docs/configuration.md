# Configuration reference

Two files configure the app:

- **`config.json`** — all **non-secret** settings, committed to the repo. This includes
  device IPs (meters, Wall Connector, cameras, plugs), which are local-LAN addresses,
  not secrets.
- **`.env`** — **secrets only** (tokens, API keys, account passwords). Gitignored;
  copy `.env.example` to `.env` and fill in. Merging happens in `server/config.js`,
  where `.env` values override the matching `config.json` keys.

This doc focuses on the **home-dashboard** blocks (`cameras`, `kasa`, `weather`). The
base-charger blocks (`shelly`, `wallconnector`, `solax`, `control`, `tesla`, `notify`,
`db`) are summarized at the end; see `.env.example` and the inline comments in
`server/config.js` for the full base-charger reference.

---

## `config.json` → `cameras`

```jsonc
"cameras": {
  "enabled": true,
  "host": "http://localhost:8090",
  "auth": { "user": "", "pass": "" },
  "snapshotSize": "640x360",
  "statusPollSec": 45,
  "timeoutMs": 5000,
  "exclude": [7],
  "list": []
}
```

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch for the camera feature. |
| `host` | string | `http://localhost:8090` | Agent DVR base URL. Overridable with `CAMERAS_HOST`. |
| `auth.user` | string | `""` | Agent DVR username (only if a login is required). Overridable with `CAMERAS_USER`. |
| `auth.pass` | string | `""` | Agent DVR password. Overridable with `CAMERAS_PASS`. |
| `snapshotSize` | string | `"640x360"` | `size=` query sent to Agent DVR for tiles/snapshots (the fullscreen viewer requests `1280x720`). |
| `statusPollSec` | number | `45` | Reachability + discovery probe interval. |
| `timeoutMs` | number | `5000` | Timeout for the `getObjects` probe. |
| `exclude` | number[] | `[7]` | Agent DVR oids to hide. |
| `list` | array | `[]` | Fallback/override list `[{ oid, name }]`; used only if discovery fails or to rename a camera by oid. |

---

## `config.json` → `kasa`

```jsonc
"kasa": {
  "enabled": true,
  "pollSec": 5,
  "timeoutMs": 3000,
  "plugs": [
    { "key": "water_heater", "label": "Water Heater", "ip": "192.168.1.x", "role": "water_heater", "controllable": true, "protocol": "tapo" }
  ]
}
```

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch for the smart-plug feature. |
| `pollSec` | number | `5` | Max age of the plug cache before a background refresh. |
| `timeoutMs` | number | `3000` | Per-request timeout for legacy Kasa devices. |
| `plugs` | array | – | List of plugs (see below). |

Each `kasa.plugs[]` entry:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `key` | string | – | Stable identifier used by `POST /api/kasa/:key` and the UI. Must be unique. |
| `label` | string | `key` | Display name on the card. |
| `ip` | string | – | Plug's LAN IP (not secret). |
| `role` | string | `"appliance"` | Card icon + confirm behavior. `water_heater` → 🔥 icon and a confirm dialog before switching. |
| `controllable` | bool | `true` | If `false`, switching is rejected server-side (monitor-only). |
| `protocol` | string | `"kasa"` | `"kasa"` (legacy HS/KP over port 9999) or `"tapo"` (P100/P110/P115 over KLAP — needs `TAPO_*`). |

---

## `config.json` → `weather`

```jsonc
"weather": {
  "enabled": true,
  "pollMin": 10,
  "lat": null,
  "lon": null,
  "timeoutMs": 8000
}
```

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch. Set `false` to disable the weather card/endpoint. |
| `pollMin` | number | `10` | Minutes between current-conditions refreshes. |
| `forecastMin` | number | `30` | Minutes between forecast refreshes (not in the default file; falls back to 30). |
| `lat` / `lon` | number | `null` | Location for Open-Meteo. **Keep these `null` in `config.json` (it's your home address) and set `WEATHER_LAT` / `WEATHER_LON` in `.env` instead.** The car's live location is used when unset. |
| `timeoutMs` | number | `8000` | Open-Meteo request timeout. |

Open-Meteo needs **no API key**.

---

## `.env` — home-dashboard variables

```dotenv
# Agent DVR cameras (only if your Agent DVR requires a login)
# CAMERAS_HOST=http://localhost:8090
# CAMERAS_USER=
# CAMERAS_PASS=

# TP-Link Tapo plugs (required if any plug uses protocol: "tapo")
TAPO_EMAIL=
TAPO_PASSWORD=
```

| Var | Used by | Required? | Notes |
|-----|---------|-----------|-------|
| `TAPO_EMAIL` | smart plugs | If any `protocol: "tapo"` plug | TP-Link account email for the local KLAP handshake. |
| `TAPO_PASSWORD` | smart plugs | If any `protocol: "tapo"` plug | TP-Link account password. Local handshake, not a cloud round-trip. |
| `CAMERAS_HOST` | cameras | Optional | Overrides `cameras.host`. |
| `CAMERAS_USER` | cameras | Only if Agent DVR has a login | Overrides `cameras.auth.user`. |
| `CAMERAS_PASS` | cameras | Only if Agent DVR has a login | Overrides `cameras.auth.pass`. |

Legacy Kasa plugs need no `.env` entries.

---

## `.env` — server & base-charger variables (summary)

| Var | Purpose |
|-----|---------|
| `PORT` / `HOST` | Override `server.port` / `server.host`. |
| `DRY_RUN` | `1` forces no-command mode (safe for a second/test instance). |
| `TESLAMATEAPI_BASE_URL` / `_CAR_ID` / `_TOKEN` | TeslaMateApi backend. |
| `TESLA_CLIENT_ID` / `_CLIENT_SECRET` / `_VIN` / `_REDIRECT_URI` / `_FLEET_BASE` / `_PROXY_BASE_URL` | Fleet API (proxy) backend + OAuth. |
| `SOLAX_API_URL` / `_TOKEN_ID` / `_WIFI_SN` | SolaX Cloud (second solar array). |
| `SHELLY_CLOUD_*` | Optional historical backfill. |
| `NTFY_*` / `PUSHOVER_*` / `TELEGRAM_*` | Push-notification channel. |

See `.env.example` for the complete, commented list.

---

## `config.json` — base-charger blocks (summary)

| Block | Purpose |
|-------|---------|
| `server` | `port` / `host` for the HTTP server. |
| `shelly` | The two Shelly EM (Gen1) meters: device IPs + per-channel `key`/`label`/`role` mapping, and `timeoutMs`. |
| `wallconnector` | Tesla Wall Connector (Gen 3) local vitals: `enabled`, `ip`, `timeoutMs`. |
| `solax` | SolaX Cloud: `enabled`, `pollSec`, `timeoutMs`. |
| `control` | Charging logic: `pollIntervalSec`, `livePollSec`, `carPollSec`, `voltage`, `bufferWatts`, `minAmps`/`maxAmps`, `stopWhenInsufficient`, `resumeMarginWatts`, `dryRun`, … |
| `tesla` | Backend selection (`backend`), TeslaMateApi base/carId, proxy base URL, wake/retry options. |
| `notify` | Push channel selection. |
| `db` | SQLite path + `sampleRetentionDays`. |

Full details live in the inline comments of `server/config.js`, `server/controller.js`,
and `server/tesla.js`.
