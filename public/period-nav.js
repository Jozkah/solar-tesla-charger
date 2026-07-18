// Shared period navigation for the stats blocks on /charger and /.
// Owns range + offset state, fetching, and the label; callers just render.
(function () {
  const PERIOD_RANGES = ['day', 'week', 'month', 'billing'];
  // Matches the server's per-range clamp (server/index.js RANGE_MAX_OFFSET) —
  // past it the response echoes a different offset than requested, and the
  // stale-response guard below would then silently drop every update.
  const RANGE_MAX_OFFSET = { day: 3650, week: 520, month: 120, billing: 120 };

  function periodLabel(st) {
    if (!PERIOD_RANGES.includes(st.range)) return '';
    const since = new Date(st.since);
    if (st.range === 'day') {
      if (st.offset === 0) return 'Today';
      if (st.offset === 1) return 'Yesterday';
      return since.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }
    if (st.range === 'week') {
      if (st.offset === 0) return 'This week';
      // Calendar day before `until`, not a fixed 24h subtraction — a 23-hour
      // spring-forward week would land at 23:00 the previous day and the
      // label would read one day short (e.g. "23 – 28 Mar" for a week ending
      // the 29th).
      const end = new Date(st.until);
      end.setDate(end.getDate() - 1);
      const s = since.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const e = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `${s} – ${e}`;
    }
    if (st.range === 'billing') {
      if (st.offset === 0) return 'This billing period';
      // Billing cycles are variable-length; label the actual [since, until)
      // span. `until` is exclusive, so the last included day is until - 1 day
      // (calendar step, DST-safe like the week label above).
      const end = new Date(st.until);
      end.setDate(end.getDate() - 1);
      const s = since.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const e = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `${s} – ${e}`;
    }
    if (st.offset === 0) return 'This month';
    return since.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // navEl/labelEl/prevEl/nextEl required; segEl optional (pages without a
  // range switcher just navigate within one range).
  window.createPeriodNav = function createPeriodNav({ navEl, labelEl, prevEl, nextEl, segEl, onData, initialRange = 'day' }) {
    let range = initialRange;
    let offset = 0;

    async function refresh() {
      let st;
      try {
        st = await (await fetch(`/api/stats?range=${range}&offset=${offset}`)).json();
      } catch { return; }
      // Stale response from a range/offset the user already navigated away from.
      if (st.range !== range || (PERIOD_RANGES.includes(range) && st.offset !== offset)) return;

      const isPeriod = PERIOD_RANGES.includes(range);
      if (navEl) navEl.hidden = !isPeriod;
      if (isPeriod && labelEl) labelEl.textContent = periodLabel(st);
      if (isPeriod && nextEl) {
        nextEl.disabled = offset === 0;
        nextEl.style.opacity = offset === 0 ? '.35' : '1';
      }
      onData(st);
    }

    if (prevEl) prevEl.addEventListener('click', () => { if (offset < (RANGE_MAX_OFFSET[range] ?? 0)) { offset++; refresh(); } });
    if (nextEl) nextEl.addEventListener('click', () => { if (offset > 0) { offset--; refresh(); } });
    if (segEl) {
      segEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        range = b.dataset.range;
        offset = 0;
        segEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        refresh();
      }));
    }
    return { refresh };
  };
})();
