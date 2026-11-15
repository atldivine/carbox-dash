// Latest value of every signal. Sources write, the UI reads.
export const SIGNALS = {
  load: {label: 'Engine load', unit: '%', lo: 0, hi: 100, dec: 1},
  relative_throttle: {label: 'Relative throttle', unit: '%', lo: 0, hi: 100, dec: 1},
  pedal: {label: 'Pedal D', unit: '%', lo: 0, hi: 100, dec: 1},
  pedal_e: {label: 'Pedal E', unit: '%', lo: 0, hi: 100, dec: 1},
  pedal_f: {label: 'Pedal F', unit: '%', lo: 0, hi: 100, dec: 1},
  commanded_throttle: {label: 'Throttle command', unit: '%', lo: 0, hi: 100, dec: 1},
  rpm:           { label: 'RPM',        unit: 'rpm', lo: 0,    hi: 7500, warn: 6600, crit: 7000, dec: 0 },
  speed:         { label: 'Speed',      unit: 'mph', lo: 0,    hi: 180,  dec: 0 },
  boost:         { label: 'Boost',      unit: 'psi', lo: -15,  hi: 25,   warn: 18, crit: 22, dec: 1 },
  afr:           { label: 'AFR',        unit: ':1',  lo: 9,    hi: 18,   warn: 15.5, crit: 16.5, dec: 1 },
  iat:           { label: 'Intake',     unit: '°F',  lo: 0,    hi: 200,  warn: 130, crit: 150, dec: 0 },
  coolant:       { label: 'Coolant',    unit: '°F',  lo: 100,  hi: 260,  warn: 225, crit: 240, dec: 0 },
  oil_temp:      { label: 'Oil temp',   unit: '°F',  lo: 100,  hi: 300,  warn: 260, crit: 280, dec: 0 },
  ethanol:       { label: 'Ethanol',    unit: '%',   lo: 0,    hi: 100,  dec: 0 },
  timing:        { label: 'Timing',     unit: '°',   lo: -10,  hi: 40,   dec: 1 },
  knock:         { label: 'Knock',      unit: '°',   lo: 0,    hi: 8,    warn: 2, crit: 4, dec: 1 },
  throttle:      { label: 'Throttle',   unit: '%',   lo: 0,    hi: 100,  dec: 0 },
  fuel_pressure: { label: 'Fuel',       unit: 'psi', lo: 0,    hi: 3000, dec: 0 },
  battery:       { label: 'Battery',    unit: 'V',   lo: 10,   hi: 16,   dec: 1 },
  stft:          { label: 'Short trim', unit: '%',   lo: -25,  hi: 25,   dec: 1 },
  ltft:          { label: 'Long trim',  unit: '%',   lo: -25,  hi: 25,   warn: 15, dec: 1 },
  maf:           { label: 'Airflow',    unit: 'g/s', lo: 0,    hi: 350,  dec: 1 },
  lambda:        { label: 'Lambda',     unit: 'λ',   lo: 0.6,  hi: 1.3,  dec: 3 },
  lambda_cmd:    { label: 'Target λ',   unit: 'λ',   lo: 0.6,  hi: 1.3,  dec: 3 },
  // from the car's own CAN bus (CANsub + DBC); "step" values are states, never eased
  steer:         { label: 'Steering',   unit: '°',   lo: -540, hi: 540,  dec: 0 },
  brake:         { label: 'Brake',      unit: '%',   lo: 0,    hi: 100,  dec: 0 },
  ws_fl:         { label: 'Wheel FL',   unit: 'mph', lo: 0,    hi: 180,  dec: 1 },
  ws_fr:         { label: 'Wheel FR',   unit: 'mph', lo: 0,    hi: 180,  dec: 1 },
  ws_rl:         { label: 'Wheel RL',   unit: 'mph', lo: 0,    hi: 180,  dec: 1 },
  ws_rr:         { label: 'Wheel RR',   unit: 'mph', lo: 0,    hi: 180,  dec: 1 },
  odo:           { label: 'Odometer',   unit: 'mi',  lo: 0,    hi: 999999, dec: 0, step: true },
  fuel_level:    { label: 'Fuel',       unit: '%',   lo: 0,    hi: 100,  dec: 0 },
  tpms_fl:       { label: 'Tire FL',    unit: 'psi', lo: 20,   hi: 45,   dec: 1, step: true },
  tpms_fr:       { label: 'Tire FR',    unit: 'psi', lo: 20,   hi: 45,   dec: 1, step: true },
  tpms_rl:       { label: 'Tire RL',    unit: 'psi', lo: 20,   hi: 45,   dec: 1, step: true },
  tpms_rr:       { label: 'Tire RR',    unit: 'psi', lo: 20,   hi: 45,   dec: 1, step: true },
};
// On/off and multi-state values from CAN (not shown as gauges, never eased).
export const STATES = ['vdc_off', 'abs', 'tcs', 'turn_l', 'turn_r', 'hazard', 'pbrake', 'lights', 'wiper', 'door_fl', 'door_fr', 'hatch',
  'locked', 'belt', 'ignition', 'cruise', 'clutch'];
for (const k of STATES) SIGNALS[k] = { label: k, unit: '', lo: 0, hi: 3, dec: 0, step: true, state: true };

const FAST_KEYS = new Set(['rpm', 'speed', 'boost', 'throttle', 'afr', 'knock']);

export class Store {
  constructor() {
    this.v = {};              // key -> source -> [value, timeMs]
    this.iv = {};             // key -> average ms between samples (drives the display smoothing)
    this.night = false;
    this.paused = false;      // "flash safe": sources must not transmit
    this.status = '';         // short source status shown in the header
    this.source = 'none';
    this.busLog = [];         // recent raw adapter lines
    this.busCount = 0;
  }
  set(k, val, source = this.source) {
    const samples = (this.v[k] ??= {});
    const now = performance.now(), prev = samples[source];
    if (prev) { const iv = Math.min(1000, now - prev[1]); if (iv > 2) this.iv[k] = this.iv[k] ? this.iv[k] * 0.8 + iv * 0.2 : iv; }   // average time between samples
    samples[source] = [val, now];
  }
  clearSource(source, keep = {}) {
    for (const k in this.v) {
      const samples = this.v[k];
      if (!samples[source] || Object.hasOwn(keep, k)) continue;
      delete samples[source];
      if (Object.keys(samples).length === 0) delete this.v[k];
      delete this.iv[k];
    }
  }
  // A value counts as live for 2 s; slow-changing ones (temps, battery, timing, ethanol) for 12 s, because
  // adapters that answer one PID at a time only get round to them every few seconds.
  get(k, source) {
    const samples = this.v[k];
    if (!samples) return null;
    let latest = samples[source];
    if (source == null) {
      for (const id in samples) {
        if (!latest || samples[id][1] >= latest[1]) latest = samples[id];
      }
    }
    return latest && performance.now() - latest[1] < (FAST_KEYS.has(k) ? 2000 : 12000) ? latest[0] : null;
  }
  /** Time (ms) of the newest sample of k from any source; changes only when a new reading arrives. */
  time(k) { const sm = this.v[k]; if (!sm) return null; let t = null; for (const id in sm) if (t == null || sm[id][1] > t) t = sm[id][1]; return t; }
  count(source) {
    return Object.keys(this.v).filter(k => this.get(k, source) !== null).length;
  }
  snapshot() { const o = {}; for (const k in this.v) { const x = this.get(k); if (x !== null) o[k] = x; } return o; }
  log(line) { this.busLog.push([performance.now(), line, this.source]); this.busCount++; if (this.busLog.length > 60) this.busLog.shift(); }
}

export const fmt = (k, v) => v === null || v === undefined ? '--' : v.toLocaleString('en-US', { minimumFractionDigits: SIGNALS[k].dec, maximumFractionDigits: SIGNALS[k].dec });
export const frac = (k, v) => v == null ? 0 : Math.max(0, Math.min(1, (v - SIGNALS[k].lo) / (SIGNALS[k].hi - SIGNALS[k].lo)));
export function level(k, v) {
  const s = SIGNALS[k];
  if (v == null) return 'none';
  if (s.crit != null && v >= s.crit) return 'crit';
  if (s.warn != null && v >= s.warn) return 'warn';
  return 'ok';
}
