// The phone's own sensors: motion (G-forces, yaw rate, level) and GPS (speed, position, heading).
// Inputs come from the browser (DeviceMotion / Geolocation) or, inside the iPhone app, from
// CoreMotion / CoreLocation pushed in by native code. Everything is turned into the CAR's frame:
// forward, left and up, so the phone can sit in any mount.

const G = 9.80665;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const l = Math.hypot(...a); return l > 1e-9 ? scale(a, 1 / l) : null; };
const flat = (v, up) => norm(sub(v, scale(up, dot(v, up))));   // v projected onto the horizontal plane

export class Sensors {
  constructor() {
    this.imu = null;        // { lat, lon, yaw, up, t } in g / deg/s, car frame
    this.gps = null;        // { lat, lon, mph, heading, acc, t }
    this.peakG = 0;
    this.beta = 0;          // estimated drift (slip) angle, degrees
    this.level = null;      // { pitch, roll } degrees vs. the calibrated rest position
    this.trace = [];        // recent { t, lat, lon, yaw } for the Handling graph
    this.cal = this._loadCal();
    this.learn = [0, 0, 0]; // forward-axis learning from speed changes
    this._f = null; this._lastV = null; this._lastT = 0;
    this.webOn = false; this.native = false;
  }
  _loadCal() { try { return JSON.parse(localStorage.getItem('carbox-imu') || 'null'); } catch { return null; } }
  _saveCal() { try { localStorage.setItem('carbox-imu', JSON.stringify(this.cal)); } catch { /* private mode */ } }

  get motionLive() { return !!this.imu && performance.now() - this.imu.t < 1500; }
  get gpsLive() { return !!this.gps && performance.now() - this.gps.t < 5000; }

  /** Forward axis in device coordinates: learned from launches/braking, else the saved one, else
   *  "out of the back of the phone" (a phone in a dash mount facing the driver). */
  _forward(up) {
    if (Math.hypot(...this.learn) > 3) return flat(this.learn, up);
    if (this.cal?.f) return flat(this.cal.f, up);
    return flat([0, 0, -1], up) || flat([0, 1, 0], up);
  }

  /** One motion sample. userAcc and gravity in g, device axes; rot in rad/s; carMph from OBD or GPS. */
  feed(userAcc, gravity, rot, carMph) {
    const now = performance.now(), dt = this._lastT ? Math.min(0.2, (now - this._lastT) / 1000) : 0;
    this._lastT = now;
    const up = norm(scale(gravity, -1));
    if (!up) return;
    const f = this._forward(up) || [0, 0, -1], l = cross(up, f);
    // Learn which way is forward: horizontal acceleration while the speed clearly rises or falls.
    if (carMph != null && this._lastV != null && dt > 0) {
      const dv = (carMph - this._lastV) / 2.23694 / dt / G;   // g
      const h = sub(userAcc, scale(up, dot(userAcc, up)));
      if (Math.abs(dv) > 0.12 && Math.hypot(...h) > 0.08) {
        this.learn = sub(this.learn, scale(this.learn, 0.002));
        this.learn = [this.learn[0] + h[0] * Math.sign(dv), this.learn[1] + h[1] * Math.sign(dv), this.learn[2] + h[2] * Math.sign(dv)];
        if (Math.hypot(...this.learn) > 3 && (!this.cal || !this.cal.learned)) { this.cal = { ...(this.cal || {}), f: norm(this.learn), learned: true }; this._saveCal(); }
      }
    }
    if (carMph != null) this._lastV = carMph;
    const k = this.imu ? 1 - Math.exp(-dt / 0.08) : 1;          // light smoothing (80 ms)
    const raw = { lon: dot(userAcc, f), lat: -dot(userAcc, l), yaw: dot(rot, up) * 180 / Math.PI };   // lat: + = pushed right
    const p = this.imu || raw;
    this.imu = { lon: p.lon + (raw.lon - p.lon) * k, lat: p.lat + (raw.lat - p.lat) * k, yaw: p.yaw + (raw.yaw - p.yaw) * k, t: now };
    this.peakG = Math.max(this.peakG, Math.hypot(this.imu.lon, this.imu.lat));
    // Level: tilt of gravity against the calibrated rest position, along the car's axes.
    const g0 = this.cal?.g ? norm(this.cal.g) : null;
    if (g0) {
      const d = sub(up, scale(g0, -1));
      this.level = { pitch: Math.asin(Math.max(-1, Math.min(1, dot(d, f)))) * 180 / Math.PI, roll: Math.asin(Math.max(-1, Math.min(1, dot(d, l)))) * 180 / Math.PI };
    } else this.level = { pitch: Math.asin(Math.max(-1, Math.min(1, dot(up, f)))) * -180 / Math.PI, roll: Math.asin(Math.max(-1, Math.min(1, dot(up, l)))) * 180 / Math.PI };
    // Drift angle estimate: in a clean corner the yaw rate equals lateral accel / speed. The body
    // rotating faster than that is the tail stepping out. Integrated, with a leak so it can't run away.
    const v = (carMph || 0) / 2.23694;
    if (v > 6 && dt > 0) {
      const expected = this.imu.lat * G / v * 180 / Math.PI;   // deg/s
      this.beta += (Math.abs(this.imu.yaw) - Math.abs(expected)) * dt;
      this.beta = Math.max(0, Math.min(60, this.beta * Math.exp(-dt / 1.2)));
    } else this.beta *= Math.exp(-dt / 0.3);
    this.trace.push({ t: now, lat: this.imu.lat, lon: this.imu.lon, yaw: this.imu.yaw });
    while (this.trace.length && now - this.trace[0].t > 10000) this.trace.shift();
  }

  feedGps(lat, lon, mps, heading, acc) {
    this.gps = { lat, lon, mph: mps != null && mps >= 0 ? mps * 2.23694 : null, heading, acc, t: performance.now() };
  }

  /** Parked and level: remember gravity as "flat", start learning forward again. */
  calibrate(gravity) {
    const g = gravity || this._lastGravity;
    if (!g) return false;
    this.cal = { g: scale(g, -1), f: null }; this.learn = [0, 0, 0]; this.peakG = 0; this._saveCal();
    return true;
  }

  /** Browser sensors (needs a tap on iPhone Safari to allow motion). */
  async enableWeb() {
    if (this.native) return 'native';
    try { if (typeof DeviceMotionEvent?.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') return 'denied'; } catch { /* not iOS */ }
    if (!this.webOn) {
      this.webOn = true;
      addEventListener('devicemotion', (e) => {
        const ai = e.accelerationIncludingGravity, a = e.acceleration, r = e.rotationRate;
        if (!ai || ai.x == null) return;
        // iOS reports in g-relative m/s² with gravity pointing -y when upright; keep device axes as given.
        const grav = a && a.x != null ? [(ai.x - a.x) / G, (ai.y - a.y) / G, (ai.z - a.z) / G] : [ai.x / G, ai.y / G, ai.z / G];
        const user = a && a.x != null ? [a.x / G, a.y / G, a.z / G] : [0, 0, 0];
        const rot = r ? [(r.beta || 0) * Math.PI / 180, (r.gamma || 0) * Math.PI / 180, (r.alpha || 0) * Math.PI / 180] : [0, 0, 0];
        this._lastGravity = grav;
        this.feed(user, grav, rot, this.carMph?.());
      });
      navigator.geolocation?.watchPosition((p) => this.feedGps(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.heading, p.coords.accuracy),
        () => {}, { enableHighAccuracy: true, maximumAge: 0 });
    }
    return 'ok';
  }

  /** Native push: { imu: { a:[x,y,z], g:[x,y,z], r:[x,y,z] }, gps: { lat, lon, mps, hdg, acc } }. */
  push(p, carMph) {
    this.native = true;
    if (p.imu) { this._lastGravity = p.imu.g; this.feed(p.imu.a, p.imu.g, p.imu.r, carMph); }
    if (p.gps) this.feedGps(p.gps.lat, p.gps.lon, p.gps.mps, p.gps.hdg, p.gps.acc);
  }

  /** Simulator: plausible motion that matches the fake drive. */
  simulate(mph, prevMph, dt, now) {
    if (!dt) return;
    const accel = (mph - prevMph) / 2.23694 / dt / G;
    const corner = mph > 25 ? Math.sin(now / 2300) * Math.min(1, (mph - 25) / 20) : 0;
    const latG = corner * 0.85, yaw = (mph / 2.23694) > 1 ? latG * G / (mph / 2.23694) * 180 / Math.PI * (1 + Math.max(0, Math.abs(corner) - 0.7) * 2.5) : 0;
    // device axes for a dash mount: up +y, forward -z (out of the back), so "pushed right" is +x here
    const grav = [0, -1, 0], user = [latG, 0, -accel], rot = [0, yaw * Math.PI / 180, 0];
    this._lastGravity = grav;
    this.feed(user, grav, rot, mph);
    this.feedGps(34.0522 + Math.sin(now / 60000) * 0.01, -118.2437 + Math.cos(now / 60000) * 0.01, mph / 2.23694, (now / 200) % 360, 5);
  }
}
