// Shared downloader for the Shelly EM energy logs: every configured channel,
// devices in parallel, the channels of one device one after the other (a Gen1
// EM serves a single transfer at a time). Used by backfill.js (live gaps) and
// repair.js (old runs).
//
// A Gen1 EM keeps its "file transfer in progress" flag set until it reboots.
// Once a download is aborted (a client that gives up, or a connect that times
// out mid-attempt) the meter is stuck and every later request answers busy —
// it never self-clears. So when a download fails busy or on a connect timeout,
// we GET /reboot, wait for it to come back, and retry. Rebooting is safe: we
// are the only client of these logs, so no legitimate transfer is in flight,
// and the ~10 s of missed live readings is covered by the stale gate.
import { parseEmData, fetchEmData, DEFAULT_INTERVAL_MS } from './backfill-pure.js';

const TRIES = 6;
const RETRY_WAIT_MS = 60_000; // wait after a non-stuck error before retrying
const REBOOT_WAIT_MS = 25_000; // time for a Gen1 EM to reboot and rejoin WiFi
export const BUSY_HINT = 'the meter was stuck in a previous download';

// A stuck meter shows one of these; both are cleared only by a reboot.
function isStuck(msg) {
  return /busy/i.test(msg) || /connect timeout|UND_ERR_CONNECT|ETIMEDOUT|ECONNREFUSED/i.test(msg);
}

async function rebootDevice(ip, fetchImpl = fetch) {
  try {
    await fetchImpl(`http://${ip}/reboot`, { signal: AbortSignal.timeout(5000) });
  } catch { /* the reboot drops the connection; that is expected */ }
}

export async function downloadChannels(devices, from, to, {
  log = () => {}, tries = TRIES, waitMs = RETRY_WAIT_MS, rebootWaitMs = REBOOT_WAIT_MS,
  fetchOne = fetchEmData, reboot = rebootDevice,
} = {}) {
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
          const msg = e.cause?.message || e.message || String(e);
          log(`[backfill] ${dev.ip} /emeter/${idx}: ${msg}`);
          if (attempt >= tries) break;
          if (isStuck(msg)) {
            log(`[backfill] rebooting ${dev.ip} to clear a stuck transfer`);
            await reboot(dev.ip);
            await sleep(rebootWaitMs);
          } else {
            await sleep(waitMs);
          }
        }
      }
      if (lastErr) {
        const msg = lastErr.cause?.message || lastErr.message || String(lastErr);
        throw new Error(`${dev.ip} /emeter/${idx}: ${msg}${isStuck(msg) ? ` (${BUSY_HINT}; a reboot did not clear it in ${tries} tries)` : ''}`);
      }
    }
  }));
  return channels;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export default { downloadChannels };
