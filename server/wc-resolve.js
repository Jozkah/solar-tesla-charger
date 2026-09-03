// Resolves the WC reading the decision loop should use, tolerating transient
// failures. A single failed/slow poll must not flip the whole charging
// decision onto laggy car telemetry, so we carry the last SUCCESSFUL reading
// for a short grace window. Only after the WC has been failing for longer than
// graceMs do we surface the failure (wcOk goes false, fallback engages).
//   read       - the fresh readVitals() result ({...} on success, {error} on failure)
//   lastGood   - the last successful reading, or null
//   lastGoodAt - ms timestamp of lastGood, or 0
//   nowMs, graceMs
// Returns { wc, good } where wc is what to store in state.wc and good is
// whether this tick had a fresh success (caller updates lastGood on good).
export function resolveWcReading({ read, lastGood, lastGoodAt, nowMs, graceMs }) {
  if (read && !read.error) return { wc: read, good: true };
  // failed this tick — carry lastGood if still within grace
  if (lastGood && nowMs - lastGoodAt < graceMs) return { wc: { ...lastGood, carried: true }, good: false };
  return { wc: read, good: false }; // truly down past grace — surface the failure
}
