// Live engine power and torque for the POWER gauges. Best source first:
//  1. ECU   - PID 62 (actual torque, % of reference) x PID 63 (reference torque, Nm): the ECU's own figure.
//  2. LOAD  - PID 04 (calculated load) x the VR30's full-load torque curve at this rpm.
//  3. BOOST - manifold pressure (PID 0B, always polled) against full boost, x the same curve.
// 2 and 3 are estimates and are labelled so. Power = torque x rpm / 5252 (lb-ft, hp).
const NM_TO_LBFT = 0.737562;

// Nissan VR30DDTT (Z, 400 hp / 350 lb-ft): full-load torque by rpm, lb-ft. Flat 350 from 1,600 to
// 5,600 rpm, then falling so power peaks near 400 hp at 6,400.
const CURVE = [[700, 150], [1000, 200], [1600, 350], [5600, 350], [6400, 328], [7000, 280], [7500, 240]];
export function fullLoadTorque(rpm) {
  if (rpm <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    const [r1, t1] = CURVE[i], [r0, t0] = CURVE[i - 1];
    if (rpm <= r1) return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
  }
  return CURVE[CURVE.length - 1][1];
}

const FULL_BOOST_KPA = 101.3 + 15 * 6.89476;   // ~15 psi: stock Z boost at full load
const IDLE_MAP_KPA = 30;

export class PowerModel {
  constructor(store, cfg = {}) {
    this.store = store;
    this.maxTq = cfg.maxTq || 350; this.maxHp = cfg.maxHp || 400;   // gauge full scale (stock Z); grows past it if you make more
    this.peakHp = 0; this.peakTq = 0; this.src = null;
  }
  read() {
    const g = (k) => this.store.get(k), rpm = g('rpm');
    if (rpm == null || rpm < 400) return { hp: null, tq: null, src: null };
    let tq = null, src = null;
    const pct = g('torque_pct'), ref = g('torque_ref'), load = g('load'), boost = g('boost');
    if (pct != null && ref != null && ref > 0) { tq = Math.max(0, pct / 100 * ref * NM_TO_LBFT); src = 'ECU'; }
    else if (load != null) { tq = Math.max(0, load / 100 * fullLoadTorque(rpm)); src = 'LOAD EST.'; }
    else if (boost != null) {
      const map = boost * 6.89476 + 101.3, f = Math.max(0, Math.min(1.15, (map - IDLE_MAP_KPA) / (FULL_BOOST_KPA - IDLE_MAP_KPA)));
      tq = f * fullLoadTorque(rpm); src = 'BOOST EST.';
    }
    if (tq == null) return { hp: null, tq: null, src: null };
    const hp = tq * rpm / 5252;
    this.src = src;
    if (hp > this.peakHp) this.peakHp = hp; if (tq > this.peakTq) this.peakTq = tq;
    this.maxHp = Math.max(this.maxHp, Math.ceil(hp / 50) * 50); this.maxTq = Math.max(this.maxTq, Math.ceil(tq / 50) * 50);
    return { hp, tq, src };
  }
  resetPeaks() { this.peakHp = 0; this.peakTq = 0; }
}
