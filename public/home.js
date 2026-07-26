// Home dashboard front-end.
// - Energy summary + smart plugs come from the shared live state over SSE.
// - Camera TILES poll snapshots (~1 fps) so we never hold many permanent MJPEG
//   connections (that exhausts the browser's ~6-per-host limit and blanks tiles /
//   the popup). Only the FULLSCREEN viewer opens a live MJPEG stream.
// - Power chart (/api/series) has a hover crosshair + tooltip like the charger.
// - Weather (/api/weather) shows current + forecast; tap for the 16-day sheet.
const $ = (id) => document.getElementById(id);
const fmtW = (w) => (w == null || Number.isNaN(w) ? '–' : Math.round(w).toLocaleString());
const fmtKw = (w) => (w == null || Number.isNaN(w) ? '–' : (w / 1000).toFixed(1));

// iOS-style inline SVG icons (matching the Tesla view) for the energy tiles.
const ICON_PATHS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  house: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>',
};
function icon(name, size = 18) {
  const filled = name === 'bolt';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">${ICON_PATHS[name] || ''}</svg>`;
}

// --- Connection (SSE + polling fallback) ------------------------------------
function setConn(ok, text) {
  const wrap = $('conn'), dot = $('connDot'), t = $('connText');
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
    es.onerror = () => { setConn(false, 'reconnecting'); startPolling(); };
  } catch { startPolling(); }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try { handleState(await (await fetch('/api/state')).json()); } catch { setConn(false, 'offline'); }
  }, 3000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

let solarCapW = null; // rated solar ceiling from the server, used to cap the chart's solar floor
let solaxCapW = null; // SolaX rating, bounds the chart's solar floor to Growatt + this
function handleState(s) {
  setConn(true, 'live');
  solarCapW = s.computed?.solarMaxW ?? null;
  solaxCapW = s.computed?.solaxMaxW ?? null;
  applyWeatherBg(s.weather);
  renderEnergy(s);
  renderMeters(s);
  renderPlugs(s);
  renderCamStatus(s);
}

// --- Weather-reactive backdrop ----------------------------------------------
// Images live in bg/<name>.jpg|png|webp (see bg/README.md). Missing files are
// fine — the page just keeps its plain dark background.
function weatherBgName(code, isDay) {
  const d = isDay === false ? 'night' : 'day';
  if (code === 0) return `clear-${d}`;
  if (code === 1 || code === 2) return `partly-${d}`;
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'overcast';
}
let bgCurrent = null;
function applyWeatherBg(w) {
  const el = document.getElementById('bgWeather');
  if (!el || !w || !w.ok || w.code == null) return;
  const name = weatherBgName(w.code, w.isDay);
  if (name === bgCurrent) return;
  bgCurrent = name; // probe once per condition change, not every tick
  const tryLoad = (exts) => {
    if (!exts.length) return;
    const url = `bg/${name}.${exts[0]}`;
    const img = new Image();
    img.onload = () => {
      el.style.backgroundImage = `linear-gradient(rgba(5,6,8,.45), rgba(5,6,8,.85)), url('${url}')`;
      el.classList.add('on');
    };
    img.onerror = () => tryLoad(exts.slice(1));
    img.src = url;
  };
  tryLoad(['jpg', 'png', 'webp']);
}

// --- Energy summary (reused meters + SolaX) ---------------------------------
function solarTotal(s) {
  const m = s.meters || {};
  let w = 0;
  if (m.solarPanels2 < 0) w += -m.solarPanels2;
  if (s.solax && s.solax.ok && s.solax.acpower != null) w += Math.max(0, s.solax.acpower);
  else { const f1 = m.channels?.floor1?.power; if (f1 != null && f1 < 0) w += -f1; }
  // Floor by the energy balance (export + charge − import) so a laggy SolaX
  // cloud sample never reads below what physically left the panels.
  const c = s.computed || {};
  // Bound the floor: solar can't exceed live Growatt + SolaX rating (only SolaX
  // lags), so a polling-skew export/charge spike can't invent huge solar.
  const growatt = m.solarPanels2 < 0 ? -m.solarPanels2 : 0;
  let floor = Math.max(0, (c.exportW || 0) + (c.chargeW || 0) - (c.importW || 0));
  if (c.solaxMaxW != null) floor = Math.min(floor, growatt + c.solaxMaxW);
  let out = Math.max(w, floor);
  if (c.solarMaxW) out = Math.min(out, c.solarMaxW); // cap final at rated ceiling
  return out;
}
function renderEnergy(s) {
  const m = s.meters;
  if (!m) return;
  const c = s.computed || {};
  const solar = solarTotal(s);
  const gp = m.gridPower; // + import, − export
  const carW = Math.max(0, c.chargeW || 0);        // the car (charge + standby draw)
  // House per the actual metering topology: Andar de Cima (floor1) + Andar de
  // Baixo (floor2) + SolaX − car. SolaX injects into Andar de Baixo, which makes
  // that meter read LOWER (net = load − injection), so ADD SolaX back to recover
  // the floor's real load; the car's draw also sits on these circuits.
  const cima = m.channels?.floor1?.power || 0;
  const baixo = m.channels?.floor2?.power || 0;
  const solaxGenW = s.solax && s.solax.ok && s.solax.acpower != null ? Math.max(0, s.solax.acpower) : 0;
  const houseW = Math.max(0, cima + (baixo + solaxGenW) - carW);
  $('solar').textContent = fmtKw(solar);
  const growattW = m.solarPanels2 < 0 ? -m.solarPanels2 : 0;
  const solaxW = s.solax && s.solax.ok && s.solax.acpower != null ? Math.max(0, s.solax.acpower) : null;
  $('solarSub').textContent = solaxW != null ? `Growatt ${fmtW(growattW)} · SolaX ${fmtW(solaxW)} W` : `${fmtW(solar)} W now`;
  $('house').textContent = fmtKw(houseW);
  $('car').textContent = carW > 50 ? fmtKw(carW) : '0';
  // Smart grid pill: one tile that flips label + colour by direction (gp is
  // + import / − export). A small dead-band avoids flicker around zero.
  const gridEl = $('grid'), gridLabel = $('gridLabel'), gridVal = $('gridVal');
  if (gp > 5) { gridLabel.textContent = 'IMPORT'; gridVal.style.color = '#FF453A'; gridEl.textContent = fmtW(gp); }
  else if (gp < -5) { gridLabel.textContent = 'EXPORT'; gridVal.style.color = '#30D158'; gridEl.textContent = fmtW(-gp); }
  else { gridLabel.textContent = 'GRID'; gridVal.style.color = ''; gridEl.textContent = '0'; }
  // Grid voltage + power factor — live only (Shelly grid channel, not stored).
  const gridCh = m.channels?.grid || {};
  const volt = gridCh.voltage ?? m.voltage ?? c.voltage;
  const pf = gridCh.pf;
  $('volt').textContent = volt != null ? Math.round(volt) : '–';
  $('pfSub').textContent = pf != null ? `PF ${Number(pf).toFixed(2)}` : ' ';
}

// --- House per-circuit meters (ported from the Tesla view) -------------------
function renderMeters(s) {
  const body = $('metersBody');
  if (!body) return;
  const m = s.meters; if (!m) return;
  const order = ['grid', 'solarPanels2', 'floor1', 'floor2'];
  const colors = { grid: '#f2f2f7', solarPanels2: '#FFD60A', floor1: '#0A84FF', floor2: '#BF5AF2' };
  const items = order.filter((k) => m.channels?.[k]).map((k) => {
    const c = m.channels[k];
    return { key: k, label: c.label, color: colors[k], power: c.power, voltage: c.voltage, current: c.current, pf: c.pf };
  });
  // SolaX (cloud) — generation shown negative; no AC voltage/current/PF in the cloud feed.
  // Placed just above Growatt (solarPanels2).
  if (s.solax && s.solax.ok && s.solax.acpower != null) {
    const row = { label: 'SolaX', color: '#FF9F0A', power: -Math.max(0, s.solax.acpower), voltage: null, current: null, pf: null, cloud: true };
    const gi = items.findIndex((it) => it.key === 'solarPanels2');
    if (gi >= 0) items.splice(gi, 0, row); else items.push(row);
  }
  body.innerHTML = items.map((it, i, arr) => {
    const neg = it.power < 0;
    const border = i < arr.length - 1 ? 'hairline-b' : '';
    const cloudTag = it.cloud ? ' <span class="text-mut text-[10px] font-normal">cloud</span>' : '';
    return `<div class="grid grid-cols-6 py-3 items-center tnum text-[13.5px] ${border}">
      <div class="col-span-2 flex items-center gap-2 font-medium"><span class="inline-block w-2 h-2 rounded-full" style="background:${it.color}"></span>${it.label}${cloudTag}</div>
      <div class="text-right font-semibold" style="color:${neg ? '#30D158' : '#f2f2f7'}">${neg ? '−' : ''}${fmtW(Math.abs(it.power))}</div>
      <div class="text-right text-mut">${it.voltage ?? '–'}</div>
      <div class="text-right text-mut">${it.current ?? '–'}</div>
      <div class="text-right text-mut">${it.pf ?? '–'}</div>
    </div>`;
  }).join('');
}

// --- Smart plugs ------------------------------------------------------------
const busyKeys = new Set();
let plugKeysSig = '';
const plugIcon = (role) => (role === 'water_heater' ? '🔥' : '🔌');

function buildPlugs(plugs) {
  const grid = $('plugs');
  grid.innerHTML = '';
  for (const p of plugs) {
    const card = document.createElement('div');
    card.className = 'glass rounded-2xl p-4 flex flex-col gap-3';
    card.id = `plug-${p.key}`;
    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-2"><span class="text-lg">${plugIcon(p.role)}</span><span class="font-semibold text-[15px]">${p.label}</span></div>
        <div class="sw" data-key="${p.key}" data-role="${p.role}"><div class="knob"></div></div>
      </div>
      <div class="text-[28px] font-bold tnum leading-none"><span class="js-power">–</span><span class="text-sm font-normal text-mut ml-0.5">W</span></div>
      <div class="text-[12px] text-mut tnum js-sub">&nbsp;</div>`;
    grid.appendChild(card);
    card.querySelector('.sw').addEventListener('click', onToggle);
  }
}
function renderPlugs(s) {
  const k = s.kasa, grid = $('plugs');
  if (!k || !k.enabled) { grid.innerHTML = '<div class="glass rounded-2xl p-4 text-mut text-sm">Smart plugs disabled in config.</div>'; return; }
  const plugs = k.plugs || [];
  if (!plugs.length) { grid.innerHTML = '<div class="glass rounded-2xl p-4 text-mut text-sm">No plugs configured.</div>'; return; }
  const sig = plugs.map((p) => p.key).join('|');
  if (sig !== plugKeysSig) { buildPlugs(plugs); plugKeysSig = sig; }
  for (const p of plugs) {
    const card = $(`plug-${p.key}`);
    if (!card) continue;
    const sw = card.querySelector('.sw');
    if (!busyKeys.has(p.key)) { sw.classList.toggle('on', p.on === true); sw.classList.remove('busy'); }
    const power = card.querySelector('.js-power'), sub = card.querySelector('.js-sub');
    if (p.error) {
      power.textContent = '–';
      sub.textContent = '⚠ ' + p.error; sub.style.color = '#FF453A';
    } else {
      power.textContent = fmtW(p.power);
      const bits = [];
      if (p.voltage != null) bits.push(`${p.voltage} V`);
      if (p.todayKwh != null) bits.push(`${p.todayKwh.toFixed(2)} kWh today`);
      if (p.totalKwh != null) bits.push(`${p.totalKwh.toFixed(2)} kWh total`);
      sub.textContent = bits.join(' · ') || ' '; sub.style.color = '';
    }
  }
}
async function onToggle(e) {
  const sw = e.currentTarget, key = sw.dataset.key, role = sw.dataset.role;
  const turningOn = !sw.classList.contains('on');
  if (role === 'water_heater' && !confirm(`${turningOn ? 'Turn ON' : 'Turn OFF'} the Water Heater?`)) return;
  busyKeys.add(key); sw.classList.add('busy'); sw.classList.toggle('on', turningOn);
  try {
    const r = await fetch(`/api/kasa/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: turningOn }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'failed');
    if (j.plug) sw.classList.toggle('on', j.plug.on === true);
  } catch (err) {
    sw.classList.toggle('on', !turningOn);
    alert('Could not switch plug: ' + (err.message || err));
  } finally { busyKeys.delete(key); sw.classList.remove('busy'); }
}

// --- Power chart (canvas) with hover crosshair + tooltip --------------------
let chartHours = 1, chartTimer = null, chartSeries = [], chartGeom = null;
function seriesSolar(p) {
  let w = 0;
  if (p.solar2W < 0) w += -p.solar2W;
  if (p.solaxW != null && p.solaxW > 0) w += p.solaxW;
  else if (p.floor1W != null && p.floor1W < 0) w += -p.floor1W;
  return w;
}
async function loadChart() {
  let pts = [];
  try { pts = await (await fetch(`/api/series?hours=${chartHours}`)).json(); } catch { pts = []; }
  chartSeries = (pts || []).map((p) => {
    const exp = Math.max(0, -(p.gridPower ?? 0));
    const imp = Math.max(0, p.gridPower ?? 0);
    const car = Math.max(0, p.chargeW || 0);
    const growatt = p.solar2W < 0 ? -p.solar2W : 0;
    let floor = Math.max(0, exp + car - imp); // energy-balance floor (laggy SolaX)
    if (solaxCapW != null) floor = Math.min(floor, growatt + solaxCapW); // can't exceed live Growatt + SolaX rating
    let sol = Math.max(seriesSolar(p), floor);
    if (solarCapW) sol = Math.min(sol, solarCapW); // cap final so no spike shows impossible solar
    // House per topology: Andar de Cima (floor1) + (Andar de Baixo (floor2) + SolaX) − car.
    // SolaX injects into floor2, lowering that meter, so add it back to get real load.
    const solaxW = p.solaxW > 0 ? p.solaxW : 0;
    const house = Math.max(0, (p.floor1W || 0) + ((p.floor2W || 0) + solaxW) - car);
    return { ts: p.ts, exp, imp, sol, car, house };
  });
  renderChart();
}
function niceCeil(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * pow;
}
function hhmm(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

// --- Day separators + sunrise/sunset markers (ported from the charger chart) --
let geo = null; // { lat, lon } from /api/config; enables sun markers when set.
const DAY_MS = 86400_000;
// Absolute epoch-ms sunrise/sunset for the calendar day containing `date` at
// lat/lon. Compact NOAA/SunCalc port; NaN on polar day/night — callers guard.
const SUN = (() => {
  const rad = Math.PI / 180, dayMs = DAY_MS, J1970 = 2440588, J2000 = 2451545;
  const e = rad * 23.4397;
  const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const fromJ = (j) => (j + 0.5 - J1970) * dayMs;
  const meanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  const eclipticLng = (M) => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const declination = (L) => Math.asin(Math.sin(e) * Math.sin(L));
  const J0 = 0.0009;
  const transitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  return function sunTimes(date, lat, lon) {
    const lw = rad * -lon, phi = rad * lat, d = toDays(date);
    const n = Math.round(d - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n;
    const M = meanAnomaly(ds), L = eclipticLng(M), dec = declination(L);
    const Jnoon = transitJ(ds, M, L);
    const h0 = -0.833 * rad;
    const w = Math.acos((Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    const Jset = transitJ(J0 + (w + lw) / (2 * Math.PI) + n, M, L);
    return { sunrise: fromJ(Jnoon - (Jset - Jnoon)), sunset: fromJ(Jset) };
  };
})();

// Interpolated canvas-x for epoch-ms `t`, positioned against the (index-scaled)
// series so overlays land exactly on the plotted curve even if sampling is
// uneven. Clamps to the ends.
function xAtTime(t, series, X) {
  const n = series.length;
  if (!n) return null;
  if (t <= series[0].ts) return X(0);
  if (t >= series[n - 1].ts) return X(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid].ts <= t) lo = mid; else hi = mid; }
  const t0 = series[lo].ts, t1 = series[hi].ts;
  return X(lo + (t1 > t0 ? (t - t0) / (t1 - t0) : 0));
}
function localMidnight(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Draw day separators, night shading and sun markers. `layer` = 'back' (night
// shading, before the data) or 'front' (separators + sun lines/labels, on top).
function drawDayNight(ctx, series, X, padT, H, layer) {
  if (series.length < 2) return;
  const x0 = series[0].ts, x1 = series[series.length - 1].ts;
  const showSun = geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon) && (x1 - x0) <= 8 * DAY_MS;
  const yTop = padT, yBot = padT + H;
  ctx.save();
  ctx.font = '10px Inter, sans-serif';
  for (let day = localMidnight(x0); day <= x1; day += DAY_MS) {
    const dayEnd = day + DAY_MS;
    const sun = showSun ? SUN(new Date(day + DAY_MS / 2), geo.lat, geo.lon) : null;
    if (layer === 'back' && sun) {
      ctx.fillStyle = 'rgba(10,18,32,.28)';
      const band = (a, b) => {
        const xa = xAtTime(Math.max(x0, a), series, X), xb = xAtTime(Math.min(x1, b), series, X);
        if (xb - xa >= 0.5) ctx.fillRect(xa, yTop, xb - xa, H);
      };
      if (Number.isFinite(sun.sunrise)) band(day, sun.sunrise);
      if (Number.isFinite(sun.sunset)) band(sun.sunset, dayEnd);
    }
    if (layer === 'front' && day > x0 && day < x1) {
      const x = xAtTime(day, series, X);
      ctx.strokeStyle = 'rgba(132,153,189,.35)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(132,153,189,.75)'; ctx.textAlign = 'left';
      ctx.fillText(new Date(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), x + 3, yBot - 3);
    }
    if (layer === 'front' && sun) {
      const mark = (t, glyph) => {
        if (!Number.isFinite(t) || t < x0 || t > x1) return;
        const x = xAtTime(t, series, X);
        ctx.strokeStyle = 'rgba(251,191,36,.5)'; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
        ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'center'; ctx.fillText(glyph, x, yTop + 11);
      };
      mark(sun.sunrise, '🌅');
      mark(sun.sunset, '🌇');
    }
  }
  ctx.restore();
}
function renderChart(hoverIndex) {
  const canvas = $('chart'), empty = $('chartEmpty'), tip = $('chartTip');
  const series = chartSeries;
  if (!series.length) { empty.hidden = false; canvas.style.display = 'none'; if (tip) tip.hidden = true; return; }
  empty.hidden = true; canvas.style.display = 'block';
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320, cssH = 180;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cssW, cssH);
  const padL = 4, padR = 4, padT = 10, padB = 18;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  let max = 0; for (const p of series) max = Math.max(max, p.exp, p.imp, p.sol, p.car, p.house);
  const niceMax = niceCeil(Math.max(max, 500));
  const X = (i) => padL + (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const Y = (v) => padT + H - (v / niceMax) * H;
  chartGeom = { padL, W, n: series.length };
  drawDayNight(ctx, series, X, padT, H, 'back'); // night shading behind the data
  ctx.font = '10px Inter, sans-serif';
  for (let g = 0; g <= 2; g++) {
    const gv = (niceMax * g) / 2, gy = Y(gv);
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + W, gy); ctx.stroke();
    ctx.fillStyle = '#9a9aa2'; ctx.textAlign = 'left'; ctx.fillText((gv / 1000).toFixed(1) + ' kW', padL + 2, gy - 2);
  }
  const drawSeries = (key, color, fill) => {
    ctx.beginPath();
    series.forEach((p, i) => { const x = X(i), y = Y(p[key]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineTo(X(series.length - 1), padT + H); ctx.lineTo(X(0), padT + H); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.beginPath();
    series.forEach((p, i) => { const x = X(i), y = Y(p[key]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  };
  drawSeries('sol', '#fbbf24', 'rgba(251,191,36,.10)');
  drawSeries('exp', '#34d399', 'rgba(52,211,153,.10)');
  drawSeries('imp', '#FF453A', 'rgba(255,69,58,.10)');
  drawSeries('house', '#bf5af2', 'rgba(191,90,242,.08)');
  drawSeries('car', '#60a5fa', 'rgba(96,165,250,.08)');
  drawDayNight(ctx, series, X, padT, H, 'front'); // separators + sun markers on top
  ctx.fillStyle = '#9a9aa2';
  ctx.textAlign = 'left'; ctx.fillText(hhmm(new Date(series[0].ts)), padL, cssH - 5);
  ctx.textAlign = 'right'; ctx.fillText(hhmm(new Date(series[series.length - 1].ts)), padL + W, cssH - 5);

  if (hoverIndex != null && hoverIndex >= 0 && hoverIndex < series.length) {
    const hx = X(hoverIndex), p = series[hoverIndex];
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + H); ctx.stroke();
    for (const [k, c] of [['sol', '#fbbf24'], ['exp', '#34d399'], ['imp', '#FF453A'], ['house', '#bf5af2'], ['car', '#60a5fa']]) {
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(hx, Y(p[k]), 3, 0, Math.PI * 2); ctx.fill();
    }
    if (tip) {
      tip.hidden = false;
      tip.innerHTML = `<div class="t-time">${hhmm(new Date(p.ts))}</div>`
        + `<div class="t-row"><i style="background:#fbbf24"></i>Solar ${fmtW(p.sol)} W</div>`
        + `<div class="t-row"><i style="background:#bf5af2"></i>House ${fmtW(p.house)} W</div>`
        + `<div class="t-row"><i style="background:#60a5fa"></i>Car ${fmtW(p.car)} W</div>`
        + `<div class="t-row"><i style="background:#34d399"></i>Export ${fmtW(p.exp)} W</div>`
        + `<div class="t-row"><i style="background:#FF453A"></i>Import ${fmtW(p.imp)} W</div>`;
      tip.style.left = Math.max(46, Math.min(cssW - 46, hx)) + 'px';
    }
  } else if (tip) { tip.hidden = true; }
}
function chartPointer(e) {
  if (!chartGeom || !chartSeries.length) return;
  const rect = $('chart').getBoundingClientRect();
  const px = e.clientX - rect.left;
  const { padL, W, n } = chartGeom;
  let idx = Math.round(((px - padL) / W) * (n - 1));
  idx = Math.max(0, Math.min(n - 1, idx));
  renderChart(idx);
}
$('chart').addEventListener('pointermove', chartPointer);
$('chart').addEventListener('pointerdown', chartPointer);
$('chart').addEventListener('pointerleave', () => renderChart());
$('rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  chartHours = Number(b.dataset.h);
  [...$('rangeSeg').children].forEach((x) => x.classList.toggle('active', x === b));
  loadChart();
});

// --- Weather (current + forecast + 16-day sheet) ----------------------------
let lastForecast = null;
function hhFromIso(t) { const m = String(t).match(/T(\d{2})/); return m ? m[1] + 'h' : ''; }
function tFromIso(t) { const m = String(t).match(/T(\d{2}:\d{2})/); return m ? m[1] : ''; }
function dayName(d) { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase(); }
function fullDay(d) { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }).toLowerCase(); }
async function loadWeather() {
  let data; try { data = await (await fetch('/api/weather')).json(); } catch { return; }
  const cur = data.current, fc = data.forecast;
  if (cur && cur.ok) {
    $('wxIcon').textContent = cur.icon || '·';
    $('wxTemp').textContent = cur.tempC != null ? Math.round(cur.tempC) : '–';
    $('wxText').textContent = cur.text || '';
    const meta = [];
    if (cur.apparentC != null) meta.push(`Feels ${Math.round(cur.apparentC)}°`);
    if (cur.humidity != null) meta.push(`💧 ${cur.humidity}%`);
    if (cur.windKmh != null) meta.push(`💨 ${Math.round(cur.windKmh)} km/h`);
    if (cur.cloudCover != null) meta.push(`☁ ${cur.cloudCover}%`);
    $('wxMeta').innerHTML = meta.join('<br>');
  }
  if (fc) lastForecast = fc;
  if (fc && fc.hourly && fc.hourly.length) {
    $('wxHourly').innerHTML = fc.hourly.map((h) => `
      <div class="hcell">
        <div class="text-[11px] text-mut">${hhFromIso(h.time)}</div>
        <div class="text-[20px] leading-tight">${h.icon}</div>
        <div class="text-[13px] font-semibold tnum">${h.tempC != null ? Math.round(h.tempC) : '–'}°</div>
        <div class="text-[10px] text-ios-blue tnum">${h.precip ? h.precip + '%' : '&nbsp;'}</div>
      </div>`).join('');
  }
  if (fc && fc.daily && fc.daily.length) {
    $('wxDaily').innerHTML = fc.daily.slice(0, 7).map((d, i) => `
      <div class="glass rounded-xl p-2 text-center flex flex-col gap-0.5">
        <div class="text-[11px] text-mut">${i === 0 ? 'today' : dayName(d.date)}</div>
        <div class="text-[20px]">${d.icon}</div>
        <div class="text-[12px] font-semibold tnum">${d.tMax != null ? Math.round(d.tMax) : '–'}°</div>
        <div class="text-[11px] text-mut tnum">${d.tMin != null ? Math.round(d.tMin) : '–'}°</div>
        <div class="text-[10px] text-ios-blue tnum">${d.precip ? d.precip + '%' : '&nbsp;'}</div>
      </div>`).join('');
  }
}
function openWxModal() {
  if (!lastForecast || !lastForecast.daily || !lastForecast.daily.length) return;
  $('wxModalList').innerHTML = lastForecast.daily.map((d, i) => `
    <div class="rounded-xl p-3 flex items-center gap-3" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)">
      <div class="text-[26px] leading-none">${d.icon}</div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-[14px]">${i === 0 ? 'today' : fullDay(d.date)}</div>
        <div class="text-[12px] text-mut">${d.text || ''}${d.precip ? ' · 💧 ' + d.precip + '%' : ''}</div>
        <div class="text-[11px] text-mut">🌅 ${tFromIso(d.sunrise)} · 🌇 ${tFromIso(d.sunset)}</div>
      </div>
      <div class="text-right"><div class="font-bold tnum text-[15px]">${d.tMax != null ? Math.round(d.tMax) : '–'}°</div><div class="text-mut tnum text-[12px]">${d.tMin != null ? Math.round(d.tMin) : '–'}°</div></div>
    </div>`).join('');
  $('wxModal').classList.add('open');
}
function closeWxModal() { $('wxModal').classList.remove('open'); }
$('wxMore').addEventListener('click', (e) => { e.stopPropagation(); openWxModal(); });
$('wxCard').addEventListener('click', openWxModal);
$('wxModalClose').addEventListener('click', closeWxModal);
$('wxModal').addEventListener('click', (e) => { if (e.target.id === 'wxModal') closeWxModal(); });

// --- Cameras (tiles poll snapshots; fullscreen uses live stream) ------------
const REFRESH_MS = 900;
let camStops = [];
function renderCamStatus(s) {
  const c = s.cameras, el = $('camStatus');
  if (!c || !c.enabled) { el.textContent = ''; return; }
  el.textContent = c.reachable ? `${c.count} cameras · Agent DVR live` : 'Agent DVR offline';
  el.style.color = c.reachable ? '' : '#FF453A';
}
function startCamPoller(tile, cam) {
  const img = tile.querySelector('img');
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (document.hidden) { setTimeout(tick, 1500); return; }
    const probe = new Image();
    probe.onload = () => { if (stopped) return; img.src = probe.src; tile.classList.remove('failed'); setTimeout(tick, REFRESH_MS); };
    probe.onerror = () => { if (stopped) return; tile.classList.add('failed'); setTimeout(tick, 2500); };
    probe.src = `/api/cameras/${cam.oid}/snapshot?t=${Date.now()}`;
  };
  tick();
  return () => { stopped = true; };
}
function buildCamTile(cam) {
  const tile = document.createElement('div');
  tile.className = 'cam glass';
  tile.innerHTML = `<img alt="" /><div class="err"><span>No signal</span></div>`;
  tile.addEventListener('click', () => openViewer(cam));
  return tile;
}
async function loadCameras(retry = true) {
  const grid = $('cams');
  let data;
  try { data = await (await fetch('/api/cameras')).json(); }
  catch { grid.innerHTML = '<div class="glass rounded-2xl p-4 text-mut text-sm">Could not load cameras.</div>'; return; }
  if (!data.enabled) { $('camsSection').hidden = true; return; }
  const cams = data.cameras || [];
  if (!cams.length) {
    if (retry) return void setTimeout(() => loadCameras(false), 3000);
    grid.innerHTML = '<div class="glass rounded-2xl p-4 text-mut text-sm">No cameras found.</div>'; return;
  }
  camStops.forEach((fn) => fn()); camStops = [];
  grid.innerHTML = '';
  for (const cam of cams) { const tile = buildCamTile(cam); grid.appendChild(tile); camStops.push(startCamPoller(tile, cam)); }
}

// Fullscreen viewer — the ONE live MJPEG stream (full-res). Cleared on close.
function openViewer(cam) {
  $('viewerImg').src = `/api/cameras/${cam.oid}/stream?size=1280x720&t=${Date.now()}`;
  $('viewer').classList.add('open');
}
function closeViewer() {
  $('viewer').classList.remove('open');
  $('viewerImg').src = '';
}
$('viewerClose').addEventListener('click', closeViewer);
$('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeViewer(); closeWxModal(); } });

// --- Whole-home energy totals, from /api/stats -------------------------------
// Range/offset state, fetching and the label live in period-nav.js (shared with
// /charger); this page only renders the four tiles from the response.
const fmtKwh = (wh) => (wh == null ? '–' : (wh / 1000).toFixed(2));
// period-nav.js is a separate <script> that may fail to load (stale iOS
// home-screen cache, blocked request, etc). Guard the call so a missing/
// throwing createPeriodNav can never halt this script — the rest of the
// page (cameras, weather, chart, live connection) must always initialize.
let statsNav = null;
try {
  if (typeof createPeriodNav === 'function') {
    statsNav = createPeriodNav({
      navEl: $('homePeriodNav'), labelEl: $('homePeriodLabel'),
      prevEl: $('homePeriodPrev'), nextEl: $('homePeriodNext'), segEl: $('homeRangeSeg'),
      onData: renderStats,
    });
  } else {
    console.error('period-nav.js did not load — stats navigation disabled');
  }
} catch (e) {
  console.error('period nav init failed', e);
}
function loadStats() { if (statsNav) statsNav.refresh(); }

function renderStats(st) {
  const h = st.home || {};
  $('stSolarGen').textContent = fmtKwh(h.solarGeneratedWh);
  // Solar self-consumed = generated − exported (what stayed on-site).
  const solarUsed = h.solarGeneratedWh == null ? null : Math.max(0, h.solarGeneratedWh - (h.exportedWh || 0));
  $('stSolarUsed').textContent = fmtKwh(solarUsed);
  $('stExported').textContent = fmtKwh(h.exportedWh);
  $('stImported').textContent = fmtKwh(h.importedWh);
  $('stHouseUsed').textContent = fmtKwh(h.usedWh);
  $('stCost').textContent = st.cost ? st.cost.total.toFixed(2) : '–';
  $('stCostCur').textContent = st.cost ? st.cost.currency : '';
}

// --- Settings (billing day + tariff) ---------------------------------------
let tariffState = null;

function winToStr(windows) {
  return (windows || []).map(([s, e]) => `${s}-${e}`).join(',');
}
function parseWindows(str) {
  const out = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) throw new Error(`bad window "${part}" — use e.g. 0-8,22-24`);
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}
function fillTariffForm(t) {
  $('setCurrency').value = t.currency;
  $('setDailyFixed').value = t.dailyFixed;
  $('setLevy').value = t.perKwhLevy;
  $('setFixedMonthly').value = t.fixedMonthly;
  $('setVat').value = t.vatPct;
  $('tariffBands').innerHTML = t.bands.map((b, i) =>
    `<div class="grid grid-cols-3 gap-2 items-center">
       <span class="text-[12px]">${b.name}</span>
       <input id="band${i}Rate" type="number" step="0.0001" value="${b.rate}" class="px-2 py-1.5 rounded-xl text-[14px] tnum" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" />
       <input id="band${i}Win" type="text" value="${winToStr(b.windows)}" placeholder="0-8,22-24" class="px-2 py-1.5 rounded-xl text-[13px]" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f2f2f7" />
     </div>`).join('');
}
async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    $('setBillingDay').value = s.billingDay;
    tariffState = s.tariff;
    fillTariffForm(s.tariff);
  } catch { /* leave form empty */ }
}
async function saveSettings() {
  const err = $('settingsError');
  err.hidden = true;
  try {
    const bands = tariffState.bands.map((b, i) => ({
      name: b.name,
      rate: Number($(`band${i}Rate`).value),
      windows: parseWindows($(`band${i}Win`).value),
    }));
    const body = {
      billingDay: Number($('setBillingDay').value),
      tariff: {
        currency: $('setCurrency').value,
        bands,
        dailyFixed: Number($('setDailyFixed').value),
        perKwhLevy: Number($('setLevy').value),
        fixedMonthly: Number($('setFixedMonthly').value),
        vatPct: Number($('setVat').value),
      },
    };
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'save failed'); }
    const saved = await res.json();
    tariffState = saved.tariff;
    fillTariffForm(saved.tariff);
    $('settingsPanel').hidden = true;
    loadStats();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}
$('settingsToggle')?.addEventListener('click', () => { $('settingsPanel').hidden = !$('settingsPanel').hidden; });
$('settingsSave')?.addEventListener('click', saveSettings);
loadSettings();

// --- Boot --------------------------------------------------------------------
$('ic-solar').innerHTML = icon('sun');
$('ic-car').innerHTML = icon('bolt');
$('ic-house').innerHTML = icon('house');
loadCameras();
loadWeather();
// Site location for the chart's sunrise/sunset markers; redraw once it lands.
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (Number.isFinite(c?.lat) && Number.isFinite(c?.lon)) { geo = { lat: c.lat, lon: c.lon }; renderChart(); }
}).catch(() => {});

loadChart();
loadStats();
connect();
chartTimer = setInterval(loadChart, 20_000);
setInterval(loadWeather, 600_000);
// Stats polling + refresh-on-wake live inside createPeriodNav (period-nav.js).
