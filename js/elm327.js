// ELM327 OBD-II driver. Works over any transport: { open(), write(str), onData(fn), close() }.
// Standard Mode 01 PIDs only. EcuTek-only values (knock, ethanol, oil temp on the VR30) are NOT
// available this way; they need RaceROM CAN output read by a CAN adapter (see README).
const KPA_PER_PSI = 6.89476;
const f = (c) => c * 9 / 5 + 32;

// pid -> [signal key, decode(bytes) -> value in UI units, encode(value) -> bytes (used by the fake adapter)]
export const PIDS = {
  0x0C: ['rpm',      (d) => (d[0] * 256 + d[1]) / 4,        (v) => { const n = Math.round(v * 4); return [n >> 8, n & 255]; }],
  0x0D: ['speed',    (d) => d[0] * 0.621371,                (v) => [Math.round(v / 0.621371)]],
  0x05: ['coolant',  (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x0F: ['iat',      (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x0B: ['_map',     (d) => d[0],                           (v) => [Math.round(v)]],
  0x33: ['_baro',    (d) => d[0],                           (v) => [Math.round(v)]],
  0x11: ['throttle', (d) => d[0] * 100 / 255,               (v) => [Math.round(v * 255 / 100)]],
  0x0E: ['timing',   (d) => d[0] / 2 - 64,                  (v) => [Math.round((v + 64) * 2)]],
  0x42: ['battery',  (d) => (d[0] * 256 + d[1]) / 1000,     (v) => { const n = Math.round(v * 1000); return [n >> 8, n & 255]; }],
  0x5C: ['oil_temp', (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x52: ['ethanol',  (d) => d[0] * 100 / 255,               (v) => [Math.round(v * 255 / 100)]],
};
// Fast values every cycle, the rest every few cycles.
const FAST = [0x0C, 0x0D, 0x0B, 0x11];
const SLOW = [0x05, 0x0F, 0x42, 0x0E, 0x5C, 0x52];

export function parseResponse(text, pid) {
  // ATS0 (no spaces) and ATH0 (no headers) are set, but accept spaces anyway.
  const hex = text.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const tag = '41' + pid.toString(16).toUpperCase().padStart(2, '0');
  const i = hex.indexOf(tag);
  if (i < 0 || /NODATA|UNABLE|ERROR|STOPPED/i.test(text.replace(/\s/g, ''))) return null;
  const bytes = [];
  for (let k = i + 4; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.substr(k, 2), 16));
  return bytes;
}

export class Elm327 {
  constructor(transport, store) {
    this.t = transport; this.store = store; this.running = false; this.buf = ''; this.waiter = null; this.baro = 101.3;
    this.unsupported = new Set(); this.ok = 0; this.fail = 0;
    this.t.onData((s) => this._data(s));
  }
  _data(s) {
    this.buf += s;
    const end = this.buf.indexOf('>');
    if (end >= 0 && this.waiter) {
      const text = this.buf.slice(0, end); this.buf = this.buf.slice(end + 1);
      const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(text);
    }
  }
  request(cmd, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('timeout: ' + cmd)); }, timeoutMs);
      this.waiter = { resolve, timer };
      this.t.write(cmd + '\r');
    });
  }
  async start() {
    await this.t.open();
    this.running = true;
    this.store.status = 'INIT';
    for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) {
      const r = await this.request(c, c === 'ATZ' ? 4000 : 1500);
      this.store.log(`> ${c}   < ${r.replace(/\s+/g, ' ').trim()}`);
    }
    const first = await this.request('0100', 8000);   // wakes the bus and picks the protocol
    this.store.log(`> 0100  < ${first.replace(/\s+/g, ' ').trim()}`);
    if (/UNABLE|ERROR/i.test(first)) throw new Error('Adapter cannot reach the ECU (is the ignition on?)');
    const b = parseResponse(await this.request('0133'), 0x33);
    if (b) this.baro = b[0];
    this.store.status = 'OBD';
    this._loop();
  }
  async _loop() {
    let n = 0;
    while (this.running) {
      if (this.store.paused) { this.store.status = 'PAUSED'; await new Promise((r) => setTimeout(r, 300)); continue; }
      this.store.status = 'OBD';
      const pids = n % 4 === 0 ? FAST.concat(SLOW[(n / 4) % SLOW.length | 0]) : FAST;
      n++;
      for (const pid of pids) {
        if (!this.running || this.store.paused) break;
        if (this.unsupported.has(pid)) continue;
        const cmd = '01' + pid.toString(16).toUpperCase().padStart(2, '0');
        try {
          const text = await this.request(cmd);
          this.store.log(`> ${cmd}  < ${text.replace(/\s+/g, ' ').trim()}`);
          const bytes = parseResponse(text, pid);
          if (!bytes) { if (++this._miss[pid] > 3) this.unsupported.add(pid); this.fail++; continue; }
          this._apply(pid, bytes); this.ok++;
        } catch (e) { this.fail++; this.store.log('! ' + e.message); }
      }
    }
  }
  get _miss() { return this.__miss || (this.__miss = new Proxy({}, { get: (o, k) => o[k] || 0, set: (o, k, v) => { o[k] = v; return true; } })); }
  _apply(pid, bytes) {
    const [key, dec] = PIDS[pid];
    let v; try { v = dec(bytes); } catch { return; }
    if (Number.isNaN(v)) return;
    if (key === '_baro') this.baro = v;
    else if (key === '_map') this.store.set('boost', (v - this.baro) / KPA_PER_PSI);
    else this.store.set(key, v);
  }
  stop() { this.running = false; try { this.t.close(); } catch { /* already closed */ } }
}

// Pretends to be an ELM327 so the driver can be tested with no adapter. `values` is a function
// (signalKey) -> number|undefined that supplies engine data (use the simulator's store).
export class FakeElmTransport {
  constructor(values) { this.values = values; this.cb = () => {}; this.rx = ''; }
  async open() {}
  close() {}
  onData(cb) { this.cb = cb; }
  write(s) {
    this.rx += s;
    let i;
    while ((i = this.rx.indexOf('\r')) >= 0) {
      const cmd = this.rx.slice(0, i).trim().toUpperCase(); this.rx = this.rx.slice(i + 1);
      setTimeout(() => this.cb(this._answer(cmd) + '\r\r>'), 15);
    }
  }
  _answer(cmd) {
    if (cmd.startsWith('AT')) return cmd === 'ATZ' ? 'ELM327 v1.5' : 'OK';
    if (cmd === '0100') return 'BUS INIT: OK\r4100BE3FA813';
    const m = /^01([0-9A-F]{2})$/.exec(cmd);
    if (!m) return '?';
    const pid = parseInt(m[1], 16), p = PIDS[pid];
    if (!p) return 'NO DATA';
    const key = p[0];
    let v;
    if (key === '_map') { const b = this.values('boost'); v = b == null ? undefined : b * KPA_PER_PSI + 101; }
    else if (key === '_baro') v = 101;
    else v = this.values(key);
    if (v === undefined || v === null) return 'NO DATA';
    return '41' + m[1] + p[2](v).map((x) => Math.max(0, Math.min(255, x)).toString(16).toUpperCase().padStart(2, '0')).join('');
  }
}
