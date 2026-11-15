// Canvas drawing for the tabs: G-meter, motion traces, shift trace, sparklines, dyno graph.
// Everything renders at 2x or more (supersampled) so lines stay smooth on any screen.

export function fitHi(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(3, Math.max(2, devicePixelRatio || 1));
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
  return { c: cv.getContext('2d'), w, h, d };
}
const FAINT = '#6e6e7a', GRID = 'rgba(255,255,255,0.07)';

/** Smooth path through points (quadratic curves through midpoints). */
function smooth(c, pts) {
  c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  const e = pts[pts.length - 1]; c.lineTo(e[0], e[1]);
}
/** Glowing line: wide faint, medium, crisp core. */
function glowStroke(c, d, color) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.globalAlpha = 0.1; c.strokeStyle = color; c.lineWidth = 8 * d; c.stroke();
  c.globalAlpha = 0.25; c.lineWidth = 3.5 * d; c.stroke();
  c.globalAlpha = 1; c.lineWidth = 1.5 * d; c.stroke();
}

/** Friction-circle G-meter with a fading trail. */
export function drawGMeter(cv, imu, trail, peak, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 16 * d, max = 1.2;
  c.strokeStyle = GRID; c.lineWidth = 1;
  for (const g of [0.3, 0.6, 0.9, 1.2]) { c.beginPath(); c.arc(cx, cy, R * g / max, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
  c.fillStyle = FAINT; c.font = `${9 * d}px ShareMono, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const g of [0.6, 1.2]) c.fillText(g.toFixed(1), cx + R * g / max * 0.71 + 10 * d, cy - R * g / max * 0.71);
  c.fillText('ACCEL', cx, cy - R - 8 * d); c.fillText('BRAKE', cx, cy + R + 8 * d);
  if (peak > 0.05) { c.setLineDash([3 * d, 4 * d]); c.strokeStyle = 'rgba(255,255,255,0.25)'; c.beginPath(); c.arc(cx, cy, R * Math.min(peak, max) / max, 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
  const P = (p) => [cx + R * Math.max(-max, Math.min(max, p.lat)) / max, cy - R * Math.max(-max, Math.min(max, p.lon)) / max];
  const now = performance.now();
  for (const p of trail) {
    const age = (now - p.t) / 3000; if (age > 1) continue;
    const [x, y] = P(p); c.globalAlpha = (1 - age) * 0.5; c.fillStyle = accent; c.beginPath(); c.arc(x, y, 2 * d, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  if (imu) {
    const [x, y] = P(imu);
    const rg = c.createRadialGradient(x, y, 0, x, y, 16 * d); rg.addColorStop(0, accent); rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg; c.beginPath(); c.arc(x, y, 16 * d, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 4 * d, 0, Math.PI * 2); c.fill();
  }
  c.textAlign = 'left';
}

/** Lateral, longitudinal and yaw traces over the last 10 s, plus a bubble level. */
export function drawImuTrace(cv, trace, level, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const bub = Math.min(h - 20 * d, 110 * d), pw = w - bub - 30 * d, now = performance.now();
  const rows = [['LAT G', 'lat', 1.2, accent], ['LONG G', 'lon', 1.2, '#e8e8ee'], ['YAW °/S', 'yaw', 60, '#46c8ff']];
  const rh = (h - 8 * d) / rows.length;
  c.font = `${9 * d}px ShareMono, monospace`; c.textBaseline = 'top';
  rows.forEach(([name, k, range, color], i) => {
    const y0 = 4 * d + i * rh, mid = y0 + rh / 2;
    c.strokeStyle = GRID; c.lineWidth = 1; c.beginPath(); c.moveTo(0, Math.round(mid) + 0.5); c.lineTo(pw, Math.round(mid) + 0.5); c.stroke();
    c.fillStyle = FAINT; c.fillText(name, 4 * d, y0 + 2 * d);
    const pts = trace.filter((p) => now - p.t < 10000).map((p) => [pw - pw * (now - p.t) / 10000, mid - Math.max(-1, Math.min(1, p[k] / range)) * (rh / 2 - 6 * d)]);
    if (pts.length > 2) { smooth(c, pts); glowStroke(c, d, color); }
  });
  // bubble level
  const bx = w - bub / 2 - 10 * d, by = h / 2, br = bub / 2;
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1.2 * d; c.beginPath(); c.arc(bx, by, br, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(bx, by, br * 0.33, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(bx - br, by); c.lineTo(bx + br, by); c.moveTo(bx, by - br); c.lineTo(bx, by + br); c.strokeStyle = GRID; c.stroke();
  if (level) {
    const k = br / 15, x = bx + Math.max(-br, Math.min(br, level.roll * k)), y = by - Math.max(-br, Math.min(br, level.pitch * k));
    const ok = Math.hypot(level.roll, level.pitch) < 1.5;
    c.fillStyle = ok ? 'rgba(80,230,150,0.85)' : 'rgba(255,200,60,0.85)'; c.beginPath(); c.arc(x, y, 9 * d, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = FAINT; c.textAlign = 'center'; c.fillText('LEVEL', bx, by + br + 3 * d > h - 10 * d ? h - 12 * d : by + br + 3 * d); c.textAlign = 'left';
}

/** RPM over the last 8 s with gear-change markers. */
export function drawShift(cv, trace, now, accent, top = 7500) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const px = { l: 34 * d, r: 14 * d, t: 16 * d, b: 18 * d }, pw = w - px.l - px.r, ph = h - px.t - px.b;
  const Y = (v) => px.t + ph * (1 - Math.min(v, top) / top), snap = (v) => Math.round(v) + 0.5;
  c.font = `${9 * d}px ShareMono, monospace`; c.fillStyle = FAINT; c.textBaseline = 'middle';
  c.lineWidth = 1; c.strokeStyle = GRID; c.beginPath();
  for (let k = 1; k <= 7; k++) { const y = snap(Y(k * 1000)); c.moveTo(px.l, y); c.lineTo(w - px.r, y); }
  c.stroke();
  for (let k = 1; k <= 7; k++) c.fillText(k + 'K', 6 * d, Y(k * 1000));
  const sy = Y(6800);
  c.strokeStyle = accent; c.globalAlpha = 0.25; c.lineWidth = 5 * d; c.beginPath(); c.moveTo(px.l, sy); c.lineTo(w - px.r, sy); c.stroke();
  c.globalAlpha = 1; c.lineWidth = 1.25 * d; c.stroke();
  const X = (t) => w - px.r - pw * (now - t) / 8000, pts = [];
  for (const p of trace) {
    const x = X(p.t); if (x < px.l - 4 * d) continue;
    const last = pts[pts.length - 1];
    if (!last || x - last[0] >= 1.5 * d) pts.push([x, Y(p.rpm), p.gear]);
  }
  if (pts.length < 2) return;
  c.save(); c.beginPath(); c.rect(px.l, px.t - 4 * d, pw, ph + 4 * d); c.clip();
  smooth(c, pts); c.lineTo(pts[pts.length - 1][0], px.t + ph); c.lineTo(pts[0][0], px.t + ph); c.closePath();
  const g = c.createLinearGradient(0, px.t, 0, px.t + ph); g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fill();
  let prev = null;
  for (const p of pts) {
    if (p[2] !== 'N' && prev && p[2] !== prev) {
      const x = snap(p[0]), lg = c.createLinearGradient(0, px.t, 0, px.t + ph); lg.addColorStop(0, accent); lg.addColorStop(1, 'rgba(0,0,0,0)');
      c.strokeStyle = lg; c.lineWidth = 1; c.beginPath(); c.moveTo(x, px.t); c.lineTo(x, px.t + ph); c.stroke();
      c.fillStyle = accent; c.font = `${10 * d}px Michroma, sans-serif`; c.fillText(p[2], x + 4 * d, px.t + 6 * d);
    }
    if (p[2] !== 'N') prev = p[2];
  }
  smooth(c, pts); glowStroke(c, d, '#f4f4f6');
  c.restore();
  const e = pts[pts.length - 1], rg = c.createRadialGradient(e[0], e[1], 0, e[0], e[1], 10 * d);
  rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = rg; c.beginPath(); c.arc(e[0], e[1], 10 * d, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(e[0], e[1], 2.6 * d, 0, Math.PI * 2); c.fill();
}

/** Small blip trace for the last rev-match (rpm during the clutch-in) against the target line. */
export function drawBlip(cv, rm, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  if (!rm || rm.blip.length < 2) return;
  const t0 = rm.blip[0][0], t1 = rm.blip[rm.blip.length - 1][0], span = Math.max(100, t1 - t0);
  const vals = rm.blip.map((b) => b[1]).concat(rm.target), lo = Math.min(...vals) - 300, hi = Math.max(...vals) + 300;
  const Y = (v) => h - 3 * d - (v - lo) / (hi - lo) * (h - 6 * d);
  c.setLineDash([3 * d, 3 * d]); c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, Y(rm.target)); c.lineTo(w, Y(rm.target)); c.stroke(); c.setLineDash([]);
  const pts = rm.blip.map(([t, v]) => [(t - t0) / span * (w - 4 * d) + 2 * d, Y(v)]);
  smooth(c, pts); glowStroke(c, d, accent);
}

/** Sparkline card graph for one signal over the last 30 s. */
export function drawSpark(cv, series, lo, hi, color) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const now = performance.now(), pts = [];
  for (const [t, v] of series) { if (v == null) continue; const x = w - w * (now - t) / 30000; if (x < -4) continue; pts.push([x, h - 3 * d - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (h - 6 * d)]); }
  c.strokeStyle = GRID; c.lineWidth = 1; c.beginPath(); c.moveTo(0, Math.round(h / 2) + 0.5); c.lineTo(w, Math.round(h / 2) + 0.5); c.stroke();
  if (pts.length < 2) return;
  smooth(c, pts); c.lineTo(pts[pts.length - 1][0], h); c.lineTo(pts[0][0], h); c.closePath();
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ',0.18)')); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fill();
  smooth(c, pts); glowStroke(c, d, color);
}

/** Dyno chart: power (solid) and torque (dashed) against RPM for up to three runs. */
export function drawDyno(cv, runs, live, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const px = { l: 36 * d, r: 36 * d, t: 14 * d, b: 22 * d }, pw = w - px.l - px.r, ph = h - px.t - px.b;
  const all = runs.flatMap((r) => r.pts).concat(live || []);
  const maxV = Math.max(200, ...all.map((p) => Math.max(p.hp, p.tq))) * 1.1;
  const X = (rpm) => px.l + (rpm - 1000) / 6500 * pw, Y = (v) => px.t + ph * (1 - v / maxV);
  c.font = `${9 * d}px ShareMono, monospace`; c.fillStyle = FAINT; c.textBaseline = 'middle'; c.strokeStyle = GRID; c.lineWidth = 1;
  c.beginPath();
  for (let r = 2000; r <= 7000; r += 1000) { const x = Math.round(X(r)) + 0.5; c.moveTo(x, px.t); c.lineTo(x, px.t + ph); }
  const step = maxV > 500 ? 100 : 50;
  for (let v = step; v < maxV; v += step) { const y = Math.round(Y(v)) + 0.5; c.moveTo(px.l, y); c.lineTo(w - px.r, y); }
  c.stroke();
  c.textAlign = 'center'; for (let r = 2000; r <= 7000; r += 1000) c.fillText(r / 1000 + 'K', X(r), h - 9 * d);
  c.textAlign = 'right'; for (let v = step; v < maxV; v += step * 2) c.fillText(v, px.l - 5 * d, Y(v));
  c.textAlign = 'left'; c.fillText('HP', 4 * d, px.t); c.fillText('LB-FT', w - px.r + 4 * d, px.t);
  const colors = [accent, '#e8e8ee', '#46c8ff'];
  const line = (pts, key, color, dash, alpha) => {
    if (pts.length < 2) return;
    c.save(); c.globalAlpha = alpha; c.setLineDash(dash ? [6 * d, 5 * d] : []);
    smooth(c, pts.map((p) => [X(p.rpm), Y(p[key])])); c.strokeStyle = color; c.lineWidth = 2 * d; c.lineCap = 'round'; c.stroke(); c.restore();
  };
  runs.slice().reverse().forEach((r, i, arr) => { const idx = arr.length - 1 - i, a = idx === 0 ? 1 : 0.45; line(r.pts, 'hp', colors[idx], false, a); line(r.pts, 'tq', colors[idx], true, a); });
  if (live && live.length > 1) { line(live, 'hp', accent, false, 0.8); line(live, 'tq', accent, true, 0.8); }
  if (!all.length) { c.textAlign = 'center'; c.fillText('NO PULLS YET', px.l + pw / 2, px.t + ph / 2); c.textAlign = 'left'; }
}

/** Top-down car with four wheel-speed bars and the steering angle on the front wheels. */
export function drawWheels(cv, ws, steer, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, L = Math.min(h * 0.62, w * 0.7), W = L * 0.48;
  // body outline
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1.2 * d;
  c.beginPath(); c.roundRect(cx - W / 2, cy - L / 2, W, L, W * 0.28); c.stroke();
  c.beginPath(); c.moveTo(cx - W / 2 + 6 * d, cy - L * 0.12); c.lineTo(cx + W / 2 - 6 * d, cy - L * 0.12); c.moveTo(cx - W / 2 + 6 * d, cy + L * 0.16); c.lineTo(cx + W / 2 - 6 * d, cy + L * 0.16); c.stroke();
  const top = Math.max(30, ...Object.values(ws).map((v) => v || 0)) * 1.1;
  const wheels = [['FL', -1, -1, ws.fl], ['FR', 1, -1, ws.fr], ['RL', -1, 1, ws.rl], ['RR', 1, 1, ws.rr]];
  c.font = `${10 * d}px ShareMono, monospace`; c.textBaseline = 'middle';
  for (const [name, sx, sy, v] of wheels) {
    const x = cx + sx * (W / 2 + 4 * d), y = cy + sy * L * 0.33, tw = 9 * d, th = L * 0.2;
    c.save(); c.translate(x, y); if (sy < 0) c.rotate((steer || 0) / 15 * Math.PI / 180);   // ~15:1 steering ratio
    c.fillStyle = '#16161b'; c.strokeStyle = 'rgba(255,255,255,0.3)'; c.beginPath(); c.roundRect(-tw / 2, -th / 2, tw, th, 2 * d); c.fill(); c.stroke();
    if (v != null) { const f = Math.min(1, v / top); c.fillStyle = accent; c.globalAlpha = 0.85; c.fillRect(-tw / 2 + 1.5 * d, th / 2 - th * f, tw - 3 * d, th * f); c.globalAlpha = 1; }
    c.restore();
    c.fillStyle = '#e8e8ee'; c.textAlign = sx < 0 ? 'right' : 'left';
    const tx = x + sx * 14 * d;
    c.fillText(v == null ? '--' : v.toFixed(1), tx, y - 6 * d);
    c.fillStyle = '#6e6e7a'; c.fillText(name, tx, y + 8 * d);
  }
  c.textAlign = 'left';
}

/** Flywheel (outer ring, engine speed) and clutch disc (inner, gearbox speed). Turning apart = slip. */
export function drawDisc(cv, engAngle, inAngle, slip, pedalIn, accent) {
  const { c, w, h, d } = fitHi(cv); if (!w) return;
  c.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 12 * d;
  const ring = (r, ang, n, col, len) => {
    c.save(); c.translate(cx, cy); c.rotate(ang); c.strokeStyle = col; c.lineWidth = 2 * d;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * r, Math.sin(a) * r); c.lineTo(Math.cos(a) * (r - len), Math.sin(a) * (r - len)); c.stroke(); }
    c.restore();
  };
  // flywheel teeth
  c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1 * d; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  ring(R, engAngle, 72, 'rgba(232,232,238,0.55)', 7 * d);
  // friction ring: glows hotter with slip
  const heat = Math.min(1, Math.abs(slip || 0) / 25);
  c.strokeStyle = accent; c.globalAlpha = 0.25 + heat * 0.6; c.lineWidth = 10 * d;
  c.beginPath(); c.arc(cx, cy, R * 0.74, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
  // clutch disc: springs and segments, turning at gearbox speed
  ring(R * 0.62, inAngle, 6, accent, R * 0.22);
  c.save(); c.translate(cx, cy); c.rotate(inAngle);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.5; c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.5 * d; c.strokeRect(Math.cos(a) * R * 0.3 - 6 * d, Math.sin(a) * R * 0.3 - 4 * d, 12 * d, 8 * d); }
  c.restore();
  c.fillStyle = '#0d0d10'; c.beginPath(); c.arc(cx, cy, R * 0.16, 0, Math.PI * 2); c.fill();
  c.strokeStyle = accent; c.lineWidth = 1.5 * d; c.stroke();
  c.fillStyle = pedalIn ? accent : '#e8e8ee'; c.font = `${11 * d}px Michroma, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(pedalIn ? 'IN' : 'OUT', cx, cy); c.textAlign = 'left';
}
