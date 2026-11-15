// Performance maths on top of the live values: launch timing (0-60, quarter mile ET and trap),
// rev-match scoring on downshifts, a virtual dyno, a drift score and trip stats.
// Estimates only. Use a closed course for timed runs and drifting.
import { GEARS_6MT, FINAL_6MT, TIRE_M, MPH_PER_MPS } from './derive.js';

const G = 9.80665, QUARTER_M = 402.336, LB_KG = 0.453592, GAL_G = 2835;   // grams of gasoline per US gallon
const rpmFor = (mph, gear) => mph / MPH_PER_MPS / TIRE_M * 60 * GEARS_6MT[gear - 1] * FINAL_6MT;

export class Perf {
  constructor(store, derived, sensors, cfg = {}) {
    this.store = store; this.derived = derived; this.sensors = sensors;
    this.weightLb = cfg.weightLb || 3600;           // 2023+ Z ~3,450-3,500 lb + driver
    this.cda = 0.62; this.crr = 0.013; this.loss = 0.10;
    this.launch = { state: 'wait', since: 0, t0: 0, dist: 0, t60: null, et: null, trap: null, best60: cfg.best60 ?? null, bestEt: cfg.bestEt ?? null, bestTrap: cfg.bestTrap ?? null };
    this.rev = { last: null, history: [], blip: [], _free: null, _from: null, _nSince: 0 };
    this.dyno = { runs: [], cur: null, peakHp: null, peakTq: null };
    this.drift = { score: 0, combo: 0, mult: 1, active: false, since: 0, lastOn: 0, best: 0 };
    this.trip = { dist: 0, moving: 0, idle: 0, top: 0, fuelG: 0 };
    this._t = null; this._mph = null; this._speedHist = [];
  }

  update(now = performance.now()) {
    const s = this.store, rpm = s.get('rpm');
    let mph = s.get('speed');
    if (mph == null && this.sensors?.gpsLive) mph = this.sensors.gps.mph;   // GPS fills in when OBD has no speed
    const dt = this._t == null ? 0 : Math.min(0.25, (now - this._t) / 1000);
    this._t = now;
    if (mph != null) { this._speedHist.push([now, mph]); while (this._speedHist.length && now - this._speedHist[0][0] > 700) this._speedHist.shift(); }
    this._launch(mph, now, dt);
    this._revMatch(rpm, mph, now);
    this._dyno(rpm, mph, now);
    this._drift(mph, now, dt);
    this._trip(rpm, mph, dt);
    this._mph = mph;
  }

  /** Acceleration in m/s² from a least-squares slope of the last 0.7 s of speed (OBD speed is coarse). */
  accel() {
    const h = this._speedHist;
    if (h.length < 4) return null;
    const t0 = h[0][0]; let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [t, v] of h) { const x = (t - t0) / 1000, y = v / MPH_PER_MPS; n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const d = n * sxx - sx * sx;
    return d > 1e-6 ? (n * sxy - sx * sy) / d : null;
  }

  _launch(mph, now, dt) {
    const L = this.launch;
    if (mph == null) return;
    if (L.state === 'wait' || L.state === 'done') {
      if (mph < 0.5) { if (!L.since) L.since = now; if (now - L.since > 600) L.state = 'staged'; } else L.since = 0;
    } else if (L.state === 'staged') {
      if (mph > 1) { L.state = 'running'; L.t0 = now - 150; L.dist = 0; L.t60 = null; L.et = null; L.trap = null; }   // ~150 ms of roll-out before 1 mph shows
    } else if (L.state === 'running') {
      L.dist += mph / MPH_PER_MPS * dt;
      const el = (now - L.t0) / 1000;
      if (L.t60 == null && mph >= 60) { L.t60 = el; L.best60 = Math.min(L.best60 ?? 1e9, el); }
      if (L.et == null && L.dist >= QUARTER_M) {
        L.et = el; L.trap = mph; L.state = 'done'; L.since = 0;
        if (L.bestEt == null || el < L.bestEt) { L.bestEt = el; L.bestTrap = mph; }
      }
      if (mph < 0.5 || el > 40) { L.state = mph < 0.5 ? 'staged' : 'done'; L.since = now; }
    }
  }
  launchElapsed(now = performance.now()) { return this.launch.state === 'running' ? (now - this.launch.t0) / 1000 : null; }
  clearTimes() { Object.assign(this.launch, { t60: null, et: null, trap: null, best60: null, bestEt: null, bestTrap: null, state: 'wait', since: 0 }); }

  // Downshift rev-match. When the clutch goes in (revs fit no gear) we record the revs. The new gear
  // counts as engaged once the revs sit within 3% of what it needs for 250 ms. Engaging pulls the revs
  // onto that number, so the score uses the level the driver HELD just before: the steady samples in
  // the 400 ms before the revs settled. No steady samples means the blip rose straight onto target.
  _revMatch(rpm, mph, now) {
    const R = this.rev, raw = this.derived.calcGear(rpm, mph);
    if (R._from == null) {
      if (raw === 'N' && this._lastRaw && this._lastRaw !== 'N') { R._from = +this._lastRaw; R._nSince = now; R.blip = []; R._band = 0; }
      this._lastRaw = raw; return;
    }
    if (rpm != null && mph != null) { R.blip.push([now, rpm, mph]); if (R.blip.length > 300) R.blip.shift(); }
    const to = raw === 'N' ? null : +raw;
    if ((to != null && to >= R._from) || now - R._nSince > 4000 || mph == null || mph < 8) { R._from = null; this._lastRaw = raw; return; }   // no downshift
    if (to == null) { R._band = 0; this._lastRaw = raw; return; }
    const target = rpmFor(mph, to);
    if (Math.abs(rpm - target) / target > 0.03) R._band = 0;
    else if (!R._band) R._band = now;
    else if (now - R._band >= 250) {
      const pre = R.blip.filter(([t]) => t >= R._band - 400 && t < R._band), held = [];
      for (let i = 1; i < pre.length; i++) { const rate = (pre[i][1] - pre[i - 1][1]) / Math.max(1, pre[i][0] - pre[i - 1][0]) * 1000; if (Math.abs(rate) < 3000) held.push(pre[i][1]); }
      let got;
      if (held.length >= 2) { held.sort((x, y) => x - y); got = held[held.length >> 1]; }
      else got = Math.max(target, ...R.blip.filter(([t]) => t >= R._band).map((b) => b[1]));   // straight onto target; count any overshoot
      const errPct = (got - target) / target * 100, score = Math.max(0, Math.round(100 - Math.abs(errPct) * 6));
      const verdict = score >= 90 ? 'PERFECT' : score >= 75 ? 'CLEAN' : score >= 55 ? 'GOOD' : errPct < 0 ? 'TOO LOW' : 'TOO HIGH';
      R.last = { from: R._from, to, score, verdict, target: Math.round(target), got: Math.round(got), t: now, blip: R.blip.filter(([t]) => t <= now).map(([t, v]) => [t, v]) };
      R.history.unshift(R.last); if (R.history.length > 8) R.history.pop();
      R._from = null;
    }
    this._lastRaw = raw;
  }

  // Virtual dyno: a pull is full throttle in one gear. Power at the wheels = (mass * accel + drag +
  // rolling resistance) * speed; engine power adds the drivetrain loss; torque = power / engine speed.
  _dyno(rpm, mph, now) {
    const D = this.dyno, thr = this.store.get('throttle'), gear = this.derived.gear;
    const pulling = thr != null && thr > 85 && gear !== 'N' && rpm != null && mph != null && mph > 5;
    if (pulling) {
      if (!D.cur || D.cur.gear !== gear) this._endRun(), D.cur = { gear, pts: {}, start: now, minRpm: rpm, maxRpm: rpm };
      let a = this.accel();
      if (this.sensors?.motionLive && a != null) a = (a + this.sensors.imu.lon * G) / 2;   // blend in the phone's accelerometer
      if (a == null || a <= 0) return;
      const m = this.weightLb * LB_KG, v = mph / MPH_PER_MPS;
      const wheelW = (m * a + 0.5 * 1.204 * this.cda * v * v + this.crr * m * G) * v;
      const crankW = wheelW / (1 - this.loss);
      const hp = wheelW / 745.7, tq = crankW / (rpm * 2 * Math.PI / 60) * 0.737562;   // lb-ft at the crank
      const bin = Math.round(rpm / 100) * 100, p = D.cur.pts[bin];
      D.cur.pts[bin] = p ? { hp: (p.hp + hp) / 2, tq: (p.tq + tq) / 2 } : { hp, tq };
      D.cur.minRpm = Math.min(D.cur.minRpm, rpm); D.cur.maxRpm = Math.max(D.cur.maxRpm, rpm);
    } else if (D.cur) this._endRun();
  }
  _endRun() {
    const D = this.dyno, r = D.cur; D.cur = null;
    if (!r || r.maxRpm - r.minRpm < 1500) return;
    const bins = Object.keys(r.pts).map(Number).sort((a, b) => a - b);
    // 3-bin moving average: OBD speed steps make single bins jumpy
    const pts = bins.map((b, i) => {
      const nb = bins.slice(Math.max(0, i - 1), i + 2).map((x) => r.pts[x]);
      return { rpm: b, hp: nb.reduce((s, p) => s + p.hp, 0) / nb.length, tq: nb.reduce((s, p) => s + p.tq, 0) / nb.length };
    });
    const pk = pts.reduce((a, p) => (p.hp > a.hp ? p : a)), pt = pts.reduce((a, p) => (p.tq > a.tq ? p : a));
    D.runs.unshift({ gear: r.gear, pts, peakHp: pk, peakTq: pt, at: Date.now() }); if (D.runs.length > 3) D.runs.pop();
    D.peakHp = D.runs.reduce((a, x) => (!a || x.peakHp.hp > a.hp ? x.peakHp : a), null);
    D.peakTq = D.runs.reduce((a, x) => (!a || x.peakTq.tq > a.tq ? x.peakTq : a), null);
  }
  clearDyno() { this.dyno.runs = []; this.dyno.cur = null; this.dyno.peakHp = this.dyno.peakTq = null; }

  // Drift score: points for angle x speed while sliding; holding a drift raises the multiplier (x1-x5).
  _drift(mph, now, dt) {
    const D = this.drift, beta = this.sensors?.motionLive ? this.sensors.beta : 0;
    const on = beta > 8 && (mph || 0) > 12;
    if (on) {
      if (!D.active) { D.active = true; D.since = now; D.combo = 0; }
      D.mult = Math.min(5, 1 + Math.floor((now - D.since) / 2000));
      const pts = beta * (mph / 10) * dt * D.mult;
      D.combo += pts; D.score += pts; D.lastOn = now;
    } else if (D.active && now - D.lastOn > 1000) { D.active = false; D.mult = 1; D.best = Math.max(D.best, D.combo); }
  }
  resetDrift() { Object.assign(this.drift, { score: 0, combo: 0, mult: 1, active: false, best: 0 }); }

  _trip(rpm, mph, dt) {
    const T = this.trip;
    if (!dt) return;
    if (mph != null && mph > 1) { T.moving += dt; T.dist += mph * dt / 3600; T.top = Math.max(T.top, mph); }
    else if (rpm != null && rpm > 300) T.idle += dt;
    const maf = this.store.get('maf');
    if (maf != null) { const lam = this.store.get('lambda') ?? 1; T.fuelG += maf / (14.7 * lam) * dt; }
  }
  get tripStats() {
    const T = this.trip, gal = T.fuelG / GAL_G;
    return { miles: T.dist, moving: T.moving, idle: T.idle, top: T.top, avg: T.moving > 5 ? T.dist / (T.moving / 3600) : null, gallons: T.fuelG ? gal : null, mpg: gal > 0.01 ? T.dist / gal : null };
  }
  resetTrip() { this.trip = { dist: 0, moving: 0, idle: 0, top: 0, fuelG: 0 }; }
}
