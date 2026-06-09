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

export default { enabled, getCached };
