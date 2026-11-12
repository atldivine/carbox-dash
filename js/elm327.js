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
// Data bytes per PID, so a reply to several PIDs at once can be split up.
export const PID_LEN = { 0x0C: 2, 0x0D: 1, 0x05: 1, 0x0F: 1, 0x0B: 1, 0x33: 1, 0x11: 1, 0x0E: 1, 0x42: 2, 0x5C: 1, 0x52: 1 };
// Fast values every cycle, the rest a couple at a time in rotation.
const FAST = [0x0C, 0x0D, 0x0B, 0x11];
const SLOW = [0x05, 0x0F, 0x42, 0x0E, 0x5C, 0x52];
const hx = (n) => n.toString(16).toUpperCase().padStart(2, '0');

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

/** Splits a reply to a multi-PID request ("010C0D0B11") into { pid: bytes }. Handles the ELM327's
 *  multi-frame layout (a length line, then "0:", "1:", ... lines) and single-frame replies.
 *  Only the first ECU's answer is used. Returns {} when nothing parses. */
export function parseMulti(text) {
  const out = {};
  if (/NODATA|UNABLE|ERROR|STOPPED|\?/i.test(text.replace(/\s/g, ''))) return out;
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^SEARCHING/i.test(l));
  let hex = '';
  const lenLine = lines.find((l) => /^[0-9A-F]{3}$/i.test(l));
  const frames = lines.filter((l) => /^[0-9A-F]\s*:/i.test(l));
  if (lenLine && frames.length) {
    for (const f of frames) { const h = f.slice(f.indexOf(':') + 1).replace(/[^0-9A-Fa-f]/g, ''); if (f[0] === '0' && hex) break; hex += h; }   // a 2nd "0:" is another ECU
    hex = hex.slice(0, parseInt(lenLine, 16) * 2);
  } else hex = (lines[0] || '').replace(/[^0-9A-Fa-f]/g, '');
  hex = hex.toUpperCase();
  if (!hex.startsWith('41')) return out;
  for (let i = 2; i + 2 <= hex.length;) {
    const pid = parseInt(hex.substr(i, 2), 16), n = PID_LEN[pid];
    if (!n || i + 2 + n * 2 > hex.length) break;
    const bytes = [];
    for (let k = 0; k < n; k++) bytes.push(parseInt(hex.substr(i + 2 + k * 2, 2), 16));
    if (!(pid in out)) out[pid] = bytes;
    i += 2 + n * 2;
  }
  return out;
}

/** Supported-PID bitmap from a 0100 / 0120 / 0140 reply -> Set of PIDs, or null if unreadable. */
export function parseSupport(text, base) {
  const b = parseResponse(text, base);
  if (!b || b.length < 4) return null;
  const set = new Set();
  for (let i = 0; i < 32; i++) if (b[i >> 3] & (0x80 >> (i & 7))) set.add(base + 1 + i);
  return set;
}

export class Elm327 {
  constructor(transport, store) {
    this.t = transport; this.store = store; this.running = false; this.buf = ''; this.waiter = null; this.baro = 101.3;
    this.unsupported = new Set(); this.sfx = ''; this.mode = 'single'; this.ok = 0; this.fail = 0; this.rxBytes = 0; this.rxSample = '';
    this.t.onData((s) => this._data(s));
  }
  _data(s) {
    this.rxBytes += s.length; this.lastRx = Date.now(); if (this.rxSample.length < 40) this.rxSample += s;
    this.buf += s;
    const end = this.buf.indexOf('>');
    if (end >= 0 && this.waiter) {
      const text = this.buf.slice(0, end); this.buf = this.buf.slice(end + 1);
      const w = this.waiter; this.waiter = null; clearTimeout(w.timer);
      // drop an echoed copy of the command (adapters that ignore ATE0)
      const t = text.replace(/^\s*/, ''); w.resolve(t.toUpperCase().startsWith(w.cmd) ? t.slice(w.cmd.length) : text);
    }
  }
  // After a timeout the adapter may still send the late reply, which would then be read as the answer
  // to the NEXT command and shift every reply by one. Wait until it has been quiet, then drop it all.
  async resync(quietMs = 150, maxMs = 1000) {
    this.waiter = null;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && Date.now() - (this.lastRx || 0) < quietMs) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, quietMs));
    this.buf = '';
  }
  // request() that resyncs after a timeout, then rethrows
  async ask(cmd, timeoutMs = 1500) {
    try { return await this.request(cmd, timeoutMs); } catch (e) { await this.resync(); throw e; }
  }
  request(cmd, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('timeout: ' + cmd)); }, timeoutMs);
      this.waiter = { resolve, timer, cmd: cmd.toUpperCase() };
      this.t.write(cmd + '\r');
    });
  }
  async start() {
    await this.t.open();
    this.running = true;
    this.store.status = 'INIT';
    const tidy = (r) => r.replace(/\s+/g, ' ').trim();
    // Reset. Some adapters are slow after power-up or ignore the first command, so try twice.
    let reset = null;
    for (let attempt = 0; attempt < 2 && reset === null; attempt++) {
      try { reset = await this.ask('ATZ', 4000); } catch { this.t.write(String.fromCharCode(13)); await this.resync(); }   // a bare CR wakes some adapters
    }
    if (reset === null) {
      // Nothing that looks like an ELM327. Say whether the adapter was silent or spoke something else.
      const why = this.rxBytes === 0
        ? 'The adapter connected but never answered OBD commands. Some sensors (FIXD among them) only talk to their own app.'
        : `The adapter answered, but not like an ELM327 (it sent: "${tidy(this.rxSample).slice(0, 30)}"). It probably only works with its own app.`;
      throw new Error(why);
    }
    this.store.log(`> ATZ   < ${tidy(reset)}`);
    // Setup. A few clones answer '?' to commands they don't know; that's fine, keep going.
    // ATAT2: aggressive adaptive timing, so the adapter stops waiting for extra ECUs sooner.
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT2', 'ATSP0']) {
      try { this.store.log(`> ${c}   < ${tidy(await this.ask(c, 1500))}`); } catch (e) { this.store.log(`! ${c} ${e.message}`); }
    }
    let ident = '';
    try { ident = tidy(await this.ask('ATI', 1500)); } catch { /* optional */ }
    this.store.adapter = { ...(this.t.info || {}), elm: ident || tidy(reset) };
    let first = '';
    for (let attempt = 0; attempt < 2; attempt++) {   // the first 0100 can take seconds while it searches
      try { first = await this.ask('0100', 10000); break; } catch { /* retry once */ }
    }
    this.store.log(`> 0100  < ${tidy(first) || '(no reply)'}`);
    if (!first) throw new Error('The adapter stopped answering while searching for the car. Is the ignition on?');
    if (/UNABLE|ERROR|NODATA/i.test(first.replace(/\s/g, '')) && !/41\s*00/i.test(first)) throw new Error('Adapter cannot reach the ECU (is the ignition on?)');
    await this._tune(first);
    let b = null; try { b = parseResponse(await this.ask('0133' + this.sfx), 0x33); } catch { /* keep the 101.3 kPa default */ }
    if (b) this.baro = b[0];
    this.store.status = 'OBD';
    this._loop();
  }

  // Makes polling fast. Every step is probed and skipped if the adapter can't do it, so old clones
  // still work exactly as before:
  //  1. On CAN, talk to the engine ECU directly (ATSH7E0) instead of broadcasting, so the
  //     transmission doesn't answer too and every reply is one clean message.
  //  2. End each request with the number of replies expected ("010C1"). Without it the ELM327 waits
  //     ~50-200 ms after the answer in case another ECU speaks: the main cause of the lag.
  //  3. Ask for up to 6 PIDs in one request ("010C0D0B11"): one Bluetooth round trip instead of four.
  //  4. Read which PIDs the ECU supports up front, so nothing is wasted on ones it never answers.
  async _tune(first) {
    const tidy = (r) => r.replace(/\s+/g, ' ').trim();
    const note = [];
    let can = false, direct = false;
    try { const p = tidy(await this.ask('ATDPN', 1000)).replace(/^A/i, ''); can = /^[68]$/.test(p); note.push('protocol ' + p); } catch { /* old clone */ }   // 6/8 = 11-bit CAN (29-bit needs a different header)
    if (can) {
      try {
        if (/OK/i.test(await this.ask('ATSH7E0', 1000))) {
          const r = await this.ask('0100', 1500).catch(() => '');
          if (parseSupport(r, 0x00)?.has(0x0C)) { first = r; direct = true; note.push('engine ECU direct'); }
          else { await this.ask('ATSH7DF', 1000).catch(() => {}); }   // ECU didn't answer directly: broadcast again
        }
      } catch { /* keep broadcasting */ }
    }
    try {
      const r = await this.ask('010C1', 1000);
      if (parseResponse(r, 0x0C)?.length >= 2 && !/\?/.test(r)) { this.sfx = '1'; note.push('reply count'); }
    } catch { /* not supported */ }
    // supported PIDs (0100 covers 01-20, 0120 covers 21-40, 0140 covers 41-60)
    const sup = parseSupport(first, 0x00);
    if (sup) {
      const all = new Set(sup);
      for (const base of [0x20, 0x40]) {
        if (!all.has(base)) continue;
        try { const s = parseSupport(await this.ask('01' + hx(base) + this.sfx, 1000), base); s?.forEach((p) => all.add(p)); } catch { break; }
      }
      for (const pid of [...FAST, ...SLOW]) if (!all.has(pid) && pid !== 0x0C && pid !== 0x0D && (pid < 0x40 || all.has(0x40))) this.unsupported.add(pid);
    }
    // Batching only when talking to the engine ECU alone: on a broadcast the transmission may answer
    // first with just its speed, and the other values would read as missing.
    if (direct) {
      try {
        const pids = FAST.filter((p) => !this.unsupported.has(p));
        const got = parseMulti(await this.ask('01' + pids.map(hx).join('') + this.sfx, 1000));
        if (pids.every((p) => got[p])) { this.mode = 'multi'; note.push(`${pids.length} PIDs per request`); }
      } catch { /* one at a time */ }
    }
    let summary = note.join(', ') || 'none (basic adapter)';
    if (this.unsupported.size) summary += '; not offered by the car: ' + [...this.unsupported].sort((a, b) => a - b).map(hx).join(' ');
    this.store.log(`fast mode: ${summary}`);
    this.store.adapter = { ...this.store.adapter, fast: summary };
  }

  async _loop() {
    let n = 0, slowAt = 0, multiFails = 0;
    const slowNext = (k) => {   // the next k supported slow PIDs, in rotation
      const list = SLOW.filter((p) => !this.unsupported.has(p)), out = [];
      for (let i = 0; i < Math.min(k, list.length); i++) out.push(list[(slowAt + i) % list.length]);
      slowAt = list.length ? (slowAt + out.length) % list.length : 0;
      return out;
    };
    while (this.running) {
      if (this.store.paused) { this.store.status = 'PAUSED'; await new Promise((r) => setTimeout(r, 300)); continue; }
      this.store.status = 'OBD';
      const fast = FAST.filter((p) => !this.unsupported.has(p));
      if (this.mode === 'multi') {
        // one request: the 4 fast PIDs, plus 2 slow ones every other cycle (6 is the OBD limit)
        const pids = n++ % 2 === 0 ? fast.concat(slowNext(6 - fast.length >= 2 ? 2 : 6 - fast.length)) : fast;
        const cmd = '01' + pids.map(hx).join('') + this.sfx;
        try {
          const text = await this.ask(cmd, 600);
          this.store.log(`> ${cmd}  < ${text.replace(/\s+/g, ' ').trim()}`);
          const got = parseMulti(text);
          let any = false;
          for (const pid of pids) {
            if (got[pid]) { this._apply(pid, got[pid]); this.ok++; any = true; this._miss[pid] = 0; }
            else { this.fail++; if (++this._miss[pid] > 3 && pid !== 0x0C && pid !== 0x0D) this.unsupported.add(pid); }
          }
          multiFails = any ? 0 : multiFails + 1;
        } catch (e) { this.fail++; multiFails++; this.store.log('! ' + e.message); }
        if (multiFails >= 4) { this.mode = 'single'; this.store.log('! batched requests stopped working; asking one PID at a time'); }
        continue;
      }
      const pids = n % 4 === 0 ? fast.concat(slowNext(1)) : fast;
      n++;
      let asked = 0;
      for (const pid of pids) {
        if (!this.running || this.store.paused) break;
        if (this.unsupported.has(pid)) continue;
        const cmd = '01' + hx(pid) + this.sfx;
        asked++;
        try {
          const text = await this.ask(cmd, 600);
          this.store.log(`> ${cmd}  < ${text.replace(/\s+/g, ' ').trim()}`);
          const bytes = parseResponse(text, pid);
          if (!bytes) { if (++this._miss[pid] > 3 && pid !== 0x0C && pid !== 0x0D) this.unsupported.add(pid); this.fail++; continue; }
          this._apply(pid, bytes); this.ok++;
        } catch (e) { this.fail++; this.store.log('! ' + e.message); }
      }
      if (!asked) { this.store.status = 'NO DATA'; await new Promise((r) => setTimeout(r, 1000)); }   // never spin
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
