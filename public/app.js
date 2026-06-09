// Dashboard front-end. Live updates over Server-Sent Events (falls back to
// polling). Interactive chart with hover crosshair + tooltip.
const $ = (id) => document.getElementById(id);
const fmtW = (w) => (w == null || Number.isNaN(w) ? '–' : Math.round(w).toLocaleString());
const fmtKwh = (wh) => (wh == null ? '0' : (wh / 1000).toFixed(2));
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

let range = 'today';
let lastState = null;
let chartData = []; // {ts, exportW, importW, chargeW, solarW}
let chartHours = 1; // selected chart range in hours
let WINDOW_MS = 3600_000; // chart window, derived from chartHours

// --- Solar helper -----------------------------------------------------------
function solarFromMeters(m) {
  if (!m) return 0;
  let w = 0;
  if (m.solarPanels2 < 0) w += -m.solarPanels2;
  const f1 = m.channels?.floor1?.power;
  if (f1 != null && f1 < 0) w += -f1; // solarPanel1 injects on floor1
  return w;
}
function solarFromSeries(p) {
  let w = 0;
  if (p.solar2W < 0) w += -p.solar2W;
  if (p.floor1W != null && p.floor1W < 0) w += -p.floor1W;
  return w;
}
// True total solar = Growatt clamp + SolaX cloud (acpower). Falls back to the
// floor1-injection proxy only when SolaX cloud data isn't available.
function solarTotal(s) {
  const m = s.meters || {};
  let w = 0;
  if (m.solarPanels2 < 0) w += -m.solarPanels2; // Growatt clamp
  if (s.solax && s.solax.ok && s.solax.acpower != null) {
    w += Math.max(0, s.solax.acpower); // SolaX cloud
  } else {
    const f1 = m.channels?.floor1?.power;
    if (f1 != null && f1 < 0) w += -f1; // proxy
  }
  return w;
}

// --- Connection / data source ----------------------------------------------
function setConn(cls, text) {
  const wrap = $('conn'), dot = $('connDot'), t = $('connText');
  if (!wrap) return;
  const ok = cls.includes('ok');
  const color = ok ? '#30D158' : '#FF453A';
  wrap.style.background = ok ? 'rgba(48,209,88,.15)' : 'rgba(255,69,58,.15)';
  dot.style.background = color; dot.classList.toggle('dot-live', ok);
  t.style.color = color; t.textContent = text;
}

let es = null, pollTimer = null;
function connect() {
  try {
    es = new EventSource('/api/stream');
    es.onmessage = (e) => { stopPolling(); handleState(JSON.parse(e.data)); };
    es.onerror = () => { setConn('err', 'reconnecting'); startPolling(); };
  } catch { startPolling(); }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try { handleState(await (await fetch('/api/state')).json()); } catch { setConn('err', 'offline'); }
  }, 3000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// --- Main render ------------------------------------------------------------
function handleState(s) {
  lastState = s;
  setConn(s.dryRun ? 'ok live' : 'ok live', s.dryRun ? 'dry-run' : 'live');
  renderHero(s);
  renderCards(s);
  renderMeters(s);
  renderControls(s);
  renderBanner(s);
  pushChartPoint(s);
  $('foot').textContent = `${s.lastAction || ''} · ${new Date(s.ts).toLocaleTimeString()}`;
}

function renderHero(s) {
  const m = s.meters;
  if (!m) return;
  const gp = m.gridPower;
  const exporting = gp < 0;
  const color = exporting ? '#30D158' : '#FF453A';
  $('gridPower').textContent = fmtW(Math.abs(gp));
  const lbl = $('gridLabel');
  lbl.textContent = exporting ? 'Exporting to grid' : 'Importing from grid';
  lbl.style.color = color;
  $('gridDot').style.background = color;
  $('flow').textContent = exporting ? '🏠 → 🔌' : '🔌 → 🏠';
  const buf = s.computed?.bufferWatts || 500;
  const volt = s.computed?.voltage || 238;
  const exp = m.exportW || 0;
  const imp = m.importW || 0;
  const bar = $('bufferBar'), pct = $('bufferPct'), label = $('bufferLabel'), sub = $('heroSub');
  if (exporting) {
    // Percentage of the buffer we're exporting (100% = exactly at buffer target).
    const p = Math.round((exp / buf) * 100);
    bar.style.width = clampN(p, 0, 100) + '%';
    bar.style.background = p >= 100 ? '#30D158' : '#FFD60A';
    pct.textContent = p + '%';
    pct.style.color = '';
    label.textContent = 'EXPORT vs BUFFER';
    const free = Math.max(0, exp - buf);
    sub.textContent = `exporting ${fmtW(exp)} W · ${fmtW(free)} W free for the car (≈${(free / volt).toFixed(1)} A)`;
  } else {
    bar.style.width = '0%';
    pct.textContent = '−' + fmtW(imp) + ' W';
    pct.style.color = '#FF453A';
    label.textContent = 'GRID IMPORT';
    sub.textContent = `importing ${fmtW(imp)} W from the grid — no solar surplus`;
  }
}

function renderCards(s) {
  const m = s.meters, comp = s.computed, car = s.car;
  const growattW = m && m.solarPanels2 < 0 ? -m.solarPanels2 : 0;
  const solaxW = s.solax && s.solax.ok && s.solax.acpower != null ? Math.max(0, s.solax.acpower) : null;
  const solarW = solarTotal(s);
  $('solarTotal').textContent = (solarW / 1000).toFixed(1);
  $('solarSub').textContent = solaxW != null
    ? `Growatt ${fmtW(growattW)} · SolaX ${fmtW(solaxW)} W`
    : (m ? `${fmtW(solarW)} W now` : '');

  const actual = comp?.actualAmps, commanded = comp?.commandedAmps ?? car?.chargeAmps;
  $('chargeAmps').textContent = actual ?? commanded ?? (s.charging ? '?' : '0');
  let cs = s.charging ? `${fmtW(comp?.chargeW)} W` : (s.wc && !s.wc.error && s.wc.connected ? 'plugged in' : (car?.chargingState || 'idle'));
  if (comp?.throttled) cs = `set ${commanded}→${actual}A (V drop)`;
  if (car?.batteryLevel != null) cs += ` · ${car.batteryLevel}%`;
  if (s.wc && !s.wc.error && s.wc.sessionWh != null && s.charging) cs += ` · ${(s.wc.sessionWh / 1000).toFixed(1)} kWh`;
  $('chargeSub').textContent = cs;

  if (comp) {
    $('targetAmps').textContent = comp.targetAmps;
    $('targetSub').textContent = `surplus ${fmtW(comp.surplusW)} W`;
  }
  const gv = m?.channels?.grid;
  $('houseV').textContent = gv?.voltage ?? comp?.voltage ?? '–';
  $('houseVSub').textContent = gv?.pf != null ? `PF ${gv.pf}` : '';
}

function renderMeters(s) {
  const m = s.meters; if (!m) return;
  const order = ['grid', 'solarPanels2', 'floor1', 'floor2'];
  const colors = { grid: '#f2f2f7', solarPanels2: '#FFD60A', floor1: '#0A84FF', floor2: '#BF5AF2' };
  const rows = order.filter((k) => m.channels?.[k]).map((k, i, arr) => {
    const c = m.channels[k];
    const neg = c.power < 0;
    const border = i < arr.length - 1 ? 'hairline-b' : '';
    return `<div class="grid grid-cols-6 py-3 items-center tnum text-[13.5px] ${border}">
      <div class="col-span-2 flex items-center gap-2 font-medium"><span class="inline-block w-2 h-2 rounded-full" style="background:${colors[k]}"></span>${c.label}</div>
      <div class="text-right font-semibold" style="color:${neg ? '#30D158' : '#f2f2f7'}">${neg ? '−' : ''}${fmtW(Math.abs(c.power))}</div>
      <div class="text-right text-mut">${c.voltage ?? '–'}</div>
      <div class="text-right text-mut">${c.current ?? '–'}</div>
      <div class="text-right text-mut">${c.pf ?? '–'}</div>
    </div>`;
  }).join('');
  $('metersBody').innerHTML = rows;
}

const TOGGLE_BASE = 'lg-btn w-full py-4 text-[17px] ';
function renderControls(s) {
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
  const btn = $('chargeToggle');
  if (!btn._busy) {
    if (s.charging) { btn.textContent = '■ Stop charge'; btn.className = TOGGLE_BASE + 'lg-btn-red'; btn.dataset.action = 'stop'; }
    else { btn.textContent = '▶ Start charge'; btn.className = TOGGLE_BASE + 'lg-btn-green'; btn.dataset.action = 'start'; }
  }
}

function renderBanner(s) {
  const b = $('banner'); const comp = s.computed; const msgs = [];
  if (!s.teslaConfigured) msgs.push('Tesla not configured — set TESLA*/TESLAMATEAPI* in .env. Monitoring only.');
  if (s.lastError && s.lastError.includes('Unable to load cars')) {
    msgs.push('⚠ TeslaMateApi can’t run commands — set ENCRYPTION_KEY (matching TeslaMate) on the TeslaMateApi container and restart it.');
  } else if (s.lastError) {
    msgs.push('⚠ ' + s.lastError);
  }
  if (s.override) msgs.push(`Override: holding ${s.override.amps}A` + (s.override.expiresAt ? ` until ${new Date(s.override.expiresAt).toLocaleTimeString()}` : ''));
  if (comp?.throttled) msgs.push(`⚡ Car throttling to ${comp.actualAmps}A (set ${comp.commandedAmps}A) — line voltage dropping under load.`);
  b.hidden = !msgs.length;
  b.innerHTML = msgs.join('<br>');
}

// --- Chart ------------------------------------------------------------------
function pushChartPoint(s) {
  const c = s.computed; if (!c) return;
  if (chartHours > 1) return; // longer ranges are refreshed from history, not live-appended
  const now = s.ts;
  const last = chartData[chartData.length - 1];
  if (last && now - last.ts < 1500) return; // throttle
  chartData.push({ ts: now, exportW: Math.max(0, c.exportW || 0), importW: Math.max(0, c.importW || 0), chargeW: Math.max(0, c.chargeW || 0), solarW: solarTotal(s) });
  const cut = now - WINDOW_MS;
  chartData = chartData.filter((p) => p.ts >= cut);
  drawChart();
}

async function loadChartHistory() {
  try {
    const series = await (await fetch('/api/series?hours=' + chartHours)).json();
    chartData = series.map((p) => ({ ts: p.ts, exportW: Math.max(0, p.exportW || 0), importW: Math.max(0, p.gridPower || 0), chargeW: Math.max(0, p.chargeW || 0), solarW: solarFromSeries(p) }));
    drawChart();
  } catch {}
}

const CH = { W: 600, H: 220, pad: 8 };
let chartScale = null;
function drawChart() {
  const svg = $('chart');
  if (chartData.length < 2) { svg.innerHTML = '<text x="10" y="20" fill="#8499bd" font-size="12">collecting data…</text>'; return; }
  const { W, H, pad } = CH;
  const xs = chartData.map((p) => p.ts);
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
  const max = Math.max(100, ...chartData.map((p) => Math.max(p.exportW, p.chargeW, p.solarW, p.importW || 0)));
  const sx = (t) => pad + ((t - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const sy = (v) => H - pad - (v / max) * (H - 2 * pad);
  chartScale = { x0, x1, max, sx, sy };
  const line = (key, color) => {
    const d = chartData.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p[key]).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  };
  const area = (key, color) => {
    const top = chartData.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p[key]).toFixed(1)}`).join(' ');
    return `<path d="${top} L${sx(x1).toFixed(1)},${H - pad} L${sx(x0).toFixed(1)},${H - pad} Z" fill="${color}" opacity="0.10"/>`;
  };
  // gridlines (25/50/75%)
  let grid = '';
  for (const f of [0.25, 0.5, 0.75]) { const y = sy(max * f); grid += `<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#1f2c47" stroke-width="1"/>`; }
  svg.innerHTML = grid
    + area('solarW', '#fbbf24') + line('solarW', '#fbbf24')
    + area('exportW', '#34d399') + line('exportW', '#34d399')
    + area('importW', '#FF453A') + line('importW', '#FF453A')
    + line('chargeW', '#60a5fa')
    + `<text x="${pad}" y="14" fill="#8499bd" font-size="11">${Math.round(max)} W</text>`;
}

// Hover / touch tooltip
const box = $('chartBox'), tip = $('tooltip'), cross = $('crosshair');
function onHover(clientX) {
  if (!chartScale || chartData.length < 2) return;
  const rect = box.getBoundingClientRect();
  const px = clientX - rect.left;
  const tFrac = clampN(px / rect.width, 0, 1);
  const t = chartScale.x0 + tFrac * (chartScale.x1 - chartScale.x0);
  // nearest point
  let best = chartData[0], bd = Infinity;
  for (const p of chartData) { const d = Math.abs(p.ts - t); if (d < bd) { bd = d; best = p; } }
  const xpx = (chartScale.sx(best.ts) / CH.W) * rect.width;
  cross.style.left = xpx + 'px'; cross.hidden = false;
  tip.hidden = false;
  tip.style.left = clampN(xpx, 50, rect.width - 50) + 'px';
  tip.style.top = '8px';
  tip.innerHTML = `<div class="t-time">${new Date(best.ts).toLocaleTimeString()}</div>`
    + `<div class="t-row"><i style="background:#34d399"></i>export ${fmtW(best.exportW)} W</div>`
    + `<div class="t-row"><i style="background:#60a5fa"></i>charge ${fmtW(best.chargeW)} W</div>`
    + `<div class="t-row"><i style="background:#fbbf24"></i>solar ${fmtW(best.solarW)} W</div>`
    + `<div class="t-row"><i style="background:#FF453A"></i>import ${fmtW(best.importW || 0)} W</div>`;
}
function hideHover() { tip.hidden = true; cross.hidden = true; }
box.addEventListener('mousemove', (e) => onHover(e.clientX));
box.addEventListener('mouseleave', hideHover);
box.addEventListener('touchstart', (e) => onHover(e.touches[0].clientX), { passive: true });
box.addEventListener('touchmove', (e) => onHover(e.touches[0].clientX), { passive: true });
box.addEventListener('touchend', hideHover);

// --- Stats ------------------------------------------------------------------
async function refreshStats() {
  let st; try { st = await (await fetch('/api/stats?range=' + range)).json(); } catch { return; }
  const c = st.car || {}, h = st.home || {};
  const cells = [
    ['Charged', fmtKwh(c.energyWh), 'kWh'],
    ['From solar', c.solarPct != null ? c.solarPct : '–', '%'],
    ['Peak', ((c.peakW || 0) / 1000).toFixed(1), 'kW'],
    ['Peak amps', c.peakAmps || 0, 'A'],
    ['Charge time', fmtDur(c.chargingMinutes), ''],
    ['Adjusts', c.adjustments || 0, ''],
    ['Home used', fmtKwh(h.usedWh), 'kWh'],
    ['Solar gen', fmtKwh(h.solar2GeneratedWh), 'kWh'],
    ['Exported', fmtKwh(h.exportedWh), 'kWh'],
    ['Imported', fmtKwh(h.importedWh), 'kWh'],
  ];
  $('statsGrid').innerHTML = cells.map(([k, v, u]) =>
    `<div class="glass rounded-2xl p-3.5 flex flex-col gap-1">
       <span class="text-[10px] font-semibold text-mut uppercase tracking-wider">${k}</span>
       <span class="text-[15px] font-bold tnum">${v}<span class="text-[11px] font-normal text-mut"> ${u}</span></span>
     </div>`).join('');
}
function fmtDur(min) { if (!min) return '0m'; const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${m}m` : `${m}m`; }

// --- Controls wiring --------------------------------------------------------
async function post(path, body) {
  return (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => post('/api/mode', { mode: b.dataset.mode })));
document.querySelectorAll('#rangeSeg button').forEach((b) => b.addEventListener('click', () => {
  range = b.dataset.range;
  document.querySelectorAll('#rangeSeg button').forEach((x) => x.classList.toggle('active', x === b));
  refreshStats();
}));
document.querySelectorAll('#chartRangeSeg button').forEach((b) => b.addEventListener('click', () => {
  chartHours = Number(b.dataset.hours);
  WINDOW_MS = chartHours * 3600_000;
  document.querySelectorAll('#chartRangeSeg button').forEach((x) => x.classList.toggle('active', x === b));
  loadChartHistory();
}));
// Keep longer ranges fresh (the 1h range stays live via the SSE stream).
setInterval(() => { if (chartHours > 1) loadChartHistory(); }, 30000);

$('ovRange').addEventListener('input', (e) => { $('ovVal').textContent = e.target.value; });
$('ovApply').addEventListener('click', () => post('/api/override', { amps: Number($('ovRange').value) }));
$('ovClear').addEventListener('click', () => post('/api/override/clear'));
$('chargeToggle').addEventListener('click', () => charge($('chargeToggle').dataset.action || 'start'));
async function charge(action) {
  const btn = $('chargeToggle');
  btn._busy = true; btn.textContent = '…'; btn.disabled = true;
  try { await post('/api/charge', { action }); } catch (e) { alert('Failed: ' + e.message); }
  // Release the lock shortly so the next live update reflects the new state.
  setTimeout(() => { btn._busy = false; btn.disabled = false; if (lastState) renderControls(lastState); }, 2500);
}

// --- Boot -------------------------------------------------------------------
loadChartHistory();
refreshStats();
connect();
setInterval(refreshStats, 15000);
