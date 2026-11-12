// Extra gauge looks (original designs in classic racing-HUD styles). Each look has:
//   face(G): static parts, drawn once into the cached face canvas
//   live(G): per-frame parts (needle / lit segments / digital readouts)
// G = { g, w, h, d, cx, cy, R, big, s (spec), ang(v), f (0..1 needle), value, o, ink, red, neon, title }

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
const glowLine = (G, draw, color, width, layers = [[5, 0.1], [2.6, 0.22], [1, 1]]) => {
  const { g, o } = G;
  for (const [mul, a] of layers) {
    g.strokeStyle = hexA(color, a * (mul === 1 ? o.bright : o.glow)); g.lineWidth = width * mul; g.beginPath(); draw(); g.stroke();
  }
};
const txt = (G, str, x, y, px, color, { font = 'Michroma', align = 'center', glow = 0, italic = false, alpha = 1 } = {}) => {
  const { g, o } = G;
  g.font = `${italic ? 'italic ' : ''}${Math.max(6, Math.round(px))}px ${font}, sans-serif`;
  g.textAlign = align; g.textBaseline = 'middle';
  if (glow) { g.save(); g.shadowColor = color; g.shadowBlur = glow * o.glow; }
  g.fillStyle = hexA(color, alpha * o.bright); g.fillText(str, x, y);
  if (glow) g.restore();
};
const majors = (s, fn) => { for (let v = s.min, i = 0; v <= s.max + 1e-9; v += s.major, i++) fn(v, i); };
const minors = (s, fn) => { const st = s.major / s.minor; for (let v = s.min; v <= s.max + 1e-9; v += st) fn(v); };
const isRed = (G, v) => G.s.red != null && v >= G.s.red - 1e-9;
const valueText = (G) => (G.value == null ? '--' : G.s.digits(G.value));
const speedText = (G) => (G.o.speed == null ? '--' : String(Math.round(G.o.speed)));
const smallTitle = (G, y) => txt(G, G.title, G.cx, y, G.R * 0.15, G.ink, { font: 'ShareMono', alpha: 0.85 });
const pt = (G, a, r) => [G.cx + Math.cos(a) * r, G.cy + Math.sin(a) * r];
const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;

export const EXTRA = {
  // Like a real instrument: turned-metal bezel, dark dial with a fine brushed finish, crisp white
  // printed markings, a painted redline band, a tapered needle that casts a shadow, a metal centre cap
  // and a glass reflection over the top. Needle colour follows the neon colour setting.
  REAL: {
    face(G) {
      const { g, cx, cy, R, s, o } = G;
      const ink = o.dial || '#f4f4f6', sys = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial';
      // bezel: a conic sweep of light and dark reads as turned metal
      const rb = R * 1.07;
      let bez;
      if (g.createConicGradient) {
        bez = g.createConicGradient(-Math.PI / 4, cx, cy);
        [[0, '#e9eaee'], [0.12, '#6b6e76'], [0.25, '#2a2b30'], [0.4, '#9ea1a9'], [0.55, '#f2f3f6'], [0.7, '#4a4c53'], [0.85, '#1e1f23'], [1, '#e9eaee']].forEach(([k, c]) => bez.addColorStop(k, c));
      } else { bez = g.createLinearGradient(cx - rb, cy - rb, cx + rb, cy + rb); bez.addColorStop(0, '#e9eaee'); bez.addColorStop(0.5, '#3a3b40'); bez.addColorStop(1, '#bfc1c8'); }
      g.fillStyle = bez; g.beginPath(); g.arc(cx, cy, rb, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#060607'; g.beginPath(); g.arc(cx, cy, R * 1.0, 0, Math.PI * 2); g.fill();
      // dial: dark, a touch lighter in the middle, with a fine brushed ring texture
      const face = g.createRadialGradient(cx, cy - R * 0.2, R * 0.05, cx, cy, R * 0.99);
      face.addColorStop(0, '#1c1d22'); face.addColorStop(0.7, '#0d0d10'); face.addColorStop(1, '#030304');
      g.fillStyle = face; g.beginPath(); g.arc(cx, cy, R * 0.985, 0, Math.PI * 2); g.fill();
      g.lineWidth = Math.max(1, R * 0.004);
      for (let r = R * 0.12; r < R * 0.97; r += R * 0.018) { g.strokeStyle = `rgba(255,255,255,${0.012 + 0.012 * Math.sin(r * 0.7)})`; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
      // inner shadow under the bezel lip
      const lip = g.createRadialGradient(cx, cy, R * 0.86, cx, cy, R * 1.0);
      lip.addColorStop(0, 'rgba(0,0,0,0)'); lip.addColorStop(1, 'rgba(0,0,0,0.85)');
      g.fillStyle = lip; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      // painted redline band
      if (s.red != null) {
        g.strokeStyle = hexA('#d4121f', 0.92 * o.bright); g.lineWidth = R * 0.05; g.lineCap = 'butt';
        g.beginPath(); g.arc(cx, cy, R * 0.905, G.ang(s.red), G.ang(s.max)); g.stroke();
      }
      // markings: slight bloom like a backlit print
      g.lineCap = 'butt';
      minors(s, (v) => {
        const a = G.ang(v), maj = Math.abs((v - s.min) / s.major - Math.round((v - s.min) / s.major)) < 1e-6;
        const [x1, y1] = pt(G, a, R * (maj ? 0.78 : 0.85)), [x2, y2] = pt(G, a, R * 0.93);
        const c = isRed(G, v) && !maj ? '#ff8a8a' : ink;
        g.strokeStyle = hexA(c, 0.18 * o.glow); g.lineWidth = R * (maj ? 0.04 : 0.02); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.strokeStyle = hexA(c, 0.95 * o.bright); g.lineWidth = Math.max(1, R * (maj ? 0.016 : 0.007)); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      });
      if (G.big) {
        majors(s, (v) => {
          const [x, y] = pt(G, G.ang(v), R * 0.63);
          g.font = `600 ${Math.round(R * 0.12)}px ${sys}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = hexA(isRed(G, v) ? '#ff3a46' : ink, 0.2 * o.glow); g.fillText(s.label(v), x, y + R * 0.004);
          g.fillStyle = hexA(isRed(G, v) ? '#ff3a46' : ink, o.bright); g.fillText(s.label(v), x, y);
        });
        g.font = `600 ${Math.round(R * 0.065)}px ${sys}`; g.fillStyle = hexA(ink, 0.55 * o.bright);
        g.fillText(s.title, cx, cy - R * 0.36);
        if (s.unit) { g.font = `500 ${Math.round(R * 0.05)}px ${sys}`; g.fillStyle = hexA(ink, 0.4 * o.bright); g.fillText(s.unit, cx, cy - R * 0.27); }
        // gear / speed window, set into the dial
        g.fillStyle = '#020203'; g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = Math.max(1, R * 0.006);
        g.beginPath(); g.roundRect(cx - R * 0.26, cy + R * 0.2, R * 0.52, R * 0.46, R * 0.06); g.fill(); g.stroke();
      }
    },
    live(G) {
      const { g, cx, cy, R, f, o } = G;
      const sys = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial', ink = o.dial || '#f4f4f6';
      if (G.big) {
        txt(G, o.gear ?? '', cx, cy + R * 0.34, R * 0.2, '#ffffff', { font: sys });
        txt(G, speedText(G), cx, cy + R * 0.53, R * 0.1, ink, { font: sys, alpha: 0.9 });
        txt(G, 'MPH', cx, cy + R * 0.61, R * 0.04, ink, { font: sys, alpha: 0.45 });
        const lamps = o.lamps || [];
        if (lamps.length) txt(G, lamps.join(' · '), cx, cy + R * 0.8, R * 0.06, '#ffb000', { font: sys, glow: R * 0.04 });
      } else {
        txt(G, valueText(G), cx, cy + R * 0.42, R * 0.24, '#ffffff', { font: sys });
        txt(G, G.title, cx, cy + R * 0.7, R * 0.12, ink, { font: sys, alpha: 0.55 });
      }
      // needle: tapered blade with a counterweight, its shadow falling on the dial
      const a = START + SWEEP * f, ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
      const tip = R * 0.9, tail = R * 0.2, w0 = R * 0.032, w1 = R * 0.006;
      const blade = (ox, oy) => {
        g.beginPath();
        g.moveTo(cx - ca * tail + nx * w0 + ox, cy - sa * tail + ny * w0 + oy);
        g.lineTo(cx + ca * tip + nx * w1 + ox, cy + sa * tip + ny * w1 + oy);
        g.lineTo(cx + ca * tip - nx * w1 + ox, cy + sa * tip - ny * w1 + oy);
        g.lineTo(cx - ca * tail - nx * w0 + ox, cy - sa * tail - ny * w0 + oy);
        g.closePath();
      };
      for (const [k, al] of [[0.05, 0.18], [0.03, 0.28]]) { g.fillStyle = `rgba(0,0,0,${al})`; blade(R * k * 0.6, R * k); g.fill(); }
      g.save(); g.globalCompositeOperation = 'lighter';
      for (const [mul, al] of [[3.2, 0.1], [1.8, 0.2]]) { g.strokeStyle = hexA(G.neon, al * o.glow); g.lineWidth = w0 * mul; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx + ca * R * 0.15, cy + sa * R * 0.15); g.lineTo(cx + ca * tip, cy + sa * tip); g.stroke(); }
      g.restore();
      const grad = g.createLinearGradient(cx + nx * w0, cy + ny * w0, cx - nx * w0, cy - ny * w0);
      grad.addColorStop(0, hexA(G.neon, o.bright)); grad.addColorStop(0.5, hexA('#ffffff', 0.9 * o.bright)); grad.addColorStop(1, hexA(G.neon, 0.85 * o.bright));
      g.fillStyle = grad; blade(0, 0); g.fill();
      // centre cap
      const cap = g.createRadialGradient(cx - R * 0.025, cy - R * 0.03, R * 0.005, cx, cy, R * 0.085);
      cap.addColorStop(0, '#9a9ca3'); cap.addColorStop(0.35, '#3a3b40'); cap.addColorStop(1, '#0b0b0d');
      g.fillStyle = cap; g.beginPath(); g.arc(cx, cy, R * 0.08, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = Math.max(1, R * 0.006); g.stroke();
      // glass: a soft curved reflection across the upper left, over everything
      g.save(); g.beginPath(); g.arc(cx, cy, R * 0.985, 0, Math.PI * 2); g.clip();
      const gl = g.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy + R * 0.3);
      gl.addColorStop(0, 'rgba(255,255,255,0.10)'); gl.addColorStop(0.45, 'rgba(255,255,255,0.025)'); gl.addColorStop(0.46, 'rgba(255,255,255,0)');
      g.fillStyle = gl; g.beginPath(); g.ellipse(cx - R * 0.25, cy - R * 0.55, R * 1.05, R * 0.62, -0.5, 0, Math.PI * 2); g.fill();
      g.restore();
    },
  },

  // Thick glowing progress ring, big digital readout in the middle.
  RING: {
    face(G) {
      const { g, cx, cy, R, ink, s } = G;
      g.lineCap = 'round';
      g.strokeStyle = hexA(ink, 0.13); g.lineWidth = R * 0.09; g.beginPath(); g.arc(cx, cy, R * 0.9, START, START + SWEEP); g.stroke();
      g.strokeStyle = hexA(ink, 0.35); g.lineWidth = Math.max(1, R * 0.012); g.beginPath(); g.arc(cx, cy, R * 0.75, START, START + SWEEP); g.stroke();
      if (G.big) majors(s, (v) => { const [x, y] = pt(G, G.ang(v), R * 0.64); txt(G, s.label(v), x, y, R * 0.085, isRed(G, v) ? G.red : ink, { alpha: 0.8 }); });
    },
    live(G) {
      const { cx, cy, R, f, neon } = G;
      const over = G.s.red != null && G.value != null && G.value >= G.s.red;
      G.g.lineCap = 'round';
      glowLine(G, () => G.g.arc(cx, cy, R * 0.9, START, START + Math.max(0.002, SWEEP * f)), over ? G.red : neon, R * 0.09);
      if (G.big) {
        txt(G, speedText(G), cx, cy - R * 0.06, R * 0.3, '#ffffff', { glow: R * 0.05 });
        txt(G, 'MPH', cx, cy + R * 0.16, R * 0.07, G.ink, { alpha: 0.8 });
        txt(G, G.o.gear ?? '', cx, cy + R * 0.36, R * 0.16, neon, { glow: R * 0.05 });
      } else { txt(G, valueText(G), cx, cy, R * 0.26, '#ffffff'); smallTitle(G, cy + R * 0.66); }
    },
  },

  // Tapered wedge ticks that light up with the reading; giant gear number.
  FAN: {
    wedges(G, lit) {
      const { g, R, s } = G, st = s.major / s.minor;
      for (let v = s.min; v <= s.max + 1e-9; v += st) {
        const k = (v - s.min) / (s.max - s.min);
        if (lit && k > G.f + 1e-6) break;
        const a = G.ang(v), hw = (0.012 + 0.03 * k) * R / (R * 0.8), r1 = R * 0.7, r2 = R * (0.86 + 0.06 * k);
        const [x1, y1] = pt(G, a - hw * 0.6, r1), [x2, y2] = pt(G, a + hw * 0.6, r1), [x3, y3] = pt(G, a + hw, r2), [x4, y4] = pt(G, a - hw, r2);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.lineTo(x4, y4); g.closePath();
        const color = isRed(G, v) ? G.red : (lit ? G.neon : G.ink);
        g.fillStyle = hexA(color, lit ? G.o.bright : (isRed(G, v) ? 0.3 : 0.16)); g.fill();
        if (lit) { g.strokeStyle = hexA(color, 0.25 * G.o.glow); g.lineWidth = R * 0.03; g.stroke(); }
      }
    },
    face(G) {
      EXTRA.FAN.wedges(G, false);
      if (G.big) majors(G.s, (v) => { const [x, y] = pt(G, G.ang(v), G.R * 0.56); txt(G, G.s.label(v), x, y, G.R * 0.09, isRed(G, v) ? G.red : G.ink, { alpha: 0.75 }); });
    },
    live(G) {
      EXTRA.FAN.wedges(G, true);
      const { cx, cy, R } = G;
      if (G.big) {
        txt(G, G.o.gear ?? '', cx, cy - R * 0.02, R * 0.42, '#ffffff', { glow: R * 0.06 });
        txt(G, `${speedText(G)} MPH`, cx, cy + R * 0.42, R * 0.1, G.neon, { glow: R * 0.03 });
      } else { txt(G, valueText(G), cx, cy + R * 0.05, R * 0.24, '#ffffff'); smallTitle(G, cy + R * 0.66); }
    },
  },

  // Horizontal segmented LCD bar with a big digital speed under it.
  STRIP: {
    geom(G) { const { w, h, big } = G; return { x0: w * 0.07, x1: w * 0.93, y: h * (big ? 0.26 : 0.3), bh: h * (big ? 0.12 : 0.16), n: big ? 40 : 20 }; },
    segs(G, lit) {
      const { g } = G, { x0, x1, y, bh, n } = EXTRA.STRIP.geom(G), gap = (x1 - x0) * 0.006, sw = (x1 - x0 - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n, v = G.s.min + k * (G.s.max - G.s.min);
        if (lit && k > G.f) break;
        const red = isRed(G, v), x = x0 + i * (sw + gap), hh = bh * (0.55 + 0.45 * k);
        g.fillStyle = lit ? hexA(red ? G.red : G.neon, G.o.bright) : hexA(red ? G.red : G.ink, red ? 0.25 : 0.12);
        g.fillRect(x, y + bh - hh, sw, hh);
        if (lit) { g.fillStyle = hexA(red ? G.red : G.neon, 0.18 * G.o.glow); g.fillRect(x - sw * 0.3, y + bh - hh - sw * 0.3, sw * 1.6, hh + sw * 0.6); }
      }
    },
    face(G) {
      EXTRA.STRIP.segs(G, false);
      const { x0, x1, y } = EXTRA.STRIP.geom(G);
      if (G.big) majors(G.s, (v) => txt(G, G.s.label(v), x0 + (x1 - x0) * (v - G.s.min) / (G.s.max - G.s.min), y - G.h * 0.05, G.h * 0.045, isRed(G, v) ? G.red : G.ink, { alpha: 0.7 }));
    },
    live(G) {
      EXTRA.STRIP.segs(G, true);
      const { w, h } = G;
      if (G.big) {
        const sp = Math.min(h * 0.24, w * 0.19);
        txt(G, '888', w * 0.42, h * 0.62, sp, G.ink, { alpha: 0.07 });
        txt(G, speedText(G), w * 0.42, h * 0.62, sp, G.neon, { glow: h * 0.03 });
        txt(G, 'MPH', w * 0.42, h * 0.8, h * 0.05, G.ink, { alpha: 0.8 });
        txt(G, G.o.gear ?? '', w * 0.84, h * 0.62, h * 0.16, '#ffffff');
        txt(G, 'GEAR', w * 0.84, h * 0.76, h * 0.04, G.ink, { alpha: 0.7 });
      } else { txt(G, valueText(G), w / 2, h * 0.64, h * 0.2, '#ffffff'); txt(G, G.title, w / 2, h * 0.86, h * 0.1, G.ink, { font: 'ShareMono', alpha: 0.85 }); }
    },
  },

  // Horseshoe band in green / amber / red zones with a slim needle.
  TRACK: {
    zones: [[0, 0.6, '#7bdc3a'], [0.6, 0.85, '#ffb000'], [0.85, 1, '#ff3020']],
    face(G) {
      const { g, cx, cy, R } = G;
      g.lineCap = 'butt';
      for (const [a, b, c] of EXTRA.TRACK.zones) { g.strokeStyle = hexA(c, 0.22); g.lineWidth = R * 0.12; g.beginPath(); g.arc(cx, cy, R * 0.9, START + SWEEP * a, START + SWEEP * b); g.stroke(); }
      minors(G.s, (v) => { const a = G.ang(v), [x1, y1] = pt(G, a, R * 0.72), [x2, y2] = pt(G, a, R * 0.79); g.strokeStyle = hexA(G.ink, 0.7 * G.o.bright); g.lineWidth = Math.max(1, R * 0.012); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); });
      if (G.big) majors(G.s, (v) => { const [x, y] = pt(G, G.ang(v), R * 0.6); txt(G, G.s.label(v), x, y, R * 0.1, G.ink, { alpha: 0.85 }); });
    },
    live(G) {
      const { g, cx, cy, R, f } = G;
      g.lineCap = 'butt';
      for (const [a, b, c] of EXTRA.TRACK.zones) {
        if (f <= a) break;
        glowLine(G, () => g.arc(cx, cy, R * 0.9, START + SWEEP * a, START + SWEEP * Math.min(b, f)), c, R * 0.12, [[1.6, 0.2], [1, 1]]);
      }
      const a = START + SWEEP * f, [tx, ty] = pt(G, a, R * 0.82), [bx, by] = pt(G, a + Math.PI, R * 0.1);
      g.lineCap = 'round';
      glowLine(G, () => { g.moveTo(bx, by); g.lineTo(tx, ty); }, G.neon, R * 0.022);
      g.fillStyle = '#0a0a0a'; g.beginPath(); g.arc(cx, cy, R * 0.07, 0, Math.PI * 2); g.fill();
      if (G.big) {
        g.fillStyle = hexA('#000000', 0.6); g.strokeStyle = hexA(G.ink, 0.6); g.lineWidth = Math.max(1, R * 0.01);
        g.beginPath(); g.roundRect(cx - R * 0.1, cy - R * 0.44, R * 0.2, R * 0.2, R * 0.03); g.fill(); g.stroke();
        txt(G, G.o.gear ?? '', cx, cy - R * 0.34, R * 0.14, '#ffb000');
        g.fillStyle = hexA('#ffb000', 0.9 * G.o.bright); g.beginPath(); g.roundRect(cx - R * 0.3, cy + R * 0.42, R * 0.6, R * 0.22, R * 0.03); g.fill();
        txt(G, speedText(G), cx, cy + R * 0.53, R * 0.16, '#1a1000', { alpha: 1 / Math.max(0.3, G.o.bright) });
        txt(G, 'MPH', cx, cy + R * 0.74, R * 0.07, G.ink, { alpha: 0.8 });
      } else { txt(G, valueText(G), cx, cy + R * 0.34, R * 0.22, '#ffffff'); smallTitle(G, cy + R * 0.7); }
    },
  },

  // Classic white-face dial: black numbers, red needle with counterweight, odometer window.
  CHRONO: {
    face(G) {
      const { g, cx, cy, R, s } = G, paper = '#efeae0', black = G.o.dial || '#141414';
      g.fillStyle = hexA(paper, 0.94 * G.o.bright); g.beginPath(); g.arc(cx, cy, R * 1.0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#8a8a8a'; g.lineWidth = R * 0.035; g.beginPath(); g.arc(cx, cy, R * 1.0, 0, Math.PI * 2); g.stroke();
      minors(s, (v) => {
        const a = G.ang(v), major = Math.abs(((v - s.min) / s.major) % 1) < 1e-6 || Math.abs(((v - s.min) / s.major) % 1 - 1) < 1e-6;
        const [x1, y1] = pt(G, a, R * (major ? 0.78 : 0.85)), [x2, y2] = pt(G, a, R * 0.93);
        g.strokeStyle = isRed(G, v) ? '#c81010' : black; g.lineWidth = Math.max(1, R * (major ? 0.025 : 0.01));
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      });
      if (G.big) {
        majors(s, (v) => { const [x, y] = pt(G, G.ang(v), R * 0.64); txt(G, s.label(v), x, y, R * 0.13, isRed(G, v) ? '#c81010' : black, { font: 'ShareMono', alpha: 1 / Math.max(0.3, G.o.bright) }); });
        txt(G, s.title + (s.unit ? ' ' + s.unit : ''), cx, cy - R * 0.3, R * 0.07, black, { font: 'ShareMono', alpha: 1 / Math.max(0.3, G.o.bright) });
        txt(G, 'CARBOX', cx, cy + R * 0.24, R * 0.06, '#7a7a7a', { font: 'Michroma', alpha: 1 / Math.max(0.3, G.o.bright) });
      }
    },
    live(G) {
      const { g, cx, cy, R, f } = G, a = START + SWEEP * f;
      if (G.big) {
        g.fillStyle = '#111'; g.fillRect(cx - R * 0.26, cy + R * 0.42, R * 0.52, R * 0.17);
        txt(G, speedText(G).padStart(3, '0'), cx, cy + R * 0.505, R * 0.12, '#f4f4f4', { font: 'ShareMono', alpha: 1 / Math.max(0.3, G.o.bright) });
        txt(G, `MPH · ${G.o.gear ?? ''}`, cx, cy + R * 0.68, R * 0.06, '#333', { font: 'ShareMono', alpha: 1 / Math.max(0.3, G.o.bright) });
      } else txt(G, valueText(G), cx, cy + R * 0.42, R * 0.2, '#141414', { font: 'ShareMono', alpha: 1 / Math.max(0.3, G.o.bright) });
      const [tx, ty] = pt(G, a, R * 0.9), [bx, by] = pt(G, a + Math.PI, R * 0.2);
      g.lineCap = 'round'; g.strokeStyle = G.o.neon; g.lineWidth = Math.max(1.5, R * 0.016);
      g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = G.o.neon; g.beginPath(); g.arc(bx, by, R * 0.04, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111'; g.beginPath(); g.arc(cx, cy, R * 0.06, 0, Math.PI * 2); g.fill();
      if (!G.big) smallTitle({ ...G, ink: '#333' }, cy + R * 0.7);
    },
  },

  // Dark shrouded race gauge: shift lights across the top, warning lamps, LCD gear + speed.
  RACEDASH: {
    face(G) {
      const { g, cx, cy, R, s } = G;
      const sh = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      sh.addColorStop(0, '#202027'); sh.addColorStop(1, '#0a0a0d');
      g.fillStyle = sh; g.beginPath(); g.arc(cx, cy, R * 0.98, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3a3a44'; g.lineWidth = R * 0.03; g.stroke();
      minors(s, (v) => { const a = G.ang(v), [x1, y1] = pt(G, a, R * 0.8), [x2, y2] = pt(G, a, R * 0.9); g.strokeStyle = hexA(isRed(G, v) ? G.red : G.ink, G.o.bright); g.lineWidth = Math.max(1, R * 0.014); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); });
      if (G.big) majors(s, (v) => { const [x, y] = pt(G, G.ang(v), R * 0.68); txt(G, s.label(v), x, y, R * 0.1, isRed(G, v) ? G.red : G.ink); });
    },
    live(G) {
      const { g, cx, cy, R, f } = G, n = 12;
      const a = START + SWEEP * f, [tx, ty] = pt(G, a, R * 0.88), [bx, by] = pt(G, a + Math.PI, R * 0.12);
      g.lineCap = 'round';
      glowLine(G, () => { g.moveTo(bx, by); g.lineTo(tx, ty); }, G.neon, R * 0.02);
      g.fillStyle = '#2a2a33'; g.beginPath(); g.arc(cx, cy, R * 0.08, 0, Math.PI * 2); g.fill();
      if (!G.big) { txt(G, valueText(G), cx, cy + R * 0.38, R * 0.22, '#e8fbff'); smallTitle(G, cy + R * 0.68); return; }
      // shift lights: start at 55% of the scale, all flash past 95%
      const lit = Math.round(Math.max(0, Math.min(1, (f - 0.55) / 0.4)) * n), flash = f > 0.95 && (performance.now() / 90 | 0) % 2;
      for (let i = 0; i < n; i++) {
        const la = -Math.PI * 0.82 + (Math.PI * 0.64) * (i + 0.5) / n, [x, y] = pt(G, la, R * 1.06);
        const c = i < 5 ? '#2bff6a' : i < 9 ? '#ffd21a' : '#ff2a2a', on = flash ? true : i < lit;
        g.fillStyle = on ? hexA(flash ? '#4da3ff' : c, G.o.bright) : 'rgba(255,255,255,0.07)';
        g.beginPath(); g.arc(x, y, R * 0.035, 0, Math.PI * 2); g.fill();
        if (on) { g.fillStyle = hexA(flash ? '#4da3ff' : c, 0.25 * G.o.glow); g.beginPath(); g.arc(x, y, R * 0.07, 0, Math.PI * 2); g.fill(); }
      }
      // the display sits in front of the needle, like a real race dash
      g.fillStyle = '#05080a'; g.strokeStyle = '#2c3a40'; g.lineWidth = Math.max(1, R * 0.01);
      g.beginPath(); g.roundRect(cx - R * 0.34, cy + R * 0.16, R * 0.68, R * 0.3, R * 0.03); g.fill(); g.stroke();
      txt(G, G.o.gear ?? '', cx - R * 0.17, cy + R * 0.31, R * 0.2, '#e8fbff');
      txt(G, speedText(G), cx + R * 0.13, cy + R * 0.28, R * 0.13, '#9fe8ff');
      txt(G, 'MPH', cx + R * 0.13, cy + R * 0.4, R * 0.05, '#5d8a96');
      ['KNOCK', 'LEAN', 'HOT'].forEach((l, i) => txt(G, l, cx + (i - 1) * R * 0.28, cy + R * 0.62, R * 0.065, (G.o.lamps || []).includes(l) ? '#ffb000' : '#3a3a44', { font: 'ShareMono', glow: (G.o.lamps || []).includes(l) ? R * 0.04 : 0 }));
    },
  },

  // Heavy bezel band with a red wedge, numbers on the band, tapered needle.
  BLADE: {
    face(G) {
      const { g, cx, cy, R, s } = G;
      g.lineCap = 'butt';
      g.strokeStyle = hexA('#2d3036', 0.95); g.lineWidth = R * 0.2; g.beginPath(); g.arc(cx, cy, R * 0.86, START, START + SWEEP); g.stroke();
      if (s.red != null) { g.strokeStyle = hexA(G.red, 0.85 * G.o.bright); g.beginPath(); g.arc(cx, cy, R * 0.86, G.ang(s.red), START + SWEEP); g.stroke(); }
      g.strokeStyle = hexA(G.ink, 0.5); g.lineWidth = Math.max(1, R * 0.01); g.beginPath(); g.arc(cx, cy, R * 0.75, START, START + SWEEP); g.stroke();
      minors(s, (v) => { const a = G.ang(v), [x1, y1] = pt(G, a, R * 0.69), [x2, y2] = pt(G, a, R * 0.75); g.strokeStyle = hexA(G.ink, 0.8); g.lineWidth = Math.max(1, R * 0.012); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); });
      if (G.big) majors(s, (v) => { const [x, y] = pt(G, G.ang(v), R * 0.86); txt(G, s.label(v), x, y, R * 0.12, '#f2f2f2', { italic: true }); });
    },
    live(G) {
      const { g, cx, cy, R, f } = G, a = START + SWEEP * f;
      const tip = pt(G, a, R * 0.78), l = pt(G, a + Math.PI / 2, R * 0.035), r = pt(G, a - Math.PI / 2, R * 0.035);
      for (const [grow, al] of [[2.2, 0.15], [1.4, 0.3], [1, 1]]) {
        g.fillStyle = hexA(G.neon, al * (grow === 1 ? G.o.bright : G.o.glow));
        g.beginPath(); g.moveTo(tip[0], tip[1]); g.lineTo(cx + (l[0] - cx) * grow, cy + (l[1] - cy) * grow); g.lineTo(cx + (r[0] - cx) * grow, cy + (r[1] - cy) * grow); g.closePath(); g.fill();
      }
      g.fillStyle = '#1a1a1f'; g.strokeStyle = hexA(G.neon, G.o.bright); g.lineWidth = R * 0.02;
      g.beginPath(); g.arc(cx, cy, R * 0.13, 0, Math.PI * 2); g.fill(); g.stroke();
      if (G.big) {
        txt(G, G.o.gear ?? '', cx, cy + R * 0.36, R * 0.16, G.neon, { italic: true, glow: R * 0.04 });
        txt(G, speedText(G), cx, cy + R * 0.6, R * 0.17, '#ffffff', { italic: true });
        txt(G, 'MPH', cx, cy + R * 0.77, R * 0.06, G.ink);
      } else { txt(G, valueText(G), cx, cy + R * 0.4, R * 0.2, '#ffffff', { italic: true }); smallTitle(G, cy + R * 0.7); }
    },
  },

  // Angled panel with a curved sweep bar and a big italic readout.
  WEDGE: {
    curve(G, t) { const { w, h } = G; return [w * (0.2 + 0.68 * t), h * (0.66 - 0.3 * (1 - (1 - t) * (1 - t)))]; },
    path(G, t1) { const { g } = G; for (let i = 0; i <= 40; i++) { const t = (i / 40) * t1, [x, y] = EXTRA.WEDGE.curve(G, t); i ? g.lineTo(x, y) : g.moveTo(x, y); } },
    face(G) {
      const { g, w, h } = G;
      g.fillStyle = hexA('#0b0b0e', 0.8); g.strokeStyle = hexA(G.ink, 0.45); g.lineWidth = Math.max(1, h * 0.006);
      g.beginPath(); g.moveTo(w * 0.12, h * 0.2); g.lineTo(w * 0.97, h * 0.2); g.lineTo(w * 0.88, h * 0.86); g.lineTo(w * 0.03, h * 0.86); g.closePath(); g.fill(); g.stroke();
      g.lineCap = 'round'; g.strokeStyle = hexA(G.ink, 0.14); g.lineWidth = h * 0.07; g.beginPath(); EXTRA.WEDGE.path(G, 1); g.stroke();
    },
    live(G) {
      const { g, w, h, f } = G;
      if (f > 0.003) {
        const [x0] = EXTRA.WEDGE.curve(G, 0), [x1] = EXTRA.WEDGE.curve(G, 1), grad = g.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, G.neon); grad.addColorStop(1, '#ffd21a');
        for (const [mul, a] of [[2, 0.15], [1, 1]]) { g.strokeStyle = grad; g.globalAlpha = a * (mul === 1 ? G.o.bright : G.o.glow); g.lineWidth = h * 0.07 * mul; g.beginPath(); EXTRA.WEDGE.path(G, f); g.stroke(); }
        g.globalAlpha = 1;
      }
      if (G.big) {
        g.strokeStyle = hexA(G.ink, 0.7); g.lineWidth = Math.max(1, h * 0.006); g.strokeRect(w * 0.08, h * 0.27, h * 0.16, h * 0.16);
        txt(G, G.o.gear ?? '', w * 0.08 + h * 0.08, h * 0.35, h * 0.12, '#ffffff');
        txt(G, speedText(G), w * 0.6, h * 0.66, Math.min(h * 0.2, w * 0.17), '#ffd21a', { italic: true, glow: h * 0.03 });
        txt(G, 'MPH', w * 0.6, h * 0.8, h * 0.05, G.ink);
      } else { txt(G, valueText(G), w * 0.58, h * 0.7, Math.min(h * 0.2, w * 0.13), '#ffd21a', { italic: true }); txt(G, G.title, w * 0.3, h * 0.3, Math.min(h * 0.09, w * 0.07), G.ink, { font: 'ShareMono' }); }
    },
  },
};
