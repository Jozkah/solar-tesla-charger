// Pure detector for "flat runs" already sitting in the samples table: stretches
// where every meter column is byte-identical from row to row for a long time
// while showing real power. A live Shelly EM reading jitters at 0.1 W and its
// counters move every poll, so a genuinely identical grid + floor1 + floor2 +
// solar tuple for ten minutes straight can only be a replayed reading — the
// 2026-09-03 outage recorded six hours of them. Rows written by the backfill
// itself are skipped: they are 10-minute averages and may legitimately repeat.
const KEYS = ['grid_power', 'floor1_w', 'floor2_w', 'solar2_w'];

function sig(row) {
  return KEYS.map((k) => (row[k] == null ? 'x' : Number(row[k]).toFixed(1))).join('|');
}
function active(row, minW) {
  return KEYS.some((k) => row[k] != null && Math.abs(Number(row[k])) >= minW);
}

// rows: samples ordered by ts ASC. Returns [{ from, to, rows }] where `from`
// is the ts of the FIRST repeated row (the first row of the run is the last
// real reading and is kept) and `to` is the ts just after the last flat row.
export function findFlatRuns(rows, { minMs = 10 * 60_000, minW = 50 } = {}) {
  const runs = [];
  let start = -1; // index of the anchor row the run repeats
  const flush = (endIdx) => {
    if (start < 0) return;
    const anchor = rows[start], last = rows[endIdx];
    const count = endIdx - start; // repeated rows, anchor excluded
    if (count >= 1 && last.ts - anchor.ts >= minMs && active(anchor, minW)) {
      runs.push({ from: rows[start + 1].ts, to: last.ts + 1, rows: count });
    }
    start = -1;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.mode === 'backfill' || r.action === 'backfill') { flush(i - 1); continue; }
    if (start >= 0 && sig(r) === sig(rows[start])) continue;
    flush(i - 1);
    start = i;
  }
  flush(rows.length - 1);
  return runs;
}

export default { findFlatRuns };
