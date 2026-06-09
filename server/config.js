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
  paths: {
    root: ROOT,
    public: path.join(ROOT, 'public'),
    db: path.resolve(ROOT, fileConfig.db.path),
  },
  tesla: {
    ...fileConfig.tesla,
    backend: process.env.TESLA_BACKEND || fileConfig.tesla.backend || 'teslamateapi',
    // TeslaMateApi backend (default)
    teslamateapi: {
      baseUrl: process.env.TESLAMATEAPI_BASE_URL || fileConfig.tesla.teslamateapi?.baseUrl || 'http://localhost:8080',
      carId: Number(process.env.TESLAMATEAPI_CAR_ID || fileConfig.tesla.teslamateapi?.carId || 1),
      token: process.env.TESLAMATEAPI_TOKEN || '',
    },
    // Official Fleet API + tesla-http-proxy backend
    proxyBaseUrl: process.env.TESLA_PROXY_BASE_URL || fileConfig.tesla.proxyBaseUrl,
    refreshToken: process.env.TESLA_REFRESH_TOKEN || '',
    clientId: process.env.TESLA_CLIENT_ID || '',
    fleetBase: process.env.TESLA_FLEET_BASE || '',
    tokenUrl: process.env.TESLA_TOKEN_URL || 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    vin: process.env.TESLA_VIN || '',
  },
  solax: {
    ...(fileConfig.solax || {}),
    apiUrl: process.env.SOLAX_API_URL || 'https://global.solaxcloud.com',
    tokenId: process.env.SOLAX_TOKEN_ID || '',
    wifiSn: process.env.SOLAX_WIFI_SN || '',
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
  return Boolean(t.refreshToken && t.clientId && t.vin);
}

export default config;
