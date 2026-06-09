// Express app: serves the dashboard, exposes the REST API used by both the
// dashboard and Apple Shortcuts, and starts the control loop.
import express from 'express';
import config from './config.js';
import * as controller from './controller.js';
import * as stats from './stats.js';

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
  const range = ['today', 'session', 'all'].includes(req.query.range) ? req.query.range : 'today';
  res.json(stats.getStats(range));
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

app.post('/api/charge', async (req, res) => {
  try {
    const r = await controller.manualCharge(req.body?.action);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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
