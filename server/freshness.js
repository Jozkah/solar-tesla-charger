// Pure staleness rules for a polled source — no module state, no imports.
//
// A source is STALE in one of two ways:
//   * unreachable — the last successful read is older than maxAgeMs (the
//     poller has been failing, or never succeeded).
//   * frozen — reads keep succeeding but the payload has not changed for
//     freezeMs while the meter shows real activity. A live meter's power
//     jitters and its Wh counter advances every read; a byte-identical
//     snapshot over minutes means something upstream is replaying a cached
//     answer. A quiet house (nothing drawing, counter idle) is NOT frozen —
//     that is why `active` gates the rule.
//
// controller.js owns the timestamps (okAt, failedSince, sigChangedAt) and
// feeds them in; this module only decides.

export function meterSignature(meters) {
  if (!meters || !meters.channels) return '';
  const parts = [];
  for (const key of Object.keys(meters.channels).sort()) {
    const c = meters.channels[key];
    parts.push(`${key}:${c.power ?? 'x'}:${c.totalWh ?? 'x'}:${c.totalReturnedWh ?? 'x'}`);
  }
  return parts.join('|');
}

export function isActive(meters, minW = 50) {
  if (!meters || !meters.channels) return false;
  for (const c of Object.values(meters.channels)) {
    if (c.power != null && Math.abs(c.power) >= minW) return true;
  }
  return false;
}

// { fresh, reason: null | 'unreachable' | 'frozen', sinceMs }
// sinceMs is when the source stopped being trustworthy (failedSince for
// unreachable, sigChangedAt + freezeMs for frozen) so the UI can say
// "since 12:03" rather than "for 37 minutes".
export function resolveFreshness({ okAt = 0, failedSince = 0, sigChangedAt = 0, active = false, nowMs, maxAgeMs, freezeMs }) {
  if (!okAt || nowMs - okAt > maxAgeMs) {
    return { fresh: false, reason: 'unreachable', sinceMs: failedSince || okAt || nowMs };
  }
  if (active && sigChangedAt && nowMs - sigChangedAt >= freezeMs) {
    return { fresh: false, reason: 'frozen', sinceMs: sigChangedAt + freezeMs };
  }
  return { fresh: true, reason: null, sinceMs: 0 };
}

export default { meterSignature, isActive, resolveFreshness };
