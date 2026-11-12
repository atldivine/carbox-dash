// A fake BLE ELM327 plugged into a fake CAN car (11-bit, 500k, like the 2023+ Z), with realistic timing,
// so tests can measure how quickly a change at the engine shows up in the app.
//
// Timing model (per command):
//   link   one-way BLE delay (iOS connection interval is 15-30 ms)
//   ecu    time for the ECU to answer on CAN
//   linger how long the ELM327 keeps listening for MORE ECUs after the first answer, unless the
//          command ends in a response count ("010C1") -- this is the big hidden delay on real adapters
// Engine ECU (7E8) answers everything it supports; the transmission (7E9) also answers 0100 and 0D
// when the request is broadcast (7DF), like real cars do.
import { PIDS } from '../js/elm327.js';

const KPA_PER_PSI = 6.89476;
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

export class FakeCanCar {
  constructor(values, opt = {}) {
    this.values = values;
    this.o = { link: 20, ecu: 8, linger: 100, multi: true, count: true, setHeader: true, ...opt };
    this.cb = () => {}; this.rx = ''; this.header = '7DF'; this.lingerMs = this.o.linger; this.busy = false; this.queue = [];
    this.supported = new Set(opt.supported || [0x0C, 0x0D, 0x05, 0x0F, 0x0B, 0x33, 0x11, 0x0E, 0x42]);   // oil temp / ethanol: not on the VR30
  }
  async open() {}
  close() {}
  onData(cb) { this.cb = cb; }
  write(s) {
    this.rx += s;
    let i;
    while ((i = this.rx.indexOf('\r')) >= 0) {
      const cmd = this.rx.slice(0, i).replace(/\s/g, '').toUpperCase(); this.rx = this.rx.slice(i + 1);
      this.queue.push(cmd);
    }
    this._next();
  }
  _next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const cmd = this.queue.shift();
    const [text, extra] = this._answer(cmd);
    setTimeout(() => { this.cb(text + '\r\r>'); this.busy = false; this._next(); }, this.o.link * 2 + extra);
  }
  _bitmap(base) {
    let bits = 0;
    for (let p = base + 1; p <= base + 32; p++) {
      const next = p === base + 32 && [...this.supported].some((q) => q > base + 32);   // "more PIDs in the next block"
      if ((!(this.o.hideFromList || []).includes(p) && this.supported.has(p)) || next || (p === base + 32 && base < 0x40)) bits |= 1 << (32 - (p - base));
    }
    return [bits >>> 24 & 255, bits >>> 16 & 255, bits >>> 8 & 255, bits & 255];
  }
  _data(pid) {
    if (pid % 0x20 === 0 && pid <= 0x80) return this._bitmap(pid);
    if (!this.supported.has(pid)) return null;
    const p = PIDS[pid], key = p[0];
    let v;
    if (key === '_map') { const b = this.values('boost'); v = b == null ? undefined : b * KPA_PER_PSI + 101; }
    else if (key === '_baro') v = 101;
    else v = this.values(key);
    if (v == null) return null;
    return p[2](v).map((x) => Math.max(0, Math.min(255, x)));
  }
  // ISO-TP as an ELM327 prints it with ATH0/ATS0: one line if it fits a single frame, else a length line + "0:", "1:"...
  _format(bytes) {
    const h = bytes.map(hex2).join('');
    if (bytes.length <= 7) return h;
    const lines = [bytes.length.toString(16).toUpperCase().padStart(3, '0'), '0:' + h.slice(0, 12)];
    for (let i = 12, n = 1; i < h.length; i += 14, n++) lines.push((n & 15).toString(16).toUpperCase() + ':' + h.slice(i, i + 14).padEnd(14, '0'));
    return lines.join('\r');
  }
  _answer(cmd) {
    const { ecu } = this.o;
    if (cmd.startsWith('AT')) {
      if (cmd === 'ATZ') { this.header = '7DF'; this.lingerMs = this.o.linger; return ['ELM327 v1.5', 300]; }
      if (cmd === 'ATI') return ['ELM327 v1.5', 0];
      if (cmd === 'ATDPN') return ['A6', 0];
      if (cmd === 'ATAT2') { this.lingerMs = Math.round(this.o.linger / 2); return ['OK', 0]; }
      if (cmd.startsWith('ATSH')) { if (!this.o.setHeader) return ['?', 0]; this.header = cmd.slice(4); return ['OK', 0]; }
      return ['OK', 0];
    }
    const m = /^01((?:[0-9A-F]{2})+)([0-9A-F]?)$/.exec(cmd);
    if (!m) return ['?', 0];
    const pids = m[1].match(/../g).map((x) => parseInt(x, 16));
    const counted = m[2] !== '';
    if (counted && !this.o.count) return ['?', 0];
    if (pids.length > 1 && !this.o.multi) return ['NO DATA', ecu + this.lingerMs];
    if (pids.length > 6) return ['?', 0];
    const physical = this.header === '7E0';
    const msgs = [];
    const ecm = [0x41];
    for (const pid of pids) { const d = this._data(pid); if (d) ecm.push(pid, ...d); }
    if (ecm.length > 1) msgs.push(this._format(ecm));
    if (!physical) {   // the transmission chimes in on broadcasts
      const tcm = [0x41];
      for (const pid of pids) { if (pid === 0x0D) tcm.push(0x0D, ...this._data(0x0D)); if (pid === 0x00) tcm.push(0x00, 0x00, 0x18, 0x00, 0x00); }
      if (tcm.length > 1) msgs.push(this._format(tcm));
    }
    if (!msgs.length) return ['NO DATA', ecu + this.lingerMs];
    const wanted = counted ? parseInt(m[2], 16) : Infinity;
    const out = msgs.slice(0, wanted);
    const wait = out.length >= wanted ? ecu : ecu + this.lingerMs;   // count reached: reply at once
    return [out.join('\r'), wait];
  }
}
