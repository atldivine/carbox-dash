// Values worked out from the raw signals: gear, trip, peaks, shifts, 0-60 timer.
import { SIGNALS } from './store.js';
import { MPH_PER_MPS, getCar, GEARS_6MT, FINAL_6MT, TIRE_M } from './cars.js';
export { GEARS_6MT, FINAL_6MT, TIRE_M, MPH_PER_MPS };

export class Derived {
  constructor(store, cfg = {}) {
    this.store = store;
    this.setCar(cfg.ratios ? cfg : getCar(cfg.car));
    this.gear = 'N'; this.trip = 0; this.peaks = {}; this.shifts = []; this.history = [];
    this.perf = { state: 'wait', t0: 0, split60: null, last60: null, last100: null, best60: null, best100: null };
    this._lastT = null; this._lastGear = 'N'; this._gearSince = 0; this._real = null;
  }
  // Switches to another car's gearing. `k` is the learned correction (see update()); it starts at 1.
  setCar(car) {
    this.car = car; this.ratios = car.ratios; this.final = car.final; this.tire = car.tire; this.k = 1;
    this.gear = 'N'; this._lastGear = 'N'; this._real = null; this._gearSince = 0;
  }
  // rpm per wheel rpm, divided by the final drive: equals a gear ratio when a gear is engaged.
  _ratio(rpm, mph) { return rpm / (mph / MPH_PER_MPS / this.tire * 60 * this.final); }
  _nearest(ratio) {
    let best = 0;
    this.ratios.forEach((r, i) => { if (Math.abs(r - ratio) < Math.abs(this.ratios[best] - ratio)) best = i; });
    return { i: best, err: Math.abs(this.ratios[best] - ratio) / this.ratios[best] };
  }
  calcGear(rpm, mph) {
    if (rpm == null || mph == null || mph < 3 || rpm < 600) return 'N';
    const { i, err } = this._nearest(this._ratio(rpm, mph) / this.k);
    return err > 0.08 ? 'N' : String(i + 1);
  }
  update(now = performance.now()) {
    const s = this.store, rpm = s.get('rpm'), mph = s.get('speed');
    const dtMs = this._lastT === null ? 0 : now - this._lastT;
    if (this._lastT !== null && mph !== null) this.trip += mph * dtMs / 3600000;
    this._lastT = now;
    const raw = this.calcGear(rpm, mph);
    if (raw !== 'N' && raw === this._lastGear && now - this._gearSince > 1000 && rpm > 1500) {
      // Locked in one gear for a second: nudge the correction toward what this gear really measures
      // (tyre size, speedometer error, wear), so the match stays tight. Clamped to +-8 %.
      const obs = this._ratio(rpm, mph) / this.ratios[+raw - 1];
      this.k = Math.min(1.08, Math.max(0.92, this.k + (obs - this.k) * Math.min(1, dtMs / 4000)));
    }
    if (raw !== this._lastGear) { this._lastGear = raw; this._gearSince = now; }
    else if (raw !== this.gear && now - this._gearSince > 150) {
      if (raw !== 'N' && this._real && raw !== this._real) {            // a shift passes through N (clutch in)
        // The gear only reads as changed ~150 ms after the clutch goes in, when the revs are already
        // falling, so "before" is the peak RPM of the 1.5 s leading up to the shift.
        const recent = this.history.filter(h => now - h.t < 1500).map(h => h.rpm);
        const before = recent.length ? Math.max(...recent) : rpm;
        this.shifts.push({ t: now, from: this._real, to: raw, before, after: rpm });
        if (this.shifts.length > 20) this.shifts.shift();
      }
      if (raw !== 'N') this._real = raw;
      this.gear = raw;
    }
    if (!this.history.length || now - this.history[this.history.length - 1].t > 33) {
      this.history.push({ t: now, rpm: rpm || 0, gear: this.gear });
      if (this.history.length > 600) this.history.shift();
    }
    const snap = s.snapshot();
    for (const k in snap) if (SIGNALS[k] && (!(k in this.peaks) || snap[k] > this.peaks[k])) this.peaks[k] = snap[k];
    this._perf(mph, now);
  }
  _perf(mph, now) {
    const p = this.perf;
    if (mph === null) return;
    if (p.state === 'wait' && mph < 0.5) p.state = 'armed';
    else if (p.state === 'armed' && mph > 1) { p.state = 'running'; p.t0 = now; p.split60 = null; }
    else if (p.state === 'running') {
      const el = (now - p.t0) / 1000;
      if (p.split60 === null && mph >= 60) { p.split60 = p.last60 = el; p.best60 = Math.min(p.best60 ?? 1e9, el); }
      if (mph >= 100) { p.last100 = el; p.best100 = Math.min(p.best100 ?? 1e9, el); p.state = 'done'; }
      else if (mph < 0.5) p.state = 'armed';
    } else if (p.state === 'done' && mph < 0.5) p.state = 'armed';
  }
  resetPeaks() { this.peaks = {}; Object.assign(this.perf, { best60: null, best100: null, last60: null, last100: null }); }
}
