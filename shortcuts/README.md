# Apple Shortcuts integration

The server exposes plain HTTP endpoints on your LAN, so iOS Shortcuts can drive the
charger with a single **Get Contents of URL** action. Find your PC's LAN IP (e.g.
`192.168.1.50`) and use port `3000` (from `config.json`).

> Tip: give the PC a static DHCP lease so the IP doesn't change, then use it below.

Base URL: `http://192.168.1.50:3000`

## Build these shortcuts

### ☀️ "Charge on Sun" (resume automatic)
- **Get Contents of URL**
  - URL: `http://192.168.1.50:3000/api/mode`
  - Method: `POST`
  - Request Body: `JSON` → `{ "mode": "auto" }`

### ⏸ "Pause Charging"
- **Get Contents of URL**
  - URL: `http://192.168.1.50:3000/api/mode`
  - Method: `POST` · Body `JSON`: `{ "mode": "pause" }`

### 🔌 "Force 16A for 1h" (manual override)
- **Get Contents of URL**
  - URL: `http://192.168.1.50:3000/api/override`
  - Method: `POST` · Body `JSON`: `{ "amps": 16, "expiresInMin": 60 }`

### ▶️ / ⏹ "Start" / "Stop" charge
- URL: `http://192.168.1.50:3000/api/charge`
- Method: `POST` · Body `JSON`: `{ "action": "start" }`  (or `"stop"`)

### 📊 "Charge status" (read state, show notification)
1. **Get Contents of URL** → `http://192.168.1.50:3000/api/state` (GET)
2. **Get Dictionary Value** `computed.targetAmps` (and `charging`, `lastAction`)
3. **Show Notification** with the values.

### 🔔 "Charging notifications" (start/stop alerts)
The server queues charging start/stop events; this Shortcut drains the queue and
shows a notification for each. Run it on a schedule via a Personal Automation.

**Build the Shortcut ("Charge alerts"):**
1. **Get Contents of URL** → `http://192.168.1.50:3000/api/notify/pending` (GET)
2. **Get Dictionary Value** → `messages` (from the result)
3. **Repeat with Each** (item in `messages`):
   - **Show Notification** → Title `Solar Charger`, Body = *Repeat Item*
4. (Optional) **If** *Repeat Index* … to avoid empty runs — not required; an empty
   `messages` list just shows nothing.

**Automate it:** Shortcuts app → **Automation** → **＋** → **Time of Day** (or any
trigger you like) → run "Charge alerts", and turn **Run Immediately** on (no prompt).
iOS time automations are periodic (you choose the time/repeat); each run delivers any
events that happened since the last run, so you won't miss start/stop — they may just
arrive a few minutes late depending on your interval.

Events you'll get: `🔌 Charging started at 12A`, `⛅ Charging stopped — not enough solar
energy`, `🔌 Charger unplugged — charging stopped`, `⏸ Charging paused`, `■ Charging stopped`.

> Want instant push instead of polling? Serve the dashboard over HTTPS (via your reverse
> proxy) and we can switch to native web-push — no Shortcut needed.

## Notes
- These work only on the same Wi-Fi/LAN as the PC. For remote use, expose the server
  via Tailscale / WireGuard and point the URL at the tailnet IP — do **not** port-forward
  it to the public internet (no auth).
- All POST endpoints return `{ "ok": true, ... }` on success.
