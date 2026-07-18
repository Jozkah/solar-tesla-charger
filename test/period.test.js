import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodBounds, daysInMonth, clampDay } from '../server/period.js';

// A fixed "now": 2026-06-20 12:00 local.
const NOW = new Date(2026, 5, 20, 12, 0, 0, 0).getTime();
const atMidnight = (y, m, d) => new Date(y, m, d, 0, 0, 0, 0).getTime();

test('daysInMonth handles February leap and non-leap', () => {
  assert.equal(daysInMonth(2024, 1), 29);
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2026, 3), 30); // April
});

test('clampDay caps to month length', () => {
  assert.equal(clampDay(31, 2026, 1), 28); // Feb 2026
  assert.equal(clampDay(15, 2026, 1), 15);
});

test('billing offset 0: today past billing day -> starts this month', () => {
  const b = periodBounds('billing', 0, 15, NOW);
  assert.equal(b.since, atMidnight(2026, 5, 15));
  assert.equal(b.until, atMidnight(2026, 6, 15));
});

test('billing offset 0: today before billing day -> starts previous month', () => {
  const b = periodBounds('billing', 0, 25, NOW);
  assert.equal(b.since, atMidnight(2026, 4, 25));
  assert.equal(b.until, atMidnight(2026, 5, 25));
});

test('billing offset 1 is the immediately-prior contiguous cycle', () => {
  const cur = periodBounds('billing', 0, 15, NOW);
  const prev = periodBounds('billing', 1, 15, NOW);
  assert.equal(prev.until, cur.since);
  assert.equal(prev.since, atMidnight(2026, 4, 15));
});

test('billing day 31 clamps in short months', () => {
  const now = new Date(2026, 2, 5, 12).getTime();
  const b = periodBounds('billing', 0, 31, now);
  assert.equal(b.since, atMidnight(2026, 1, 28)); // Feb 28 (clamped)
  assert.equal(b.until, atMidnight(2026, 2, 31)); // Mar 31
});

test('billing day 1 equals the calendar month', () => {
  const billing = periodBounds('billing', 0, 1, NOW);
  const month = periodBounds('month', 0, 1, NOW);
  assert.equal(billing.since, month.since);
  assert.equal(billing.until, month.until);
});

test('day/week/month unaffected by billingDay and honor injected now', () => {
  const day = periodBounds('day', 0, 15, NOW);
  assert.equal(day.since, atMidnight(2026, 5, 20));
  assert.equal(day.until, atMidnight(2026, 5, 21));
  const month = periodBounds('month', 0, 15, NOW);
  assert.equal(month.since, atMidnight(2026, 5, 1));
  assert.equal(month.until, atMidnight(2026, 6, 1));
});

test('unknown range returns null', () => {
  assert.equal(periodBounds('all', 0, 15, NOW), null);
});
