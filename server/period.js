// Pure period-boundary math (no DB / config coupling) so it is unit-testable.
// [since, until) bounds for a period, `offset` periods back from the current one
// (offset 0 = today / this week / this month / this billing cycle).
// `now` is injectable for deterministic tests; defaults to the real clock.

export function daysInMonth(year, monthIdx) {
  // Day 0 of the next month === last day of this month. Date normalizes overflow.
  return new Date(year, monthIdx + 1, 0).getDate();
}

export function clampDay(day, year, monthIdx) {
  return Math.min(day, daysInMonth(year, monthIdx));
}

// Local-midnight timestamp for the billing day of a given year/month, clamped.
function cycleStart(year, monthIdx, billingDay) {
  const day = clampDay(billingDay, year, monthIdx);
  return new Date(year, monthIdx, day, 0, 0, 0, 0).getTime();
}

export function periodBounds(range, offset = 0, billingDay = 1, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);

  if (range === 'day') {
    d.setDate(d.getDate() - offset);
    const since = d.getTime();
    d.setDate(d.getDate() + 1);
    return { since, until: d.getTime() };
  }
  if (range === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow - offset * 7);
    const since = d.getTime();
    d.setDate(d.getDate() + 7);
    return { since, until: d.getTime() };
  }
  if (range === 'month') {
    d.setDate(1);
    d.setMonth(d.getMonth() - offset);
    const since = d.getTime();
    d.setMonth(d.getMonth() + 1);
    return { since, until: d.getTime() };
  }
  if (range === 'billing') {
    const year = d.getFullYear();
    let monthIdx = d.getMonth();
    // Anchor month = current month if today is on/after this month's billing day,
    // else the previous month. Date ctor normalizes negative/overflow month.
    if (d.getDate() < clampDay(billingDay, year, monthIdx)) monthIdx -= 1;
    monthIdx -= offset;
    return {
      since: cycleStart(year, monthIdx, billingDay),
      until: cycleStart(year, monthIdx + 1, billingDay),
    };
  }
  return null;
}
