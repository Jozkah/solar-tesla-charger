// Loads config.json + .env and exposes a single merged, validated config object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

const fileConfig = readJson(path.join(ROOT, 'config.json'));

export const config = {
  ...fileConfig,
  server: {
    ...(fileConfig.server || {}),
    port: Number(process.env.PORT) || fileConfig.server?.port || 3000,
    host: process.env.HOST || fileConfig.server?.host || '0.0.0.0',
  },
  control: {
    ...fileConfig.control,
    // DRY_RUN=1 forces no-command mode (safe for running a second/test instance
    // alongside the live one — it won't send conflicting Tesla charge commands).
    dryRun: process.env.DRY_RUN === '1' ? true : fileConfig.control.dryRun,
  },
  paths: {
    root: ROOT,
    public: path.join(ROOT, 'public'),
    db: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve(ROOT, fileConfig.db.path),
  },
  tesla: {
    ...fileConfig.tesla,
    backend: process.env.TESLA_BACKEND || fileConfig.tesla.backend || 'teslamateapi',
    // Optional separate backend for *commands* (set/start/stop). Lets reads stay on
    // TeslaMateApi (gentle, DB-backed) while commands go via the Fleet signing proxy.
    commandBackend: process.env.TESLA_COMMAND_BACKEND || fileConfig.tesla.commandBackend
      || process.env.TESLA_BACKEND || fileConfig.tesla.backend || 'teslamateapi',
    // TeslaMateApi backend (default)
    teslamateapi: {
      baseUrl: process.env.TESLAMATEAPI_BASE_URL || fileConfig.tesla.teslamateapi?.baseUrl || 'http://localhost:8080',
      carId: Number(process.env.TESLAMATEAPI_CAR_ID || fileConfig.tesla.teslamateapi?.carId || 1),
      token: process.env.TESLAMATEAPI_TOKEN || '',
    },
    // Official Fleet API + tesla-http-proxy backend (OAuth third-party tokens)
    proxyBaseUrl: process.env.TESLA_PROXY_BASE_URL || fileConfig.tesla.proxyBaseUrl,
    refreshToken: process.env.TESLA_REFRESH_TOKEN || '',
    clientId: process.env.TESLA_CLIENT_ID || '',
    clientSecret: process.env.TESLA_CLIENT_SECRET || '',
    redirectUri: process.env.TESLA_REDIRECT_URI || 'http://localhost:3000/api/tesla/callback',
    authorizeUrl: process.env.TESLA_AUTHORIZE_URL || 'https://auth.tesla.com/oauth2/v3/authorize',
    scopes: process.env.TESLA_SCOPES || 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location offline_access energy_device_data energy_cmds',
    fleetBase: process.env.TESLA_FLEET_BASE || 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    // OAuth audience (the Fleet API base the token is issued for); defaults to fleetBase.
    audience: process.env.TESLA_AUDIENCE || process.env.TESLA_FLEET_BASE || 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    tokenUrl: process.env.TESLA_TOKEN_URL || 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    vin: process.env.TESLA_VIN || '',
  },
  solax: {
    ...(fileConfig.solax || {}),
    apiUrl: process.env.SOLAX_API_URL || 'https://global.solaxcloud.com',
    tokenId: process.env.SOLAX_TOKEN_ID || '',
    wifiSn: process.env.SOLAX_WIFI_SN || '',
  },
  // Home location for the weather forecast. Kept OUT of the tracked config.json
  // (it's your home address) — set WEATHER_LAT / WEATHER_LON in .env. Falls back
  // to the car's GPS location when unset.
  weather: {
    ...(fileConfig.weather || {}),
    lat: process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : fileConfig.weather?.lat ?? null,
    lon: process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : fileConfig.weather?.lon ?? null,
  },
  notify: {
    ...(fileConfig.notify || {}),
    channel: process.env.NOTIFY_CHANNEL || fileConfig.notify?.channel || 'auto',
    ntfy: { server: process.env.NTFY_SERVER || 'https://ntfy.sh', topic: process.env.NTFY_TOPIC || '', token: process.env.NTFY_TOKEN || '' },
    pushover: { token: process.env.PUSHOVER_TOKEN || '', user: process.env.PUSHOVER_USER || '' },
    telegram: { token: process.env.TELEGRAM_BOT_TOKEN || '', chatId: process.env.TELEGRAM_CHAT_ID || '' },
  },
  // Home dashboard: Agent DVR cameras. Credentials may live in .env instead of
  // config.json (they end up in URLs server-side only — never sent to the browser).
  cameras: {
    ...(fileConfig.cameras || {}),
    host: process.env.CAMERAS_HOST || fileConfig.cameras?.host || 'http://localhost:8090',
    auth: {
      user: process.env.CAMERAS_USER || fileConfig.cameras?.auth?.user || '',
      pass: process.env.CAMERAS_PASS || fileConfig.cameras?.auth?.pass || '',
    },
  },
  // Home dashboard: TP-Link smart plugs (Kasa over port 9999, or Tapo over KLAP).
  kasa: {
    ...(fileConfig.kasa || {}),
    // Tapo plugs need the TP-Link account credentials for the local handshake.
    tapo: {
      email: process.env.TAPO_EMAIL || fileConfig.kasa?.tapo?.email || '',
      password: process.env.TAPO_PASSWORD || fileConfig.kasa?.tapo?.password || '',
    },
  },
};

// Ensure the data directory exists for SQLite.
fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });

export function teslaConfigured() {
  const t = config.tesla;
  if ((t.backend || 'teslamateapi') === 'teslamateapi') {
    // Token optional only if TeslaMateApi runs with API_TOKEN_DISABLE=true.
    return Boolean(t.teslamateapi?.baseUrl && t.teslamateapi?.carId);
  }
  // Fleet API (proxy/fleet): OAuth third-party tokens (client creds + VIN).
  return Boolean(t.clientId && t.clientSecret && t.vin);
}

export default config;
