// Shared period navigation for the stats blocks on /charger and /.
// Owns range + offset state, fetching, and the label; callers just render.
(function () {
  const PERIOD_RANGES = ['day', 'week', 'month'];
  // Matches the server's clamp — past it the response echoes a different offset
  // and the stale-response guard would drop every update.
  const MAX_OFFSET = 1000;

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
      const end = new Date(st.until - 86400_000);
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

    if (prevEl) prevEl.addEventListener('click', () => { if (offset < MAX_OFFSET) { offset++; refresh(); } });
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
