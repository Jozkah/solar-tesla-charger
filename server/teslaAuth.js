// Tesla Fleet API OAuth 2.0 — third-party tokens (Authorization Code grant).
// Flow:
//   1) GET /api/tesla/login  -> redirect user to Tesla's authorize page
//   2) Tesla redirects back to /api/tesla/callback?code=...&state=...
//   3) Exchange code -> access_token + refresh_token (refresh persisted to disk)
//   4) getAccessToken() refreshes automatically using the stored refresh_token
//
// Tokens are stored in data/tesla_tokens.json (gitignored). client_id/secret come
// from .env. Note: commands still require the signed Vehicle Command Protocol
// (tesla-http-proxy) — these tokens are what the proxy authenticates with.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

const t = config.tesla;
const TOKENS_FILE = path.join(config.paths.root, 'data', 'tesla_tokens.json');

let mem = { accessToken: null, accessExp: 0 };
let pendingState = null;

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function saveTokens(obj) {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
}

export function isAuthorized() {
  return Boolean(loadTokens().refresh_token);
}

export function authState() {
  const tok = loadTokens();
  return {
    authorized: Boolean(tok.refresh_token),
    configured: Boolean(t.clientId && t.clientSecret),
    obtainedAt: tok.obtained_at || null,
  };
}

export function buildAuthorizeUrl() {
  if (!t.clientId) throw new Error('TESLA_CLIENT_ID not set in .env');
  pendingState = crypto.randomUUID();
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: t.clientId,
    redirect_uri: t.redirectUri,
    scope: t.scopes,
    state: pendingState,
  });
  if (t.audience) p.set('audience', t.audience);
  return `${t.authorizeUrl}?${p.toString()}`;
}

export async function handleCallback(code, state) {
  if (!code) throw new Error('missing authorization code');
  if (pendingState && state && state !== pendingState) throw new Error('state mismatch');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: t.clientId,
    client_secret: t.clientSecret,
    code,
    redirect_uri: t.redirectUri,
  });
  if (t.audience) body.set('audience', t.audience);
  const res = await fetch(t.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  saveTokens({ refresh_token: json.refresh_token, obtained_at: Date.now() });
  mem.accessToken = json.access_token;
  mem.accessExp = Date.now() + (json.expires_in || 28800) * 1000;
  pendingState = null;
  return true;
}

export async function getAccessToken() {
  const now = Date.now();
  if (mem.accessToken && now < mem.accessExp - 60_000) return mem.accessToken;
  const tokens = loadTokens();
  if (!tokens.refresh_token) throw new Error('Tesla not authorized — open /api/tesla/login');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: t.clientId,
    refresh_token: tokens.refresh_token,
  });
  if (t.clientSecret) body.set('client_secret', t.clientSecret);
  const res = await fetch(t.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  mem.accessToken = json.access_token;
  mem.accessExp = now + (json.expires_in || 28800) * 1000;
  // Tesla rotates refresh tokens — persist the new one if returned.
  if (json.refresh_token && json.refresh_token !== tokens.refresh_token) {
    saveTokens({ refresh_token: json.refresh_token, obtained_at: now });
  }
  return mem.accessToken;
}

export default { isAuthorized, authState, buildAuthorizeUrl, handleCallback, getAccessToken };
