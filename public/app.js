// Dashboard front-end. Live updates over Server-Sent Events (falls back to
// polling). Interactive chart with hover crosshair + tooltip.
const $ = (id) => document.getElementById(id);
const fmtW = (w) => (w == null || Number.isNaN(w) ? '–' : Math.round(w).toLocaleString());
const fmtKwh = (wh) => (wh == null ? '0' : (wh / 1000).toFixed(2));
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// --- iOS-style (SF Symbols-ish) inline SVG icons -----------------------------
const ICON_PATHS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  cloud: '<path d="M7 18h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5 9.5 3.5 3.5 0 0 0 7 18z"/>',
  cloudSun: '<circle cx="7.5" cy="7.5" r="2.6"/><path d="M7.5 2.3v1M2.3 7.5h1M3.9 3.9l.7.7M11.1 3.9l-.7.7"/><path d="M9 19h7a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7 13 3 3 0 0 0 9 19z"/>',
  rain: '<path d="M7 15h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5 6.5 3.5 3.5 0 0 0 7 15z"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>',
  fog: '<path d="M7 13h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5 4.5 3.5 3.5 0 0 0 7 13z"/><path d="M4 17h14M7 21h10"/>',
  snow: '<path d="M7 14h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5 5.5 3.5 3.5 0 0 0 7 14z"/><path d="M9 18.5h.01M13 18.5h.01M11 21h.01"/>',
  storm: '<path d="M7 14h9a4 4 0 0 0 .5-7.97A6 6 0 0 0 5 5.5 3.5 3.5 0 0 0 7 14z"/><path d="M12 13l-2 4h3l-2 4"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 13l4-3"/><circle cx="12" cy="18" r="1.1"/>',
};
function icon(name, size = 20) {
  const filled = name === 'bolt';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">${ICON_PATHS[name] || ''}</svg>`;
}
function weatherIconName(code) {
  if (code === 0) return 'sun';
  if (code === 1 || code === 2) return 'cloudSun';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
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

let range = 'today';
let lastState = null;
let bannerDismissed = null; // banner content signature the user tapped away
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
  if (p.solar2W < 0) w += -p.solar2W; // Growatt clamp
  if (p.solaxW != null && p.solaxW > 0) {
    w += p.solaxW; // SolaX (recorded from cloud)
  } else if (p.floor1W != null && p.floor1W < 0) {
    w += -p.floor1W; // fallback proxy for older samples without SolaX
  }
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
  renderWeather(s);
  renderDetail(s);
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
  const row = $('bufferRow'), track = $('bufferTrack');
  const minA = s.computed?.minAmps ?? 5;
  const canCharge = (s.computed?.potentialAmps ?? 0) >= minA;
  // The buffer bar only makes sense when exporting AND there's enough for the 5A min.
  const showBar = exporting && canCharge;
  row.style.display = showBar ? '' : 'none';
  track.style.display = showBar ? '' : 'none';

  if (exporting && canCharge) {
    const p = Math.round((exp / buf) * 100);
    bar.style.width = clampN(p, 0, 100) + '%';
    bar.style.background = p >= 100 ? '#30D158' : '#FFD60A';
    pct.textContent = p + '%';
    label.textContent = 'EXPORT vs BUFFER';
    const free = Math.max(0, exp - buf);
    sub.textContent = `exporting ${fmtW(exp)} W · ${fmtW(free)} W free for the car (≈${(free / volt).toFixed(1)} A)`;
  } else if (exporting) {
    sub.textContent = `exporting ${fmtW(exp)} W · not enough to charge (need ≥${minA}A)`;
  } else {
    sub.textContent = `importing ${fmtW(imp)} W from the grid — not enough sun`;
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
  const volt = comp?.voltage || 230;
  // What we COULD charge at from current surplus (no min clamp, so it can read 0).
  const potential = comp ? clampN(Math.floor((comp.surplusW || 0) / volt), 0, comp.ampCeiling || 32) : 0;
  const connected = (s.wc && !s.wc.error) ? s.wc.connected : car?.pluggedIn;
  const isFull = (s.fullCharge || car?.batteryLevel >= 100) && !!connected;
  // Status-colored charging icon: red unplugged, blue charging, green full,
  // orange throttled, grey plugged-but-idle.
  const icEl = $('ic-charge');
  if (icEl) icEl.style.color = s.charging ? (comp?.throttled ? '#FF9F0A' : '#0A84FF') : isFull ? '#30D158' : connected ? '#9a9aa2' : '#FF453A';
  const unitEl = $('chargeUnit');
  if (unitEl) unitEl.textContent = 'A';
  const standbyW = comp?.standbyW || 0;
  const climateLabel = car?.climateOn
    ? ((car.outsideTemp ?? 20) >= 18 ? '❄️ cooling' : '🔥 heating')
    : '⚙️ conditioning';
  let cs;
  if (s.charging) {
    $('chargeAmps').textContent = actual ?? commanded ?? '?';
    cs = `${fmtW(comp?.chargeW)} W`;
    if (comp?.throttled) {
      const ti = comp.throttleInfo;
      cs = ti ? `car cut ${ti.requestA}→${ti.actualA}A (V drop)` : `set ${commanded}→${actual}A (V drop)`;
    }
    if (car?.batteryLevel != null) cs += ` · ${car.batteryLevel}%${car.chargeLimitSoc ? `→${car.chargeLimitSoc}%` : ''}`;
    if (car?.timeToFull > 0) cs += ` · ${fmtEta(car.timeToFull)}`;
    if (s.wc && !s.wc.error && s.wc.sessionWh != null) cs += ` · ${(s.wc.sessionWh / 1000).toFixed(1)} kWh`;
  } else if (isFull) {
    $('chargeAmps').textContent = 'Full';
    if (unitEl) unitEl.textContent = '';
    cs = '🔋 charged';
    if (standbyW > 100) cs += ` · ${climateLabel} · ${comp?.actualAmps != null ? Math.round(comp.actualAmps) + 'A · ' : ''}${fmtW(standbyW)} W`;
    else cs += ` · auto resumes ≤ ${s.fullResumeSoc ?? 92}% or on Start`;
  } else {
    $('chargeAmps').textContent = 0;
    cs = connected ? 'plugged in' : 'unplugged';
    if (connected && standbyW > 100) {
      // Plugged in, not charging, but drawing power for climate/battery conditioning
      // or Sentry — show the draw so it isn't mistaken for a charge.
      cs += ` · ${climateLabel} · ${comp?.actualAmps != null ? Math.round(comp.actualAmps) + 'A · ' : ''}${fmtW(standbyW)} W`;
    } else {
      cs += potential > 0 ? ` · could charge at ${potential}A from sun` : ' · not enough sun';
    }
    if (car?.batteryLevel != null) cs += ` · ${car.batteryLevel}%`;
  }
  $('chargeSub').textContent = cs;

  if (comp) {
    // Target reflects what the controller will actually command.
    let targetVal, targetSub;
    if (s.override) { targetVal = s.override.amps; targetSub = 'manual override'; }
    else if (comp.scheduleActive) { targetVal = s.schedule?.amps ?? comp.targetAmps; targetSub = 'scheduled charge'; }
    else if (comp.enoughToCharge) { targetVal = comp.targetAmps; targetSub = `${fmtW(comp.surplusW)} W from sun`; }
    else { targetVal = 0; targetSub = 'not enough sun'; }
    $('targetAmps').textContent = targetVal;
    $('targetSub').textContent = targetSub;
  }
  const gv = m?.channels?.grid;
  $('houseV').textContent = gv?.voltage ?? comp?.voltage ?? '–';
  $('houseVSub').textContent = gv?.pf != null ? `PF ${gv.pf}` : '';
}

function renderMeters(s) {
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
  const rows = items.map((it, i, arr) => {
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

  // Sync the slider to what it currently controls: the live override amps while
  // override mode is on, otherwise the solar-auto ceiling. Skip while dragging.
  const range = $('ovRange');
  const dragging = document.activeElement === range || (range._touchedAt && Date.now() - range._touchedAt < 4000);
  const sliderTarget = s.override ? s.override.amps : s.maxAmps;
  if (!dragging && sliderTarget != null && Number(range.value) !== sliderTarget) {
    range.value = sliderTarget;
    $('ovVal').textContent = sliderTarget;
  }

  // Schedule card (don't clobber inputs the user is editing).
  const sc = s.schedule;
  if (sc) {
    const en = $('schedEnabled');
    if (document.activeElement !== en) en.checked = !!sc.enabled;
    for (const [id, val] of [['schedStart', sc.start], ['schedEnd', sc.end], ['schedAmps', sc.amps]]) {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = val;
    }
    const active = s.computed?.scheduleActive;
    $('schedSummary').textContent = sc.enabled
      ? `${sc.start}–${sc.end} · ${sc.amps}A${active ? ' · active now' : ''}`
      : 'off';
  }

  // Battery-limit-increase card (don't clobber the toggle while the user taps it).
  const boostEn = $('boostEnabled');
  if (boostEn) {
    if (document.activeElement !== boostEn) boostEn.checked = !!s.allowLimitIncrease;
    const limit = s.car?.chargeLimitSoc, soc = s.car?.batteryLevel;
    $('boostSummary').textContent = s.limitBoosted
      ? `boosting to 100%${soc != null ? ` · now ${soc}%` : ''}`
      : s.allowLimitIncrease
        ? `on${limit != null ? ` · your limit ${limit}%` : ''}`
        : 'off';
  }

  // Override controls reflect whether a manual hold is active.
  const ov = s.override;
  const apply = $('ovApply'), clear = $('ovClear'), lbl = $('ovLabel');
  if (ov) {
    apply.className = 'lg-btn lg-btn-blue flex-1';
    apply.textContent = `Override ${ov.amps}A`;
    clear.className = 'lg-btn lg-btn-soft flex-1';
    clear.disabled = false;
    clear.style.cssText = '';
    if (lbl) lbl.textContent = 'Override on — drag to adjust';
  } else {
    apply.className = 'lg-btn lg-btn-soft flex-1';
    apply.textContent = 'Override';
    clear.className = 'lg-btn lg-btn-ghost flex-1';
    clear.disabled = true;
    clear.style.cssText = 'opacity:.4;pointer-events:none;cursor:not-allowed';
    if (lbl) lbl.textContent = 'Charge limit';
  }
}

function renderDetail(s) {
  const grid = $('detailGrid'); if (!grid) return;
  const car = s.car || {}, wc = (s.wc && !s.wc.error) ? s.wc : {};
  const C = (n) => (n == null ? null : `${Math.round(n)}°`);
  const tiles = [];
  const add = (k, v, u = '') => { if (v != null && v !== '' && v !== '–') tiles.push([k, v, u]); };

  add('Cable temp', C(wc.handleTempC));
  add('Charger temp', C(wc.pcbaTempC));
  add('Cabin', C(car.insideTemp));
  add('Outside', C(car.outsideTemp));
  add('Battery', car.batteryLevel != null ? car.batteryLevel : null, '%');
  add('Range', car.estRangeKm != null ? Math.round(car.estRangeKm) : null, 'km');
  const charging = s.charging && car.timeToFull > 0;
  add(`To ${car.chargeLimitSoc || 100}%`, charging ? fmtEta(car.timeToFull) : null);
  add('Done by', charging ? fmtClock(car.timeToFull) : null);

  if (!tiles.length) { grid.innerHTML = `<div class="text-mut text-[12px] col-span-3 px-1">No vehicle data yet.</div>`; return; }
  grid.innerHTML = tiles.map(([k, v, u]) =>
    `<div class="glass rounded-2xl p-3.5 flex flex-col gap-1">
       <span class="text-[10px] font-semibold text-mut uppercase tracking-wider">${k}</span>
       <span class="text-[15px] font-bold tnum">${v}<span class="text-[11px] font-normal text-mut"> ${u}</span></span>
     </div>`).join('');
}

function renderWeather(s) {
  const el = $('weather'); const w = s.weather;
  applyWeatherBg(w);
  if (w && w.ok && w.tempC != null) {
    el.hidden = false;
    el.className = 'flex items-center gap-3';
    const name = weatherIconName(w.code);
    const wColor = (name === 'sun' || name === 'cloudSun') ? '#FFD60A' : '#cfd6e6';
    el.innerHTML =
      `<span class="flex items-center gap-1" style="color:${wColor}">${icon(name, 16)}<span class="text-[12px]" style="color:#f2f2f7">${Math.round(w.tempC)}°</span></span>`
      + `<span class="flex items-center gap-1 text-mut">${icon('cloud', 14)}<span class="text-[12px]">${Math.round(w.cloudCover)}%</span></span>`;
    el.title = `${w.text} · feels ${Math.round(w.apparentC)}° · ${Math.round(w.radiation)} W/m² · wind ${Math.round(w.windKmh)} km/h`;
  } else {
    el.hidden = true;
  }
}

function fmtEta(h) {
  if (!h || h <= 0) return '';
  const mins = Math.round(h * 60), hh = Math.floor(mins / 60), mm = mins % 60;
  return hh ? `${hh}h${mm}m` : `${mm}m`;
}

// Absolute completion clock time, e.g. "03:45" — h is hours-from-now.
function fmtClock(h) {
  if (!h || h <= 0) return '';
  const d = new Date(Date.now() + h * 3600e3);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  if (comp?.solarCouldChargeFaster && s.override) msgs.push(`☀️ Solar could charge faster — surplus supports ${comp.potentialAmps}A vs your ${s.override.amps}A override. Tap “Auto” to use the free solar.`);
  if (comp?.scheduleActive) msgs.push(`🌙 Scheduled charge active — charging from grid at ${s.schedule?.amps}A.`);
  if (s.fullCharge) msgs.push(`🔋 Car fully charged — automatic charging paused until you start a charge or the battery drops to ${s.fullResumeSoc ?? 92}%.`);
  if (comp?.insufficientSolar && !s.fullCharge) msgs.push('⛅ Charging stopped — not enough solar energy.');
  if (comp?.throttled) {
    const ti = comp.throttleInfo;
    msgs.push(ti
      ? `⚡ Car reduced the charge rate at ${new Date(ti.since).toLocaleTimeString()} (asked ${ti.requestA}A, got ${ti.actualA}A — voltage drop). ${ti.holdUntil > Date.now() ? `Holding ≤${ti.actualA}A, retrying at ${new Date(ti.holdUntil).toLocaleTimeString()}.` : 'Retrying now…'}`
      : `⚡ Car throttling to ${comp.actualAmps}A (set ${comp.commandedAmps}A) — line voltage dropping under load.`);
  }
  // Tap the banner to dismiss it; it reappears only when its content changes.
  const sig = msgs.join('|');
  if (bannerDismissed && bannerDismissed !== sig) bannerDismissed = null;
  b.hidden = !msgs.length || bannerDismissed === sig;
  b.innerHTML = msgs.join('<br>');
  b.style.cursor = 'pointer';
  b.onclick = () => { bannerDismissed = sig; b.hidden = true; };
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
function onHover(clientX, clientY) {
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
  // Fill content first so we can measure the box for vertical clamping.
  tip.innerHTML = `<div class="t-time">${new Date(best.ts).toLocaleTimeString()}</div>`
    + `<div class="t-row"><i style="background:#34d399"></i>export ${fmtW(best.exportW)} W</div>`
    + `<div class="t-row"><i style="background:#60a5fa"></i>charge ${fmtW(best.chargeW)} W</div>`
    + `<div class="t-row"><i style="background:#fbbf24"></i>solar ${fmtW(best.solarW)} W</div>`
    + `<div class="t-row"><i style="background:#FF453A"></i>import ${fmtW(best.importW || 0)} W</div>`;
  tip.style.left = clampN(xpx, 60, rect.width - 60) + 'px';
  // Float above the cursor, but flip below it (and clamp) if that would clip the top —
  // so the tooltip never escapes up into the range buttons above the chart.
  const th = tip.offsetHeight;
  const py = clientY != null ? clientY - rect.top : rect.height / 2;
  let top = py - th - 14;
  if (top < 4) top = py + 18;
  tip.style.top = clampN(top, 4, Math.max(4, rect.height - th - 4)) + 'px';
}
function hideHover() { tip.hidden = true; cross.hidden = true; }
box.addEventListener('mousemove', (e) => onHover(e.clientX, e.clientY));
box.addEventListener('mouseleave', hideHover);
box.addEventListener('touchstart', (e) => onHover(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
box.addEventListener('touchmove', (e) => onHover(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
box.addEventListener('touchend', hideHover);

// --- Stats ------------------------------------------------------------------
async function refreshStats() {
  let st; try { st = await (await fetch('/api/stats?range=' + range)).json(); } catch { return; }
  const c = st.car || {};
  const cells = [
    ['Charged', fmtKwh(c.energyWh), 'kWh'],
    ['Using solar', fmtKwh(c.solarWh), 'kWh'],
    ['Using grid', fmtKwh(c.gridWh), 'kWh'],
    ['From solar', c.solarPct != null ? c.solarPct : '–', '%'],
    ['Peak', ((c.peakW || 0) / 1000).toFixed(1), 'kW'],
    ['Peak amps', c.peakAmps || 0, 'A'],
    ['Charge time', fmtDur(c.chargingMinutes), ''],
    ['Adjusts', c.adjustments || 0, ''],
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
function postSchedule() {
  post('/api/schedule', {
    enabled: $('schedEnabled').checked,
    start: $('schedStart').value,
    end: $('schedEnd').value,
    amps: Number($('schedAmps').value),
  });
}
['schedEnabled', 'schedStart', 'schedEnd', 'schedAmps'].forEach((id) =>
  $(id).addEventListener('change', postSchedule));

$('boostEnabled').addEventListener('change', (e) => post('/api/limit-boost', { on: e.target.checked }));

document.querySelectorAll('#chartRangeSeg button').forEach((b) => b.addEventListener('click', () => {
  chartHours = Number(b.dataset.hours);
  WINDOW_MS = chartHours * 3600_000;
  document.querySelectorAll('#chartRangeSeg button').forEach((x) => x.classList.toggle('active', x === b));
  loadChartHistory();
}));
// Keep longer ranges fresh (the 1h range stays live via the SSE stream).
setInterval(() => { if (chartHours > 1) loadChartHistory(); }, 30000);

$('ovRange').addEventListener('input', (e) => { $('ovVal').textContent = e.target.value; e.target._touchedAt = Date.now(); });
// Releasing the slider applies its value. With override mode on it live-adjusts the
// forced charge amps (no need to re-press Override); otherwise it sets the solar-auto
// ceiling (auto charges between 5A and this value).
$('ovRange').addEventListener('change', (e) => {
  const amps = Number(e.target.value);
  if (lastState?.override) post('/api/override', { amps });
  else post('/api/maxamps', { amps });
});
// The Override button only turns override mode ON (forces a charge at the current
// slider value); the slider then adjusts the rate live. "Back to auto" turns it off.
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
// Inject the static card glyphs as iOS-style SVG icons.
$('ic-solar').innerHTML = icon('sun', 20);
$('ic-charge').innerHTML = icon('bolt', 20);
$('ic-target').innerHTML = icon('target', 20);
$('ic-volt').innerHTML = icon('gauge', 20);

loadChartHistory();
refreshStats();
connect();
setInterval(refreshStats, 15000);
