// Paste/inject in the page: window.__overlap() returns layout problems on the current screen.
// Checks (1) visible text/control boxes that intersect each other, (2) elements whose content
// overflows their own box, (3) anything sticking out of the viewport.
window.__overlap = function () {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && !e.closest('[hidden],.boot,.screen:not(.on)'); };
  const name = (e) => e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.textContent ? ` "${e.textContent.trim().slice(0, 18)}"` : '');
  // leaf-ish things a person reads or taps
  const items = [...document.querySelectorAll('label, .big, .mid, .huge, .val, .pk, .rpmv, .chip, .call, .credit, .viewname, .clock, .brand, .logo, #hubText, .kv b, .kv u, .stat b, .stat u, .dim, .tabs button, .views button, .btn b, .shifthead h2, .shifthead span')].filter(vis);
  const issues = [];
  const W = innerWidth, H = innerHeight;
  for (const e of items) {
    const r = e.getBoundingClientRect();
    if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) issues.push(`offscreen ${name(e)}`);
    if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') issues.push(`clipped ${name(e)} (${e.scrollWidth}>${e.clientWidth})`);
    // text wider than its box even with overflow visible
    if (getComputedStyle(e).overflow === 'visible' && e.scrollWidth > e.clientWidth + 1 && e.clientWidth) issues.push(`spills ${name(e)} (${e.scrollWidth}>${e.clientWidth})`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.contains(b) || b.contains(a)) continue;
    const r = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    const ox = Math.min(r.right, q.right) - Math.max(r.left, q.left), oy = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
    if (ox > 1 && oy > 1) issues.push(`overlap ${name(a)} × ${name(b)}`);
  }
  return [...new Set(issues)];
};
