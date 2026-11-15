// Drives are recorded automatically: a drive starts when the car moves and ends after two minutes
// parked. One point a second (position, speed, revs, boost, gear, G) is kept on the phone, and the
// DRIVES tab draws the route coloured by speed and replays it. No map tiles: nothing leaves the phone.

const KEY = 'carbox-drives', MAX_DRIVES = 20, MAX_POINTS = 3600;

export class Drives {
  constructor() {
    this.list = this._load();       // newest first: { id, start, end, miles, top, pts: [[t, lat, lon, mph, rpm, boost, gear, g]] }
    this.cur = null; this._last = 0; this._parkedSince = 0;
  }
  _load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.list)); }
    catch { if (this.list.length > 1) { this.list.pop(); this._save(); } }   // storage full: drop the oldest
  }

  /** Call every frame. v = { mph, rpm, boost, gear, lat, lon, g }. */
  update(v, now = Date.now()) {
    if (now - this._last < 1000) return;
    this._last = now;
    const moving = v.mph != null && v.mph > 3;
    if (!this.cur) {
      if (!moving) return;
      this.cur = { id: now, start: now, end: now, miles: 0, top: 0, pts: [] };
      this.list.unshift(this.cur); if (this.list.length > MAX_DRIVES) this.list.pop();
    }
    const c = this.cur, r1 = (x, d = 1) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
    const prev = c.pts[c.pts.length - 1];
    if (prev && v.mph != null) c.miles += v.mph / 3600 * ((now - prev[0]) / 1000);
    c.pts.push([now, v.lat == null ? null : r1(v.lat, 6), v.lon == null ? null : r1(v.lon, 6), r1(v.mph), v.rpm == null ? null : Math.round(v.rpm), r1(v.boost), v.gear, r1(v.g, 2)]);
    if (c.pts.length > MAX_POINTS) c.pts = c.pts.filter((_, i) => i % 2 === 0);   // long drive: halve the detail
    c.end = now; c.top = Math.max(c.top, v.mph || 0);
    if (moving) this._parkedSince = 0; else if (!this._parkedSince) this._parkedSince = now;
    if (this._parkedSince && now - this._parkedSince > 120000) this.finish();
    else if (c.pts.length % 15 === 0) this._save();
  }
  finish() {
    if (!this.cur) return;
    if (this.cur.pts.length < 20) this.list = this.list.filter((d) => d !== this.cur);   // too short to keep
    this.cur = null; this._parkedSince = 0; this._save();
  }
  remove(id) { this.list = this.list.filter((d) => d.id !== id); if (this.cur?.id === id) this.cur = null; this._save(); }
}

/** Speed colour: blue (slow) -> green -> amber -> red (fast). */
export function speedColor(mph, top = 120) {
  const f = Math.max(0, Math.min(1, (mph || 0) / top));
  const stops = [[70, 170, 255], [80, 230, 150], [255, 200, 60], [255, 40, 62]];
  const x = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), k = x - i;
  const c = stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Draws a drive's route (or, without GPS, its speed trace) and the replay position. */
export function drawRoute(cv, drive, at, accent) {
  const r = cv.getBoundingClientRect(), d = Math.min(3, Math.max(2, devicePixelRatio || 1));
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const c = cv.getContext('2d'); c.clearRect(0, 0, w, h);
  c.font = `${10 * d}px ShareMono, monospace`; c.fillStyle = '#6e6e7a'; c.textBaseline = 'middle';
  if (!drive || drive.pts.length < 2) { c.textAlign = 'center'; c.fillText(drive ? 'RECORDING…' : 'NO DRIVES YET · THEY RECORD WHEN YOU MOVE', w / 2, h / 2); c.textAlign = 'left'; return; }
  const pts = drive.pts, gps = pts.filter((p) => p[1] != null);
  const pad = 18 * d, top = Math.max(60, drive.top);
  let X, Y, usable;
  if (gps.length > 5) {
    // flat projection, scaled so the route fills the box without stretching
    let a = Infinity, b = -Infinity, e = Infinity, f = -Infinity;
    for (const p of gps) { a = Math.min(a, p[2]); b = Math.max(b, p[2]); e = Math.min(e, p[1]); f = Math.max(f, p[1]); }
    const kx = Math.cos((e + f) / 2 * Math.PI / 180), sw = Math.max(1e-6, (b - a) * kx), sh = Math.max(1e-6, f - e);
    const s = Math.min((w - pad * 2) / sw, (h - pad * 2) / sh), ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
    X = (p) => ox + (p[2] - a) * kx * s; Y = (p) => h - oy - (p[1] - e) * s; usable = (p) => p[1] != null;
    // faint grid
    c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = 1; c.beginPath();
    for (let gx = 0; gx < w; gx += 40 * d) { c.moveTo(gx + 0.5, 0); c.lineTo(gx + 0.5, h); }
    for (let gy = 0; gy < h; gy += 40 * d) { c.moveTo(0, gy + 0.5); c.lineTo(w, gy + 0.5); }
    c.stroke();
  } else {
    const t0 = pts[0][0], span = Math.max(1, pts[pts.length - 1][0] - t0);
    X = (p) => pad + (p[0] - t0) / span * (w - pad * 2); Y = (p) => h - pad - (p[3] || 0) / top * (h - pad * 2); usable = () => true;
    c.fillText('NO GPS ON THIS DRIVE · SPEED OVER TIME', pad, pad / 2 + 2 * d);
  }
  c.lineCap = 'round'; c.lineJoin = 'round';
  // halo then the speed-coloured line
  c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 8 * d; c.beginPath();
  let started = false;
  for (const p of pts) { if (!usable(p)) continue; if (!started) { c.moveTo(X(p), Y(p)); started = true; } else c.lineTo(X(p), Y(p)); }
  c.stroke();
  c.lineWidth = 2.6 * d;
  let prev = null;
  for (const p of pts) {
    if (!usable(p)) { prev = null; continue; }
    if (prev) { c.strokeStyle = speedColor(p[3], top); c.beginPath(); c.moveTo(X(prev), Y(prev)); c.lineTo(X(p), Y(p)); c.stroke(); }
    prev = p;
  }
  // start / finish dots
  const firstP = pts.find(usable), lastP = [...pts].reverse().find(usable);
  for (const [p, col] of [[firstP, '#e8e8ee'], [lastP, '#6e6e7a']]) if (p) { c.fillStyle = col; c.beginPath(); c.arc(X(p), Y(p), 4 * d, 0, Math.PI * 2); c.fill(); }
  // replay marker
  const i = Math.max(0, Math.min(pts.length - 1, Math.round(at * (pts.length - 1))));
  let m = pts[i]; if (!usable(m)) m = lastP;
  if (m) {
    const rg = c.createRadialGradient(X(m), Y(m), 0, X(m), Y(m), 14 * d);
    rg.addColorStop(0, accent); rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg; c.beginPath(); c.arc(X(m), Y(m), 14 * d, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(X(m), Y(m), 3.5 * d, 0, Math.PI * 2); c.fill();
  }
  // legend
  const lw = 90 * d, lx = w - lw - pad, ly = h - pad / 2 - 3 * d;
  const lg = c.createLinearGradient(lx, 0, lx + lw, 0);
  [0, 0.33, 0.66, 1].forEach((k) => lg.addColorStop(k, speedColor(k * top, top)));
  c.fillStyle = lg; c.fillRect(lx, ly, lw, 4 * d);
  c.fillStyle = '#6e6e7a'; c.fillText('0', lx - 10 * d, ly + 2 * d); c.fillText(Math.round(top) + ' MPH', lx + lw + 4 * d - 50 * d, ly - 8 * d);
}
