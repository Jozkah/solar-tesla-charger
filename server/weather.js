// Current weather for the car's location via Open-Meteo (free, no API key).
// Cloud cover + shortwave radiation are useful context for solar production.
// Cached and refreshed at most once per pollMin; getCached() never blocks.
import config from './config.js';

const W = config.weather || {};
let cache = null;
let lastFetch = 0;
let lastLoc = null;
let inflight = false;

// Minimal WMO weather-code → {icon, text} map.
const CODES = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Heavy drizzle'],
  61: ['🌧️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['🌨️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Showers'], 81: ['🌦️', 'Showers'], 82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm'], 99: ['⛈️', 'Thunderstorm'],
};

export function enabled() {
  return W.enabled !== false;
}

async function refresh(lat, lon) {
  if (inflight) return;
  inflight = true;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,cloud_cover,wind_speed_10m,shortwave_radiation`
      + `&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(W.timeoutMs || 8000) });
    const j = await r.json();
    const c = j.current || {};
    const [icon, text] = CODES[c.weather_code] || ['🌡️', 'Unknown'];
    cache = {
      ok: true,
      tempC: c.temperature_2m,
      apparentC: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      isDay: c.is_day === 1,
      code: c.weather_code,
      icon,
      text,
      cloudCover: c.cloud_cover, // %
      windKmh: c.wind_speed_10m,
      radiation: c.shortwave_radiation, // W/m²
      ts: Date.now(),
    };
    lastLoc = `${lat},${lon}`;
  } catch (e) {
    cache = { ...(cache || {}), ok: false, error: String(e.message || e), ts: Date.now() };
  } finally {
    inflight = false;
    lastFetch = Date.now();
  }
}

// Returns cached weather; refreshes in the background when stale or the car moved.
export function getCached(lat, lon) {
  if (!enabled()) return null;
  if (lat == null || lon == null) {
    if (W.lat != null && W.lon != null) { lat = W.lat; lon = W.lon; } else return cache;
  }
  const stale = Date.now() - lastFetch > (W.pollMin || 10) * 60_000;
  const moved = lastLoc !== `${lat},${lon}`;
  if (stale || moved) refresh(lat, lon);
  return cache;
}

// --- Forecast (hourly next ~24h + daily ~7d) --------------------------------
// Changes slowly, so cached far longer than current conditions (forecastMin, ~30m).
let fcCache = null;
let fcLastFetch = 0;
let fcLastLoc = null;
let fcInflight = false;

async function refreshForecast(lat, lon) {
  if (fcInflight) return;
  fcInflight = true;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&hourly=temperature_2m,precipitation_probability,weather_code,cloud_cover`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset`
      + `&forecast_days=14&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(W.timeoutMs || 8000) });
    const j = await r.json();

    // Align "now" to the location's local hour using the API's UTC offset.
    const offset = j.utc_offset_seconds || 0;
    const nowHour = new Date(Date.now() + offset * 1000).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const h = j.hourly || {};
    const times = h.time || [];
    let start = times.findIndex((t) => String(t).slice(0, 13) >= nowHour);
    if (start < 0) start = 0;
    const hourly = [];
    for (let i = start; i < times.length && hourly.length < 24; i++) {
      const code = h.weather_code?.[i];
      const [icon, text] = CODES[code] || ['🌡️', ''];
      hourly.push({
        time: times[i],
        tempC: h.temperature_2m?.[i],
        precip: h.precipitation_probability?.[i],
        cloudCover: h.cloud_cover?.[i],
        code, icon, text,
      });
    }

    const d = j.daily || {};
    const dTimes = d.time || [];
    const daily = dTimes.map((t, i) => {
      const code = d.weather_code?.[i];
      const [icon, text] = CODES[code] || ['🌡️', ''];
      return {
        date: t,
        tMax: d.temperature_2m_max?.[i],
        tMin: d.temperature_2m_min?.[i],
        precip: d.precipitation_probability_max?.[i],
        sunrise: d.sunrise?.[i],
        sunset: d.sunset?.[i],
        code, icon, text,
      };
    });

    fcCache = { ok: true, hourly, daily, ts: Date.now() };
    fcLastLoc = `${lat},${lon}`;
  } catch (e) {
    fcCache = { ...(fcCache || {}), ok: false, error: String(e.message || e), ts: Date.now() };
  } finally {
    fcInflight = false;
    fcLastFetch = Date.now();
  }
}

export function getForecast(lat, lon) {
  if (!enabled()) return null;
  if (lat == null || lon == null) {
    if (W.lat != null && W.lon != null) { lat = W.lat; lon = W.lon; } else return fcCache;
  }
  const stale = Date.now() - fcLastFetch > (W.forecastMin || 30) * 60_000;
  const moved = fcLastLoc !== `${lat},${lon}`;
  if (stale || moved) refreshForecast(lat, lon);
  return fcCache;
}

export default { enabled, getCached, getForecast };
