// Values worked out from the raw signals: gear, trip, peaks, shifts, 0-60 timer.
import { SIGNALS } from './store.js';
import { MPH_PER_MPS, getCar, GEARS_6MT, FINAL_6MT, TIRE_M } from './cars.js';
export { GEARS_6MT, FINAL_6MT, TIRE_M, MPH_PER_MPS };

// Gear from RPM vs road speed. A gear is only taken once the ratio has been steady for a moment
// (so the sweep of revs while the clutch is in can't flash other gears), and the shown gear is held
// through the shift itself, so it goes 2 -> 3 directly instead of 2 -> N -> 4 -> 3.
const STABLE_MS = 100;     // ratio steady this long (3 OBD samples) = clutch is out, a gear is engaged
const DWELL_MS = 40;       // a new gear must hold this long before it shows
const HOLD_MS = 1200;      // clutch in / coasting longer than this shows N

/** Allowed ratio error for a match. OBD speed comes in whole km/h, so at low speed the ratio is off by
 *  up to 0.5/kmh; the tolerance widens to cover that. */
export const gearTol = (mph) => Math.min(0.12, 0.035 + 0.6 / Math.max(1, mph / 0.621371));

export class Derived {
  constructor(store, cfg = {}) {
    this.store = store;
    this.gear = 'N'; this.trip = 0; this.peaks = {}; this.shifts = []; this.history = [];
    this.perf = { state: 'wait', t0: 0, split60: null, last60: null, last100: null, best60: null, best100: null };
    this._lastT = null;
    this.reverse = false;   // set from outside (iPhone motion sensor, see js/reverse.js): car is moving backwards
    this.setCar(cfg.ratios ? cfg : getCar(cfg.car));
  }
  // Switches to another car's gearing. `k` is the learned correction (see _learn()); it starts at 1.
  setCar(car) {
    this.car = car; this.ratios = car.ratios; this.final = car.final; this.tire = car.tire; this.k = 1;
    this.gear = 'N'; this._real = null; this._cand = null; this._candSince = 0; this._lostSince = null; this._ratios = []; this._rpmHist = [];
  }
  // RPM as it was at time t. On adapters that read one value at a time, speed can be ~150 ms older than
  // RPM; under hard acceleration that alone puts the ratio 10 %+ off. Comparing speed with the RPM from
  // the same moment fixes it.
  _rpmAt(t) {
    const h = this._rpmHist;
    if (!h.length) return null;
    if (t >= h[h.length - 1].t) return h[h.length - 1].v;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (t >= a.t) return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
    }
    return h[0].v;
  }
  // rpm per wheel rpm, divided by the final drive: equals a gear ratio when a gear is engaged.
  _ratio(rpm, mph) { return rpm / (mph / MPH_PER_MPS / this.tire * 60 * this.final); }
  _nearest(ratio) {
    let best = 0;
    this.ratios.forEach((r, i) => { if (Math.abs(r - ratio) < Math.abs(this.ratios[best] - ratio)) best = i; });
    return { i: best, err: Math.abs(this.ratios[best] - ratio) / this.ratios[best] };
  }
  /** One-shot match with no history (tests, other callers). */
  calcGear(rpm, mph) {
    if (rpm == null || mph == null || mph < 3 || rpm < 600) return 'N';
    const { i, err } = this._nearest(this._ratio(rpm, mph) / this.k);
    return err > gearTol(mph) ? 'N' : String(i + 1);
  }
  // The gear the ratio has steadily matched for the last STABLE_MS, or null while it is moving
  // (clutch in, shifting, wheelspin). Also learns the correction while the ratio is steady.
  _engaged(rpm, mph, now, dtMs) {
    const h = this._ratios;
    if (rpm == null || mph == null || mph < 2 || rpm < 600) { h.length = 0; return null; }
    const r = this._ratio(rpm, mph) / this.k;
    if (!h.length || h[h.length - 1].rpm !== rpm || h[h.length - 1].mph !== mph) h.push({ t: now, r, rpm, mph });
    while (h.length > 2 && now - h[1].t > STABLE_MS) h.shift();
    if (now - h[0].t < STABLE_MS * 0.6 && h.length < 3) return null;   // not enough history yet
    const tol = gearTol(mph);
    let lo = Infinity, hi = 0; for (const x of h) { lo = Math.min(lo, x.r); hi = Math.max(hi, x.r); }
    if ((hi - lo) / ((hi + lo) / 2) > tol) return null;                 // still sweeping
    const { i, err } = this._nearest(r);
    // A steady ratio means a gear is engaged, even if it sits a few % off the book value (bigger tyres,
    // speedo error). Gears are 15 %+ apart, so within 9 % the gear is unambiguous: learn the offset.
    if (err <= 0.09 && mph >= 15 && rpm >= 1500) {
      const obs = this._ratio(rpm, mph) / this.ratios[i];
      this.k = Math.min(1.08, Math.max(0.92, this.k + (obs - this.k) * Math.min(1, dtMs / 3000)));
    }
    return err <= tol ? i + 1 : null;
  }
  _show(g, rpm, now) {
    if (g === this.gear) return;
    if (/^\d$/.test(g) && this._real && g !== this._real) {
      // "before" is the peak RPM of the 1.5 s leading up to the shift (revs drop as the clutch goes in).
      const recent = this.history.filter((h) => now - h.t < 1500).map((h) => h.rpm);
      this.shifts.push({ t: now, from: this._real, to: g, before: recent.length ? Math.max(...recent) : rpm, after: rpm });
      if (this.shifts.length > 20) this.shifts.shift();
    }
    if (/^\d$/.test(g)) this._real = g;
    this.gear = g;
  }
  update(now = performance.now()) {
    const s = this.store, rpm = s.get('rpm'), mph = s.get('speed');
    const dtMs = this._lastT === null ? 0 : now - this._lastT;
    if (this._lastT !== null && mph !== null) this.trip += mph * dtMs / 3600000;
    this._lastT = now;

    const R = s.v.rpm, S = s.v.speed, h = this._rpmHist;
    if (R && (!h.length || h[h.length - 1].t !== R[1])) { h.push({ t: R[1], v: R[0] }); if (h.length > 40) h.shift(); }
    const rpmSync = rpm != null && mph != null && S ? this._rpmAt(S[1]) : rpm;
    const g = this._engaged(rpmSync, mph, now, dtMs);
    if (this.reverse && mph != null && mph >= 0.5) { this._show('R', rpm, now); this._cand = null; this._lostSince = null; }
    else if (g) {
      this._lostSince = null;
      const cur = String(g);
      if (cur === this.gear) this._cand = null;
      else if (this._cand !== cur) { this._cand = cur; this._candSince = now; }
      else if (now - this._candSince >= DWELL_MS) { this._show(cur, rpm, now); this._cand = null; }
    } else {
      this._cand = null;
      if (mph == null || mph < 2) { if (!this.reverse) this._show('N', rpm, now); }
      else if (this._lostSince === null) this._lostSince = now;
      else if (now - this._lostSince > HOLD_MS) this._show('N', rpm, now);   // coasting with the clutch in
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
