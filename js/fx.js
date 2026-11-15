// Background: slow-drifting glowing particles in the accent colour behind translucent panels.
// One pre-rendered glow sprite, drawn scaled per particle (cheap: ~70 drawImage calls a frame at
// 30 fps). Reduced motion: drawn once, standing still.

export class Particles {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.color = '#ff263e'; this.p = []; this.sprite = null; this.spriteColor = '';
    this.still = matchMedia('(prefers-reduced-motion: reduce)').matches; this._last = 0; this.boost = 0;
  }
  _sprite() {
    if (this.sprite && this.spriteColor === this.color) return this.sprite;
    const s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.12, this.color); rg.addColorStop(0.4, this.color + '55'); rg.addColorStop(1, this.color + '00');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    this.sprite = s; this.spriteColor = this.color; return s;
  }
  _fit() {
    const d = Math.min(2, devicePixelRatio || 1), w = Math.round(innerWidth * d), h = Math.round(innerHeight * d);
    if (this.cv.width !== w || this.cv.height !== h) {
      this.cv.width = w; this.cv.height = h; this.d = d;
      const n = Math.round(Math.min(90, (innerWidth * innerHeight) / 9000));
      this.p = Array.from({ length: n }, () => this._spawn(w, h, true));
    }
    return [w, h];
  }
  _spawn(w, h, anywhere) {
    const depth = Math.random();   // far particles: small, dim, slow
    return { x: Math.random() * w, y: anywhere ? Math.random() * h : h + 20, r: (1.2 + depth * 4.5) * this.d, v: (6 + depth * 18) * this.d,
      a: 0.25 + depth * 0.6, ph: Math.random() * 6.28, sw: 8 + Math.random() * 20 };
  }
  /** speedFactor 0..1 (e.g. throttle) makes them rise faster. */
  frame(now, speedFactor = 0) {
    if (now - this._last < 30 && !this.still) return;   // ~30 fps is plenty for a background
    const dt = Math.min(0.1, (now - (this._last || now)) / 1000); this._last = now;
    const [w, h] = this._fit(), c = this.ctx, sp = this._sprite();
    this.boost += (speedFactor - this.boost) * Math.min(1, dt * 2);
    c.clearRect(0, 0, w, h);
    c.globalCompositeOperation = 'lighter';
    for (const p of this.p) {
      if (!this.still) { p.y -= p.v * dt * (1 + this.boost * 3); p.ph += dt * 0.7; if (p.y < -20) Object.assign(p, this._spawn(w, h, false)); }
      const x = p.x + Math.sin(p.ph) * p.sw * this.d, tw = 0.7 + 0.3 * Math.sin(p.ph * 2.3);
      const size = p.r * 6;
      c.globalAlpha = p.a * tw; c.drawImage(sp, x - size / 2, p.y - size / 2, size, size);
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
}

/** Shift banner over the gear box: "4→3 · CLEAN · 83". Springs in, holds, fades. */
export function showShift(el, html, tone) {
  el.innerHTML = html;
  el.className = 'shiftpop ' + (tone || '');
  void el.offsetWidth;   // restart the animation
  el.classList.add('in');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('in'), 2200);
}
