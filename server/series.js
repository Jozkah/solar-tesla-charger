// Pure helper for /api/series: mark holes in the sample history so the chart
// breaks the line instead of drawing a straight bridge across an outage.
// Live samples arrive every ~10 s and backfill rows every 10 min, so the
// threshold sits above the backfill cadence.
export const SERIES_GAP_MS = 15 * 60_000;

export function withGaps(points, gapMs = SERIES_GAP_MS) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0 && p.ts - points[i - 1].ts > gapMs) out.push({ ts: points[i - 1].ts + 1, gap: true });
    out.push(p);
  }
  return out;
}

export default { withGaps, SERIES_GAP_MS };
