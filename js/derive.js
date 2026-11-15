// Values worked out from the raw signals: gear, trip, peaks, shifts, 0-60 timer.
import { SIGNALS } from './store.js';

// Nissan Z (RZ34, 2023+). Nissan spec: 6-speed manual 3.538 final drive, 9-speed automatic 3.133.
// (3.692 is the 370Z's final drive; using it put every gear ~4% off, so most samples read as N.)
export const TRANSMISSIONS = {
  '6MT': { ratios: [3.794, 2.324, 1.624, 1.271, 1.000, 0.794], final: 3.538 },
  '9AT': { ratios: [5.425, 3.263, 2.249, 1.649, 1.221, 1.000, 0.862, 0.713, 0.597], final: 3.133 },
};
export const GEARS_6MT = TRANSMISSIONS['6MT'].ratios, FINAL_6MT = TRANSMISSIONS['6MT'].final;
export const TIRE_M = 2.121, MPH_PER_MPS = 2.23694;   // 275/35R19 rear: 675 mm diameter

export class Derived {
  /** cfg.trans: 'auto' (detect from driving), '6MT' or '9AT'. */
  constructor(store, cfg = {}) {
    this.store = store; this.tire = cfg.tire || TIRE_M;
    this.transPref = cfg.trans || 'auto';
    this.trans = this.transPref === 'auto' ? (cfg.detected || '6MT') : this.transPref;
    this.scale = { '6MT': cfg.scale6 || 1, '9AT': cfg.scale9 || 1 };   // learned tyre / speedometer correction
    this.samples = [];          // overall ratios seen while driving (for calibration + detection)
    this.gear = 'N'; this.trip = 0; this.peaks = {}; this.shifts = []; this.history = [];
    this.perf = { state: 'wait', t0: 0, split60: null, last60: null, last100: null, best60: null, best100: null };
    this._lastT = null; this._cand = null; this._candN = 0; this._real = null; this._lastSample = null; this._sinceCal = 0;
  }
  get ratios() { return TRANSMISSIONS[this.trans].ratios; }
  get final() { return TRANSMISSIONS[this.trans].final; }
  setTransmission(pref) { this.transPref = pref; if (pref !== 'auto') this.trans = pref; this._cand = null; }
  /** Engine rpm a gear gives at a road speed (with the learned correction). */
  rpmFor(mph, gear) {
    const r = this.ratios[gear - 1];
    return r == null || mph == null ? null : mph / MPH_PER_MPS / this.tire * 60 * r * this.final * this.scale[this.trans];
  }
  /** Overall ratio engine:wheel, or null when the car is too slow to tell. */
  overall(rpm, mph) { return rpm == null || mph == null || mph < 3 || rpm < 600 ? null : rpm / (mph / MPH_PER_MPS / this.tire * 60); }
  /** Best gear for a sample: { gear: '1'..'9' | 'N', err }. Tolerance 7%; the speed reading moves in
   *  0.62 mph steps (1 km/h), so it is looser below 15 mph. */
  match(rpm, mph, trans = this.trans) {
    const R = this.overall(rpm, mph);
    if (R == null) return { gear: 'N', err: 1 };
    const t = TRANSMISSIONS[trans], k = t.final * this.scale[trans];
    let best = 0, err = Infinity;
    t.ratios.forEach((r, i) => { const e = Math.abs(R / (r * k) - 1); if (e < err) { err = e; best = i; } });
    const tol = 0.07 + (mph < 15 ? 0.31 / mph : 0);
    return err > tol ? { gear: 'N', err } : { gear: String(best + 1), err };
  }
  calcGear(rpm, mph) { return this.match(rpm, mph).gear; }
  // Learn the correction factor (and, in auto mode, which gearbox) from what the car actually does:
  // the scale that lines the most samples up with real gears wins. Clutch-in and shifting samples
  // fit nothing and simply don't count.
  _learn(R) {
    this.samples.push(R); if (this.samples.length > 400) this.samples.shift();
    if (++this._sinceCal < 25 || this.samples.length < 40) return;
    this._sinceCal = 0;
    const fit = (trans) => {
      const t = TRANSMISSIONS[trans]; let bestS = 1, bestN = -1;
      for (let sc = 0.94; sc <= 1.0601; sc += 0.0025) {
        let n = 0;
        for (const x of this.samples) { for (const r of t.ratios) if (Math.abs(x / (r * t.final * sc) - 1) < 0.02) { n++; break; } }
        if (n > bestN || (n === bestN && Math.abs(sc - 1) < Math.abs(bestS - 1))) { bestN = n; bestS = sc; }
      }
      return { s: bestS, n: bestN };
    };
    const a = fit('6MT'), b = fit('9AT');
    this.scale['6MT'] = a.s; this.scale['9AT'] = b.s;
    if (this.transPref === 'auto' && this.samples.length >= 80) {
      // The 9AT has more, closer ratios, so it fits random samples more easily: make it win clearly.
      const pick = b.n > a.n * 1.25 ? '9AT' : a.n >= b.n * 0.9 ? '6MT' : this.trans;
      this.trans = pick;
    }
    this.fitInfo = { '6MT': a, '9AT': b, samples: this.samples.length };
  }
  update(now = performance.now()) {
    const s = this.store, rpm = s.get('rpm'), mph = s.get('speed');
    if (this._lastT !== null && mph !== null) this.trip += mph * (now - this._lastT) / 3600000;
    this._lastT = now;
    // Gear decisions run once per NEW rpm/speed sample (the adapter sends ~7 a second), not per
    // frame, so a change shows on the very next reading instead of after a fixed delay.
    // The iPhone app also re-sends the latest values on a 10 Hz timer, so a reading only counts as new when it differs.
    const stamp = rpm + '|' + mph;
    if (rpm != null && mph != null && stamp !== this._lastSample) {
      this._lastSample = stamp;
      const m = this.match(rpm, mph), R = this.overall(rpm, mph);
      if (R != null && rpm > 900 && mph > 6) this._learn(R);
      if (m.gear === this._cand) this._candN++; else { this._cand = m.gear; this._candN = 1; }
      // A clean match (within 3%) one gear from the last real gear switches at once; anything else,
      // N included, needs a second reading. A jump of 2+ gears needs a third: with the clutch in, the
      // falling revs pass through other gears' rpm for a moment and must not show as a shift.
      const jump = m.gear !== 'N' && this._real ? Math.abs(+m.gear - +this._real) : 1;
      const need = jump > 1 ? 3 : m.gear !== 'N' && m.err < 0.03 ? 1 : 2;
      if (m.gear !== this.gear && this._candN >= need) {
        if (m.gear !== 'N' && this._real && m.gear !== this._real) {
          // "before" = peak rpm of the 1.5 s before the change (the revs are already falling when it shows)
          const recent = this.history.filter(h => now - h.t < 1500).map(h => h.rpm);
          const before = recent.length ? Math.max(...recent) : rpm;
          this.shifts.push({ t: now, from: this._real, to: m.gear, before, after: rpm });
          if (this.shifts.length > 20) this.shifts.shift();
        }
        if (m.gear !== 'N') this._real = m.gear;
        this.gear = m.gear;
      }
    } else if (rpm == null || mph == null) { this.gear = 'N'; this._cand = null; }
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
