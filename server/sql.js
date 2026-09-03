// SQL text shared with the tests. server/db.js cannot be imported from a test
// (it reads the gitignored config.json and opens SQLite at import time), so any
// query whose semantics are worth guarding lives here and is exercised against
// an in-memory database instead.

// Seeds prevAmps for a day's rollup. Must be the last CHARGING sample, not
// simply the last sample: charge_amps persists on non-charging rows, and the
// whole-range math only carries amps forward from charging samples. The car is
// usually idle at midnight, so the nearest sample would seed nothing and the
// day's first charging sample would stop counting as an adjustment.
export const LAST_CHARGING_SAMPLE_BEFORE =
  'SELECT * FROM samples WHERE ts < ? AND charging = 1 ORDER BY ts DESC LIMIT 1';
