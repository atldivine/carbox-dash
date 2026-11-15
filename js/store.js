// Latest value of every signal. Sources write, the UI reads.
export const SIGNALS = {
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
};

const FAST_KEYS = new Set(['rpm', 'speed', 'boost', 'throttle', 'afr', 'knock']);

export class Store {
  constructor() {
    this.v = {};              // key -> [value, timeMs]
    this.night = false;
    this.paused = false;      // "flash safe": sources must not transmit
    this.status = '';         // short source status shown in the header
    this.source = 'none';
    this.busLog = [];         // recent raw adapter lines
    this.busCount = 0;
  }
  set(k, val) { this.v[k] = [val, performance.now()]; }
  // A value counts as live for 2 s; slow-changing ones (temps, battery, timing, ethanol) for 12 s, because
  // adapters that answer one PID at a time only get round to them every few seconds.
  get(k) { const e = this.v[k]; return e && performance.now() - e[1] < (FAST_KEYS.has(k) ? 2000 : 12000) ? e[0] : null; }
  count() { return Object.keys(this.v).filter(k => this.get(k) !== null).length; }
  snapshot() { const o = {}; for (const k in this.v) { const x = this.get(k); if (x !== null) o[k] = x; } return o; }
  log(line) { this.busLog.push([performance.now(), line]); this.busCount++; if (this.busLog.length > 60) this.busLog.shift(); }
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
