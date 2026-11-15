import { Wire } from './wire.js';

// Visual slip direction is inferred from yaw, not a measured steering angle.
export class DriftView {
  constructor(canvas) {
    this.canvas = canvas;
    this.angle = 0;
    this.wire = new Wire();
    this.wire.target = () => [180 + this.angle, 24, 7.2];
    this.wire.view = 'DRIFT';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.wire.load('data/z-model.json').catch(() => {
      canvas.setAttribute('aria-label', 'Car model unavailable. Live readings remain available.');
    });
  }
  update(sensors, store, now) {
    const dt = this.last == null ? 0 : Math.min(.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const speed = store.get('speed') ?? (sensors.gpsLive ? sensors.gps.mph : null);
    const live = sensors.motionLive && Number.isFinite(speed);
    const target = live && speed > 12 ? Math.sign(sensors.imu.yaw) * sensors.beta : 0;
    this.angle = !live || this.reduced.matches ? target : this.angle + (target - this.angle) * (1 - Math.exp(-dt / .15));
    this.wire.speed = live && !this.reduced.matches ? speed : 0;
    this.wire.color = live ? (sensors.beta > 8 && speed > 12 ? '#ffba49' : '#ff263e') : '#666675';
    // Invalidate the canvas fallback when telemetry changes, just as the GL renderer does.
    this.wire.cacheKey = '';
    const bounds = this.canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(bounds.width * dpr), h = Math.round(bounds.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.wire.draw(this.canvas, w, h, now / 1000);
    if (this.wire.canvas2d) this.canvas = this.wire.canvas2d;
    this.canvas.dataset.live = String(live);
    this.canvas.dataset.angle = this.angle.toFixed(2);
  }
  pause() { this.last = null; this.wire._rt = null; }
}
