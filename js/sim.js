// Fake drive for working on the UI: idle, a pull through 1st-4th with real shifts, coast down.
import { GEARS_6MT, FINAL_6MT, TIRE_M, MPH_PER_MPS } from './derive.js';

const rpmFor = (mph, gear) => mph / MPH_PER_MPS / TIRE_M * 60 * GEARS_6MT[gear - 1] * FINAL_6MT;
const FAKE_IDS = [0x160, 0x180, 0x1F9, 0x215, 0x245, 0x284, 0x285, 0x351, 0x355, 0x421, 0x551, 0x6A0];

export class SimSource {
  constructor(store) { this.store = store; this.timer = null; this.reset(); }
  reset() { this.mph = 0; this.gear = 1; this.rpm = 780; this.phase = 'idle'; this.tPhase = performance.now(); this.clutchUntil = 0; this.last = performance.now(); }
  start() { this.store.source = 'sim'; this.store.status = 'SIM'; this.timer = setInterval(() => this.tick(), 50); }
  stop() { clearInterval(this.timer); this.timer = null; }
  tick() {
    const now = performance.now(), dt = (now - this.last) / 1000; this.last = now;
    const s = this.store, rnd = (a) => (Math.random() * 2 - 1) * a;
    if (s.paused) return;
    let pull = 0;
    if (this.phase === 'idle') {
      this.mph = 0; this.rpm = 780 + rnd(15);
      if (now - this.tPhase > 4000) { this.phase = 'pull'; this.tPhase = now; this.gear = 1; }
    } else if (this.phase === 'pull') {
      pull = 1;
      if (now < this.clutchUntil) { this.rpm = Math.max(this.rpm - 9000 * dt, rpmFor(this.mph, this.gear)); pull = 0; }
      else {
        this.mph += dt * (9.5 - this.gear * 1.6); this.rpm = Math.max(1500, rpmFor(this.mph, this.gear));
        if (this.rpm > 6600 && this.gear < 4) { this.gear++; this.clutchUntil = now + 350; }
        else if (this.gear === 4 && this.rpm > 6400) { this.phase = 'coast'; this.tPhase = now; }
      }
    } else {
      this.mph = Math.max(0, this.mph - dt * 6);
      if (now < this.clutchUntil) {
        // downshift with a throttle blip: revs climb toward what the lower gear needs (slightly off)
        const target = rpmFor(this.mph, this.gear) * this.blipErr;
        this.rpm += (target - this.rpm) * Math.min(1, dt * 9);
      } else if (this.mph > 18) {
        this.rpm = rpmFor(this.mph, this.gear);
        if (this.rpm < 2600 && this.gear > 2) { this.gear--; this.clutchUntil = now + 450; this.blipErr = 0.94 + Math.random() * 0.1; }
      } else this.rpm = 800;
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
    s.set('fuel_pressure', 650 + spool * 1850);
    s.set('battery', 14.1 + rnd(0.05));
    s.set('maf', 3.5 + this.rpm / 7000 * (pull ? 180 * (0.3 + spool) : 12) + rnd(0.4));
    s.set('stft', rnd(2.5) + (pull ? -1.5 : 0.8));
    s.set('ltft', 2.3 + Math.sin(t / 50) * 0.4);
    s.set('lambda', s.get('afr') / 14.7); s.set('lambda_cmd', pull ? 1 - spool * 0.22 : 1);
    for (let i = 0; i < 3; i++) {
      const id = FAKE_IDS[Math.floor(Math.random() * FAKE_IDS.length)];
      s.log(`0x${id.toString(16).toUpperCase().padStart(3, '0')}  ` + Array.from({ length: 8 }, () => Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')).join(' '));
    }
  }
}
