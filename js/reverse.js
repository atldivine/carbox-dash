// Reverse from the phone's motion sensor.
//
// OBD-II can't tell reverse: road speed has no direction, and on the Integra reverse (3.673) is within 1 %
// of 1st (3.643), so RPM vs speed looks the same. The phone can tell: when the car pulls away, the phone
// is pushed forwards or backwards. This learns which way is "forward" for the phone in its mount while
// you drive normally, then on each pull-away checks which way the car actually went.
//
// Feed it: update(t ms, mph from OBD, accel [x, y, z] in m/s^2 without gravity, forward = true while 2nd or a
// higher gear is shown: 1st is left out, it reads the same as reverse on the Integra). Read `.reverse`.
// ios/App/Motion.swift is the same logic in Swift: keep the two in step.
const MPS_PER_MPH = 0.44704;

export class ReverseDetector {
  constructor(saved) {
    this.fwd = saved?.fwd || [0, 0, 0];   // learned forward direction (unnormalised sum)
    this.n = saved?.n || 0;               // how many good samples went into it
    this.reverse = false;
    this._a = [0, 0, 0];                  // smoothed acceleration
    this._v = [];                         // recent OBD speeds for dv/dt
    this._lastT = null;
    this._stoppedSince = null; this._vel = 0; this._decided = false;
  }
  get learned() { return this.n >= 60; }
  get state() { return { fwd: this.fwd, n: this.n }; }

  update(t, mph, acc, forwardGear) {
    const dt = this._lastT === null ? 0 : Math.min(0.2, (t - this._lastT) / 1000);
    this._lastT = t;
    const k = 1 - Math.exp(-dt / 0.25);                      // ~0.25 s smoothing: road bumps and vibration out
    for (let i = 0; i < 3; i++) this._a[i] += (acc[i] - this._a[i]) * k;
    if (mph == null) return this.reverse;

    // dv/dt from OBD speed over ~0.6 s (speed comes in whole km/h steps, so a short span is too noisy)
    this._v.push({ t, mph }); while (this._v.length > 2 && t - this._v[0].t > 600) this._v.shift();
    const v0 = this._v[0], span = (t - v0.t) / 1000;
    const dvdt = span > 0.3 ? (mph - v0.mph) * MPS_PER_MPH / span : 0;

    // Learn: while surely going forwards, the acceleration the phone feels lines up with dv/dt.
    if (forwardGear && mph > 8 && Math.abs(dvdt) > 0.6) {
      const w = Math.sign(dvdt);
      const len = Math.hypot(...this._a);
      if (len > 0.3) {                                        // a clear push, not noise
        for (let i = 0; i < 3; i++) this.fwd[i] = this.fwd[i] * 0.995 + w * this._a[i] / len;   // slowly forgets, so a moved phone re-learns
        this.n = Math.min(10000, this.n + 1);
      }
    }

    // Detect: at a stop, reset; when the car starts moving, add up the push along "forward".
    if (mph < 0.5) {
      if (this._stoppedSince === null) this._stoppedSince = t;
      if (t - this._stoppedSince > 400) { this.reverse = false; this._vel = 0; this._decided = false; }
      return this.reverse;
    }
    this._stoppedSince = null;
    if (!this._decided && this.learned) {
      const f = this._unit();
      if (f) {
        this._vel += (this._a[0] * f[0] + this._a[1] * f[1] + this._a[2] * f[2]) * dt;   // signed speed, m/s
        const real = mph * MPS_PER_MPH;
        if (real >= 0.7) {                                    // ~1.5 mph: enough movement to judge
          if (this._vel < -0.35) { this.reverse = true; this._decided = true; }
          else if (this._vel > 0.35 || real > 4) { this.reverse = false; this._decided = true; }
        }
      }
    }
    if (this.reverse && forwardGear && mph > 6) this.reverse = false;   // clearly in a forward gear: never stuck on R
    return this.reverse;
  }
  _unit() {
    const l = Math.hypot(...this.fwd);
    return l > 1 ? this.fwd.map((x) => x / l) : null;
  }
}
