// Express app: serves the dashboard, exposes the REST API used by both the
// dashboard and Apple Shortcuts, and starts the control loop.
import path from 'node:path';
import express from 'express';
import { request } from 'undici';
import config from './config.js';
import * as controller from './controller.js';
import * as stats from './stats.js';
import * as teslaAuth from './teslaAuth.js';
import * as notify from './notify.js';
import * as cameras from './cameras.js';
import * as kasa from './kasa.js';
import * as weather from './weather.js';

const app = express();
app.use(express.json());

// --- API -------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  res.json(controller.getState());
});

// Real-time push: Server-Sent Events. The dashboard subscribes here and gets a
// fresh snapshot on every live-loop tick (~2s) — same cadence as the Shellys.
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (s) => res.write(`data: ${JSON.stringify(s)}\n\n`);
  send(controller.getState()); // initial
  const onUpdate = (s) => send(s);
  controller.bus.on('update', onUpdate);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    controller.bus.off('update', onUpdate);
  });
});

// Max `offset` per calendar range — chosen so the walk can never reach before
// any plausible install date (day: ~10y, week: ~10y, month: 10y). A flat clamp
// across all three let `month` reach ~83 years back (offset 1000 = March
// 1943), which is old enough to precede any real history and poison the DB —
// see the historyStart guard in stats.js/rollup.js. Ranges without an offset
// (today/session/all) just clamp to 0.
const RANGE_MAX_OFFSET = { day: 3650, week: 520, month: 120 };

app.get('/api/stats', (req, res) => {
  const range = ['today', 'session', 'all', 'day', 'week', 'month'].includes(req.query.range)
    ? req.query.range
    : 'today';
  // Periods back from the current one (day/week/month ranges only).
  const maxOffset = RANGE_MAX_OFFSET[range] ?? 0;
  const offset = Math.min(maxOffset, Math.max(0, Math.trunc(Number(req.query.offset) || 0)));
  res.json(stats.getStats(range, offset));
});

app.get('/api/series', (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 1));
  res.json(stats.getSeries(hours));
});

app.post('/api/mode', (req, res) => {
  try {
    const mode = controller.setMode(req.body?.mode);
    res.json({ ok: true, mode });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/override', (req, res) => {
  try {
    const amps = Number(req.body?.amps);
    if (!Number.isFinite(amps)) throw new Error('amps required');
    const ov = controller.setOverride(amps, Number(req.body?.expiresInMin) || null);
    res.json({ ok: true, override: ov });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/override/clear', (req, res) => {
  controller.clearOverride();
  res.json({ ok: true });
});

app.post('/api/schedule', (req, res) => {
  try {
    res.json({ ok: true, schedule: controller.setSchedule(req.body || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/maxamps', (req, res) => {
  try {
    const amps = Number(req.body?.amps);
    if (!Number.isFinite(amps)) throw new Error('amps required');
    res.json({ ok: true, maxAmps: controller.setMaxAmps(amps) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/limit-boost', (req, res) => {
  try {
    res.json({ ok: true, allowLimitIncrease: controller.setAllowLimitIncrease(req.body?.on) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/charge', async (req, res) => {
  try {
    const r = await controller.manualCharge(req.body?.action);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Charging events for Apple Shortcuts notifications.
// /api/notify/pending DRAINS the queue (returns undelivered messages and clears them)
// so a Shortcut automation can poll it and show a notification for each.
app.get('/api/notify/pending', (req, res) => {
  const messages = controller.popPending();
  res.json({ count: messages.length, messages });
});
app.get('/api/events', (req, res) => res.json({ events: controller.recentEvents() }));

// Fire a test push notification to verify the configured channel.
app.get('/api/notify/test', async (req, res) => {
  if (!notify.enabled()) return res.status(400).json({ ok: false, error: 'notifications not configured (set NTFY_TOPIC etc. in .env)' });
  const r = await notify.send('Solar Charger', '✅ Test notification — push is working!', { tags: 'tada' });
  res.json({ channel: notify.channel(), ...r });
});

// --- Tesla Fleet API OAuth (third-party tokens) ----------------------------
app.get('/api/tesla/auth-status', (req, res) => res.json(teslaAuth.authState()));

app.get('/api/tesla/login', (req, res) => {
  try {
    res.redirect(teslaAuth.buildAuthorizeUrl());
  } catch (e) {
    res.status(400).send('Cannot start Tesla login: ' + e.message);
  }
});

app.get('/api/tesla/callback', async (req, res) => {
  try {
    await teslaAuth.handleCallback(req.query.code, req.query.state);
    res.redirect('/charger?tesla=connected');
  } catch (e) {
    res.status(400).send('Tesla authorization failed: ' + e.message);
  }
});

// Manual code exchange — for when the registered redirect URI is on another
// domain. Paste the full redirected URL (or the code) here. Uses the configured
// redirect_uri for the token exchange regardless of where the browser landed.
app.post('/api/tesla/exchange', async (req, res) => {
  try {
    let { code, state, url } = req.body || {};
    if (url) {
      const u = new URL(url.trim());
      code = u.searchParams.get('code') || code;
      state = u.searchParams.get('state') || state;
    }
    if (!code) throw new Error('no code found in input');
    await teslaAuth.handleCallback(code, state);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Home dashboard: cameras (Agent DVR) + smart plugs (Kasa) --------------

app.get('/api/cameras', (req, res) => {
  res.json({ enabled: cameras.enabled(), status: cameras.getStatus(), cameras: cameras.listCameras() });
});

// MJPEG proxy — lets phones on the LAN view Agent DVR streams through this
// server (the browser hits us; we reach Agent DVR on localhost). The body is a
// never-ending multipart stream, so disable client timeouts and pipe it through.
app.get('/api/cameras/:oid/stream', async (req, res) => {
  const cam = cameras.find(req.params.oid);
  if (!cam) return res.status(404).end('unknown camera');
  let upstream;
  try {
    upstream = await request(cameras.upstreamStreamUrl(cam.oid, req.query.size), {
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  } catch (e) {
    return res.status(502).end('camera unreachable: ' + (e.message || e));
  }
  if (upstream.statusCode >= 400) {
    upstream.body.destroy();
    return res.status(502).end('camera error HTTP ' + upstream.statusCode);
  }
  res.set('Content-Type', upstream.headers['content-type'] || 'multipart/x-mixed-replace');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Connection', 'close');
  upstream.body.on('error', () => res.end());
  upstream.body.pipe(res);
  req.on('close', () => { try { upstream.body.destroy(); } catch { /* already closed */ } });
});

// Single JPEG snapshot. The camera tiles poll this (instead of holding open MJPEG
// streams) so we never exhaust the browser's ~6-connections-per-host limit — that
// starvation is what blanks the fullscreen viewer and leaves tiles black. Uses
// Agent DVR's native /grab.jpg; falls back to grabbing a frame from the MJPEG
// stream if that endpoint isn't available on this build.
app.get('/api/cameras/:oid/snapshot', async (req, res) => {
  const cam = cameras.find(req.params.oid);
  if (!cam) return res.status(404).end('unknown camera');
  try {
    const upstream = await request(cameras.upstreamSnapshotUrl(cam.oid, req.query.size), {
      headersTimeout: 6000,
      bodyTimeout: 6000,
    });
    if (upstream.statusCode < 400) {
      res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return upstream.body.pipe(res);
    }
    upstream.body.destroy();
  } catch { /* fall through to MJPEG frame grab */ }
  try {
    const frame = await grabFrame(cameras.upstreamStreamUrl(cam.oid, req.query.size));
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(frame);
  } catch (e) {
    res.status(502).end('snapshot failed: ' + (e.message || e));
  }
});

// Read an MJPEG multipart stream until one complete JPEG (SOI 0xFFD8 .. EOI 0xFFD9).
async function grabFrame(url) {
  const { body } = await request(url, { headersTimeout: 5000, bodyTimeout: 5000 });
  let buf = Buffer.alloc(0);
  try {
    for await (const chunk of body) {
      buf = Buffer.concat([buf, chunk]);
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) {
        if (buf.length > 2_000_000) throw new Error('no JPEG start found');
        continue;
      }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end !== -1) return buf.subarray(start, end + 2);
      if (buf.length > 8_000_000) throw new Error('frame too large');
    }
  } finally {
    try { body.destroy(); } catch { /* already closed */ }
  }
  throw new Error('stream ended without a frame');
}

app.get('/api/kasa', (req, res) => {
  res.json(kasa.getCached() || { enabled: kasa.enabled(), plugs: [] });
});

// Current conditions + multi-day forecast (Open-Meteo, no key). The home page
// polls this every few minutes — it's too large to ride on the SSE state tick.
app.get('/api/weather', (req, res) => {
  const lat = Number(req.query.lat) || config.weather?.lat;
  const lon = Number(req.query.lon) || config.weather?.lon;
  res.json({ current: weather.getCached(lat, lon), forecast: weather.getForecast(lat, lon) });
});

app.post('/api/kasa/:key', async (req, res) => {
  try {
    const on = req.body?.on;
    if (typeof on !== 'boolean') throw new Error('body { on: boolean } required');
    const plug = await kasa.setState(req.params.key, on);
    res.json({ ok: true, plug });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Static dashboard ------------------------------------------------------

// The home dashboard is now the main page; the Tesla/solar charger lives at
// /charger (and /home still maps to home for old bookmarks).
app.get(['/', '/home'], (req, res) => res.sendFile(path.join(config.paths.public, 'home.html')));
app.get('/charger', (req, res) => res.sendFile(path.join(config.paths.public, 'index.html')));

app.use(express.static(config.paths.public, {
  index: false,
  setHeaders: (res, filePath) => {
    // The dashboard is installed to the iOS home screen (apple-mobile-web-app-
    // capable) and cached in a standalone webview. Force revalidation of the
    // HTML and its scripts so a deploy can't leave a stale index.html paired
    // with a new app.js (or vice versa) — a mismatch throws and blanks the page.
    if (/\.(html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// --- Boot ------------------------------------------------------------------

const { port, host } = config.server;
app.listen(port, host, () => {
  console.log(`Solar Tesla Charger listening on http://${host}:${port}`);
  console.log(`Dry-run: ${config.control.dryRun ? 'ON (no commands sent)' : 'OFF'}`);
  console.log(`Tesla configured: ${controller.state.teslaConfigured}`);
  controller.start();
});
