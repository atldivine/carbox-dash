// Fake drive for working on the UI: idle, a pull through 1st-4th with real shifts, coast down.
import { MPH_PER_MPS, getCar } from './cars.js';

const FAKE_IDS = [0x160, 0x180, 0x1F9, 0x215, 0x245, 0x284, 0x285, 0x351, 0x355, 0x421, 0x551, 0x6A0];

export class SimSource {
  // carOf: returns the selected car profile, so the fake drive uses that car's gearing and rev limit.
  constructor(store, carOf = () => getCar()) { this.store = store; this.carOf = carOf; this.timer = null; this.reset(); }
  rpmFor(mph, gear) { const c = this.carOf(); return mph / MPH_PER_MPS / c.tire * 60 * c.ratios[gear - 1] * c.final; }
  reset() { this.mph = 0; this.gear = 1; this.rpm = 780; this.phase = 'idle'; this.tPhase = performance.now(); this.clutchUntil = 0; this.last = performance.now(); }
  start() { this.store.source = 'sim'; this.store.status = 'SIM'; this.timer = setInterval(() => this.tick(), 50); }
  stop() { clearInterval(this.timer); this.timer = null; }
  tick() {
    const now = performance.now(), dt = (now - this.last) / 1000; this.last = now;
    const s = this.store, rnd = (a) => (Math.random() * 2 - 1) * a;
    if (s.paused) return;
    let pull = 0;
    const car = this.carOf(), rpmFor = (m, g) => this.rpmFor(m, g), shiftAt = car.rpm.shift - 200, topGear = Math.min(4, car.ratios.length);
    if (this.phase === 'idle') {
      this.mph = 0; this.rpm = 780 + rnd(15);
      if (now - this.tPhase > 4000) { this.phase = 'pull'; this.tPhase = now; this.gear = 1; }
    } else if (this.phase === 'pull') {
      pull = 1;
      if (now < this.clutchUntil) { this.rpm = Math.max(this.rpm - 9000 * dt, rpmFor(this.mph, this.gear)); pull = 0; }
      else {
        this.mph += dt * (9.5 - this.gear * 1.6); this.rpm = Math.max(1500, rpmFor(this.mph, this.gear));
        if (this.rpm > shiftAt && this.gear < topGear) { this.gear++; this.clutchUntil = now + 350; }
        else if (this.gear === topGear && this.rpm > shiftAt - 200) { this.phase = 'coast'; this.tPhase = now; }
      }
    } else {
      this.mph = Math.max(0, this.mph - dt * 6);
      if (this.mph > 18) { this.rpm = rpmFor(this.mph, this.gear); if (this.rpm < 1800 && this.gear > 2) this.gear--; } else this.rpm = 800;
      if (this.mph === 0) { this.phase = 'idle'; this.tPhase = now; }
    }
    const spool = Math.min(1, Math.max(0, (this.rpm - 2200) / 1800)) * pull;
    const t = now / 1000;
    s.set('rpm', this.rpm); s.set('speed', this.mph);
    s.set('boost', (pull ? -11 + spool * 30 : -11.5) + rnd(0.2));
    s.set('afr', (pull ? 14.7 - spool * 3.3 : 14.7) + rnd(0.08));
    s.set('iat', 92 + spool * 24 + Math.sin(t / 40) * 3);
    s.set('coolant', 192 + Math.sin(t / 30) * 4);
    s.set('oil_temp', 214 + spool * 16);
    s.set('ethanol', 38);
    s.set('timing', 22 - spool * 12);
    s.set('knock', spool > 0.9 ? Math.max(0, (Math.random() + Math.random() - 1) * 1.2) : 0);
    s.set('throttle', pull && now >= this.clutchUntil ? 100 : 0);
    s.set('load', pull ? 55 + spool * 45 : 22 + rnd(1));
    s.set('fuel_pressure', 650 + spool * 1850);
    s.set('battery', 14.1 + rnd(0.05));
    for (let i = 0; i < 3; i++) {
      const id = FAKE_IDS[Math.floor(Math.random() * FAKE_IDS.length)];
      s.log(`0x${id.toString(16).toUpperCase().padStart(3, '0')}  ` + Array.from({ length: 8 }, () => Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')).join(' '));
    }
  }
}
