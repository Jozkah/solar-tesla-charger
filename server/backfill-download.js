// Shared downloader for the Shelly EM energy logs: every configured channel,
// devices in parallel, the channels of one device one after the other (a Gen1
// EM serves a single transfer at a time). Each channel gets a few attempts
// spaced out, because the usual failure modes are transient: the device is
// still finishing a previous transfer, or its small TCP table is full and the
// connect times out. Used by backfill.js (live gaps) and repair.js (old runs).
import { parseEmData, fetchEmData, DEFAULT_INTERVAL_MS } from './backfill-pure.js';

const TRIES = 3;
const RETRY_WAIT_MS = 60_000;

export async function downloadChannels(devices, from, to, { log = () => {}, tries = TRIES, waitMs = RETRY_WAIT_MS, fetchOne = fetchEmData } = {}) {
  const channels = {};
  await Promise.all(devices.map(async (dev) => {
    for (const [idx, meta] of Object.entries(dev.channels)) {
      let lastErr = null;
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          log(`[backfill] downloading ${dev.ip} /emeter/${idx}/em_data.csv (try ${attempt}/${tries})`);
          const csv = await fetchOne(dev.ip, Number(idx));
          channels[meta.key] = parseEmData(csv).filter((r) => r.ts >= from - DEFAULT_INTERVAL_MS && r.ts < to + DEFAULT_INTERVAL_MS);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          log(`[backfill] ${dev.ip} /emeter/${idx}: ${e.cause?.message || e.message || e}`);
          if (attempt < tries) await sleep(waitMs);
        }
      }
      if (lastErr) throw new Error(`${dev.ip} /emeter/${idx}: ${lastErr.cause?.message || lastErr.message || lastErr}`);
    }
  }));
  return channels;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export default { downloadChannels };
