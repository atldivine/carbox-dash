// Values worked out from the raw signals: gear, trip, peaks, shifts, 0-60 timer.
import { SIGNALS } from './store.js';

export const GEARS_6MT = [3.794, 2.324, 1.624, 1.271, 1.000, 0.794];
export const FINAL_6MT = 3.692, TIRE_M = 2.121, MPH_PER_MPS = 2.23694;

export class Derived {
  constructor(store, cfg = {}) {
    this.store = store;
    this.ratios = cfg.ratios || GEARS_6MT; this.final = cfg.final || FINAL_6MT; this.tire = cfg.tire || TIRE_M;
    this.gear = 'N'; this.trip = 0; this.peaks = {}; this.shifts = []; this.history = [];
    this.perf = { state: 'wait', t0: 0, split60: null, last60: null, last100: null, best60: null, best100: null };
    this._lastT = null; this._lastGear = 'N'; this._gearSince = 0; this._real = null;
  }
  calcGear(rpm, mph) {
    if (rpm == null || mph == null || mph < 3 || rpm < 600) return 'N';
    const wheelRpm = mph / MPH_PER_MPS / this.tire * 60;
    const ratio = rpm / (wheelRpm * this.final);
    let best = 0;
    this.ratios.forEach((r, i) => { if (Math.abs(r - ratio) < Math.abs(this.ratios[best] - ratio)) best = i; });
    return Math.abs(this.ratios[best] - ratio) / this.ratios[best] > 0.08 ? 'N' : String(best + 1);
  }
  update(now = performance.now()) {
    const s = this.store, rpm = s.get('rpm'), mph = s.get('speed');
    if (this._lastT !== null && mph !== null) this.trip += mph * (now - this._lastT) / 3600000;
    this._lastT = now;
    const raw = this.calcGear(rpm, mph);
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
