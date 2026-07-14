// Express app: serves the dashboard, exposes the REST API used by both the
// dashboard and Apple Shortcuts, and starts the control loop.
import express from 'express';
import config from './config.js';
import * as controller from './controller.js';
import * as stats from './stats.js';
import * as teslaAuth from './teslaAuth.js';
import * as notify from './notify.js';

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

app.get('/api/stats', (req, res) => {
  const range = ['today', 'session', 'all', 'day', 'week', 'month'].includes(req.query.range)
    ? req.query.range
    : 'today';
  // Periods back from the current one (day/week/month ranges only).
  const offset = Math.min(1000, Math.max(0, Math.trunc(Number(req.query.offset) || 0)));
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
    res.redirect('/?tesla=connected');
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

// --- Static dashboard ------------------------------------------------------

app.use(express.static(config.paths.public));

// --- Boot ------------------------------------------------------------------

const { port, host } = config.server;
app.listen(port, host, () => {
  console.log(`Solar Tesla Charger listening on http://${host}:${port}`);
  console.log(`Dry-run: ${config.control.dryRun ? 'ON (no commands sent)' : 'OFF'}`);
  console.log(`Tesla configured: ${controller.state.teslaConfigured}`);
  controller.start();
});
