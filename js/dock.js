// Mac-dock style tab bar. Touch the bar and slide: the tabs under your finger swell, a label floats
// above the one you're on, the bar scrolls by itself near the edges, and letting go opens that page.
// A plain tap still works like a normal button.
export function dockify(nav, onSelect, { haptic } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const label = document.createElement('div');
  label.className = 'docklabel'; document.body.append(label);
  let active = false, moved = false, startX = 0, x = 0, aim = null, pid = null, raf = 0, lastAim = null, suppressClick = false;

  const buttons = () => [...nav.querySelectorAll('button')].filter((b) => !b.hidden);
  function layout() {
    const list = buttons(), reach = 120;
    let best = null, bestD = Infinity;
    for (const b of list) {
      const r = b.getBoundingClientRect(), c = r.left + r.width / 2, d = Math.abs(x - c);
      if (d < bestD) { bestD = d; best = b; }
      const f = reduce.matches ? 0 : Math.max(0, 1 - d / reach);
      const s = 1 + 0.32 * f * f;                       // smooth bell, like the Dock's magnification
      b.style.transform = `translateY(${(-9 * f * f).toFixed(1)}px) scale(${s.toFixed(3)})`;
      b.style.zIndex = String(Math.round(f * 10));
    }
    aim = best;
    list.forEach((b) => b.classList.toggle('aim', b === aim));
    if (aim) {
      const r = aim.getBoundingClientRect();
      label.textContent = aim.textContent;
      label.style.transform = `translate(${Math.round(r.left + r.width / 2)}px, ${Math.round(r.top - 14)}px) translate(-50%, -100%)`;
      label.classList.add('on');
      if (aim !== lastAim) { lastAim = aim; haptic?.(); }
    }
  }
  function edgeScroll() {
    if (!active) return;
    const r = nav.getBoundingClientRect(), edge = 44;
    const v = x < r.left + edge ? -(r.left + edge - x) / 3 : x > r.right - edge ? (x - (r.right - edge)) / 3 : 0;
    if (v) { nav.scrollLeft += v; layout(); }
    raf = requestAnimationFrame(edgeScroll);
  }
  function reset() {
    active = false; cancelAnimationFrame(raf);
    for (const b of buttons()) { b.style.transform = ''; b.style.zIndex = ''; b.classList.remove('aim'); }
    label.classList.remove('on'); lastAim = null;
  }
  nav.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    active = true; moved = false; startX = x = e.clientX; pid = e.pointerId;
    nav.classList.add('docking');
  });
  nav.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pid) return;
    x = e.clientX;
    if (!moved && Math.abs(x - startX) > 8) {
      moved = true;
      try { nav.setPointerCapture(pid); } catch { /* already released */ }
      raf = requestAnimationFrame(edgeScroll);
    }
    if (moved) { e.preventDefault(); layout(); }
  });
  const end = (e, cancel) => {
    if (!active || e.pointerId !== pid) return;
    nav.classList.remove('docking');
    const target = moved && !cancel ? aim : null;
    reset();
    if (target) { suppressClick = true; setTimeout(() => (suppressClick = false), 50); onSelect(target.dataset.t); }
  };
  nav.addEventListener('pointerup', (e) => end(e, false));
  nav.addEventListener('pointercancel', (e) => end(e, true));
  nav.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
}
