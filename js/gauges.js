// Analog gauges: four looks, a cached dial face, and a spring-driven needle.
// Each frame only the needle, hub and readouts are drawn; the ticks and numbers come from a cached
// canvas that is rebuilt only when the look, size, colours or brightness change.

import { EXTRA } from './gauge-looks.js';

export const LOOKS = ['NEON', 'AMBER', 'HAIRLINE', 'ARC', ...Object.keys(EXTRA)];
export const SWATCHES = ['#ff263e', '#ff7a1a', '#ffc21a', '#beff3c', '#2bff88', '#46c8ff', '#3d6bff', '#b44dff', '#ff4dd2', '#ffffff'];

// Per-look defaults. ink = ticks/numbers, red = redline zone, face = dial background.
const LOOK = {
  NEON:     { ink: '#a9d4ee', red: '#ff2030', face: ['#0d1a2c', '#000000'], tickW: 1.0, numFont: 'Michroma', lcd: 'blue' },
  AMBER:    { ink: '#ffad3a', red: '#ff3020', face: ['#140b04', '#000000'], tickW: 0.8, numFont: 'Michroma', lcd: 'seg' },
  HAIRLINE: { ink: '#e8e8ec', red: null,      face: null,                   tickW: 0.35, numFont: 'ShareMono', lcd: 'none' },
  ARC:      { ink: '#8a8a96', red: null,      face: null,                   tickW: 0.5, numFont: 'Michroma', lcd: 'none' },
};

const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;   // 7:30 round to 4:30, clockwise

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/** One gauge = one canvas. spec: { min, max, major, minor, red, label(v), title, unit, digits } */
export class Gauge {
  constructor(canvas, spec) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.spec = spec;
    this.pos = spec.min; this.vel = 0; this.faceKey = ''; this.face = document.createElement('canvas');
    this.sweepStart = null;
  }
  setSpec(spec) { this.spec = spec; this.faceKey = ''; this.pos = spec.min; this.vel = 0; }
  sweep() { this.sweepStart = performance.now(); }   // needle runs to max and back, like a car's start-up test

  // Critically damped spring: quick, no overshoot wobble, but still feels like a physical needle.
  _needle(target, dt) {
    const s = this.spec;
    if (this.sweepStart !== null) {
      const e = (performance.now() - this.sweepStart) / 1100;
      if (e >= 1) this.sweepStart = null;
      else target = s.min + (s.max - s.min) * Math.sin(Math.min(1, e) * Math.PI);
    }
    const k = 160, c = 2 * Math.sqrt(k) * 0.9, step = Math.min(dt, 0.05);
    const t = Math.max(s.min, Math.min(s.max, target ?? s.min));
    this.vel += (k * (t - this.pos) - c * this.vel) * step;
    this.pos += this.vel * step;
    return (this.pos - s.min) / (s.max - s.min);
  }

  _fit() {
    const r = this.c.getBoundingClientRect(), d = Math.min(3, Math.max(2, devicePixelRatio || 1));
    const w = Math.round(r.width * d), h = Math.round(r.height * d);
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    return { w, h, d };
  }

  _buildFace(w, h, d, o) {
    const f = this.face; f.width = w; f.height = h;
    const g = f.getContext('2d'), s = this.spec, L = LOOK[o.look];
    const cx = w / 2, cy = h * 0.52, R = Math.min(w, h) * 0.44, ink = o.dial || L.ink;
    g.clearRect(0, 0, w, h);
    if (L.face) {   // dial background glow
      const bg = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.1);
      bg.addColorStop(0, hexA(L.face[0], 0)); bg.addColorStop(0.55, hexA(L.face[0], 0.9 * o.bright)); bg.addColorStop(1, hexA(L.face[1], 0));
      g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, R * 1.1, 0, Math.PI * 2); g.fill();
    }
    const glowTick = (fn, color, width) => {   // layered strokes = soft neon without blocky shadowBlur
      for (const [mul, a] of [[5, 0.10], [2.6, 0.22], [1, 1]]) {
        g.strokeStyle = hexA(color, a * (mul === 1 ? o.bright : o.glow)); g.lineWidth = width * mul; g.beginPath(); fn(); g.stroke();
      }
    };
    g.lineCap = 'round';
    const range = s.max - s.min, ang = (v) => START + SWEEP * (v - s.min) / range;
    if (o.look === 'ARC') {   // track for the sweep bar
      g.strokeStyle = hexA(ink, 0.18); g.lineWidth = R * 0.11; g.beginPath(); g.arc(cx, cy, R * 0.88, START, START + SWEEP); g.stroke();
    }
    const minorStep = s.major / s.minor;
    for (let v = s.min; v <= s.max + 1e-9; v += minorStep) {
      const major = Math.abs((v - s.min) / s.major - Math.round((v - s.min) / s.major)) < 1e-6;
      const a = ang(v), red = s.red != null && v >= s.red - 1e-9 && L.red;
      const color = red ? L.red : ink;
      const r1 = o.look === 'ARC' ? R * 0.72 : R * (major ? 0.80 : 0.87), r2 = o.look === 'ARC' ? R * (major ? 0.66 : 0.69) : R * 0.97;
      if (o.look === 'ARC' && !major) continue;
      glowTick(() => { g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); },
        color, Math.max(1, R * (major ? 0.028 : 0.014) * L.tickW));
      const idx = Math.round((v - s.min) / s.major);
      if (major && R > 60 * d && (o.look !== 'ARC' || idx % 2 === 0)) {   // numbers only on dials big enough to read; ARC shows every other one
        const lr = o.look === 'ARC' ? R * 0.54 : R * 0.64, x = cx + Math.cos(a) * lr, y = cy + Math.sin(a) * lr;
        g.font = `${Math.round(R * (o.look === 'HAIRLINE' ? 0.1 : 0.13))}px ${L.numFont}, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = hexA(color, 0.35 * o.glow); g.fillText(s.label(v), x + 0, y + 0);
        g.save(); g.shadowColor = color; g.shadowBlur = R * 0.05 * o.glow; g.fillStyle = hexA(color, o.bright); g.fillText(s.label(v), x, y); g.restore();
      }
    }
    // title under the hub
    g.font = `${Math.round(R * (R > 60 * d ? 0.085 : 0.16))}px Michroma, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = hexA(ink, 0.9 * o.bright);
    if (R > 60 * d && o.look !== 'ARC') { g.fillText(s.title, cx, cy - R * 0.36); if (s.unit) { g.font = `${Math.round(R * 0.06)}px Michroma, sans-serif`; g.fillText(s.unit, cx, cy - R * 0.26); } }
    else if (R <= 60 * d) { g.font = `${Math.round(R * 0.15)}px ShareMono, monospace`; g.fillText(s.title + (s.unit ? ' ' + s.unit : ''), cx, cy + R * 0.7); }
  }

  // The eight extra looks (gauge-looks.js): same cache + spring needle, their own drawing.
  _drawExtra(value, dt, o, w, h, d, key) {
    const X = EXTRA[o.look], s = this.spec, R = Math.min(w, h) * 0.44;
    const base = { w, h, d, cx: w / 2, cy: h * 0.52, R, big: R > 60 * d, s, o, value,
      ink: o.dial || '#d3dbe4', red: '#ff2a2a', neon: o.neon, title: s.title + (s.unit ? ' ' + s.unit : ''),
      ang: (v) => START + SWEEP * (v - s.min) / (s.max - s.min) };
    if (key !== this.faceKey) {
      this.face.width = w; this.face.height = h;
      const fg = this.face.getContext('2d'); fg.clearRect(0, 0, w, h);
      X.face({ ...base, g: fg, f: 0 });
      this.faceKey = key;
    }
    const g = this.ctx;
    g.clearRect(0, 0, w, h); g.drawImage(this.face, 0, 0);
    X.live({ ...base, g, f: this._needle(value, dt) });
  }

  /** value: current reading (null = no data); o: { look, glow (0..1.5), bright (0.3..1.3), neon, dial, gear, speed } */
  draw(value, dt, o) {
    const { w, h, d } = this._fit();
    if (!w || !h) return;
    const key = [w, h, o.look, o.glow, o.bright, o.dial, this.spec.title].join('|');
    if (EXTRA[o.look]) return this._drawExtra(value, dt, o, w, h, d, key);
    if (key !== this.faceKey) { this._buildFace(w, h, d, o); this.faceKey = key; }
    const g = this.ctx, s = this.spec, L = LOOK[o.look];
    const cx = w / 2, cy = h * 0.52, R = Math.min(w, h) * 0.44, big = R > 60 * d;
    g.clearRect(0, 0, w, h);
    g.drawImage(this.face, 0, 0);
    const f = this._needle(value, dt), a = START + SWEEP * f, neon = o.neon;
    g.lineCap = 'round';

    if (o.look === 'ARC') {   // glowing sweep bar instead of a needle
      for (const [mul, al] of [[2.2, 0.18], [1.4, 0.35], [1, 1]]) {
        g.strokeStyle = hexA(neon, al * (mul === 1 ? o.bright : o.glow)); g.lineWidth = R * 0.11 * mul;
        g.beginPath(); g.arc(cx, cy, R * 0.88, START, Math.max(START + 0.001, a)); g.stroke();
      }
    } else {
      const tipR = R * (o.look === 'HAIRLINE' ? 0.95 : 0.9), tailR = R * 0.14;
      const tx = cx + Math.cos(a) * tipR, ty = cy + Math.sin(a) * tipR, bx = cx - Math.cos(a) * tailR, by = cy - Math.sin(a) * tailR;
      const width = R * (o.look === 'HAIRLINE' ? 0.012 : 0.03);
      for (const [mul, al] of [[6, 0.10], [3, 0.25], [1.6, 0.6], [1, 1]]) {   // neon needle
        g.strokeStyle = mul === 1 ? hexA('#ffffff', 0.85 * o.bright) : hexA(neon, al * o.glow);
        g.lineWidth = width * mul; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
      }
      g.strokeStyle = hexA(neon, o.bright); g.lineWidth = width * 0.9; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
      // hub
      const hub = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.16);
      hub.addColorStop(0, '#000'); hub.addColorStop(0.7, '#050505'); hub.addColorStop(1, hexA(neon, 0.35 * o.glow));
      g.fillStyle = hub; g.beginPath(); g.arc(cx, cy, R * (o.look === 'HAIRLINE' ? 0.05 : 0.11), 0, Math.PI * 2); g.fill();
    }

    if (!big) {   // small gauge: digital value under the needle
      g.font = `${Math.round(R * 0.22)}px Michroma, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = hexA(o.dial || L.ink, o.bright);
      g.fillText(value == null ? '--' : s.digits(value), cx, cy + R * 0.36);
      return;
    }
    // big dial: gear in the middle, speed below
    const gear = o.gear ?? '';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (o.look === 'ARC') {
      g.font = `${Math.round(R * 0.2)}px Michroma, sans-serif`; g.fillStyle = hexA('#ffffff', o.bright);
      g.fillText(value == null ? '--' : Math.round(value).toLocaleString('en-US'), cx, cy - R * 0.04);
      g.font = `${Math.round(R * 0.08)}px Michroma, sans-serif`; g.fillStyle = hexA(neon, o.bright); g.fillText(`RPM · GEAR ${gear}`, cx, cy + R * 0.16);
    } else {
      g.font = `${Math.round(R * 0.24)}px Michroma, sans-serif`;
      if (L.lcd === 'seg') { g.fillStyle = hexA(L.ink, 0.12); g.fillText('8', cx, cy + R * 0.34); }
      g.save(); g.shadowColor = neon; g.shadowBlur = R * 0.06 * o.glow; g.fillStyle = hexA(o.look === 'NEON' ? neon : (o.dial || L.ink), o.bright);
      g.fillText(gear, cx, cy + R * 0.34); g.restore();
    }
    // speed readout
    const sp = o.speed == null ? '--' : String(Math.round(o.speed));
    const bw = R * 0.62, bh = R * 0.2, bx = cx - bw / 2, by2 = cy + R * 0.58;
    if (L.lcd === 'blue') {
      const lcd = g.createLinearGradient(bx, by2, bx + bw, by2);
      lcd.addColorStop(0, `rgba(70,110,170,${0.55 * o.bright})`); lcd.addColorStop(0.5, `rgba(10,50,130,${0.85 * o.bright})`); lcd.addColorStop(1, `rgba(70,110,170,${0.55 * o.bright})`);
      g.fillStyle = lcd; g.beginPath(); g.roundRect(bx, by2, bw, bh, R * 0.02); g.fill();
      g.fillStyle = hexA('#dff1ff', o.bright);
    } else if (L.lcd === 'seg') {
      g.font = `${Math.round(bh * 0.8)}px Michroma, sans-serif`; g.fillStyle = hexA(L.ink, 0.1); g.fillText('888', cx, by2 + bh / 2);
      g.fillStyle = hexA(o.dial || L.ink, o.bright);
    } else g.fillStyle = hexA(o.dial || L.ink, o.bright);
    g.font = `${Math.round(bh * 0.8)}px Michroma, sans-serif`; g.fillText(sp, cx, by2 + bh / 2);
    g.font = `${Math.round(R * 0.07)}px Michroma, sans-serif`; g.fillStyle = hexA(o.dial || L.ink, 0.85 * o.bright); g.fillText('MPH', cx, by2 + bh + R * 0.08);
  }
}

export const SPECS = {
  rpm:      { min: 0, max: 8000, major: 1000, minor: 2, red: 7000, label: (v) => String(v / 1000), title: 'RPM', unit: 'X1000', digits: (v) => Math.round(v).toString() },
  boost:    { min: -15, max: 25, major: 10, minor: 2, red: 22, label: (v) => String(v), title: 'BOOST', unit: 'PSI', digits: (v) => v.toFixed(1) },
  afr:      { min: 9, max: 18, major: 3, minor: 3, red: null, label: (v) => String(v), title: 'AFR', unit: '', digits: (v) => v.toFixed(1) },
  coolant:  { min: 100, max: 260, major: 40, minor: 2, red: 240, label: (v) => String(v), title: 'COOLANT', unit: '°F', digits: (v) => String(Math.round(v)) },
  oil_temp: { min: 100, max: 300, major: 50, minor: 2, red: 280, label: (v) => String(v), title: 'OIL', unit: '°F', digits: (v) => String(Math.round(v)) },
  iat:      { min: 0, max: 200, major: 50, minor: 2, red: 150, label: (v) => String(v), title: 'INTAKE', unit: '°F', digits: (v) => String(Math.round(v)) },
  throttle: { min: 0, max: 100, major: 25, minor: 2, red: null, label: (v) => String(v), title: 'THROTTLE', unit: '%', digits: (v) => Math.round(v) + '%' },
  battery:  { min: 10, max: 16, major: 2, minor: 2, red: null, label: (v) => String(v), title: 'VOLTS', unit: 'V', digits: (v) => v.toFixed(1) },
  knock:    { min: 0, max: 8, major: 2, minor: 2, red: 4, label: (v) => String(v), title: 'KNOCK', unit: '°', digits: (v) => v.toFixed(1) },
  load:     { min: 0, max: 100, major: 25, minor: 2, red: null, label: (v) => String(v), title: 'LOAD', unit: '%', digits: (v) => Math.round(v) + '%' },
  fuel_pressure: { min: 0, max: 3000, major: 1000, minor: 2, red: null, label: (v) => String(v / 1000), title: 'FUEL', unit: 'X1000 PSI', digits: (v) => String(Math.round(v)) },
};
export const MINI_KEYS = ['boost', 'afr', 'coolant', 'oil_temp', 'iat', 'throttle', 'battery', 'knock', 'load', 'fuel_pressure'];
