// ELM327 OBD-II driver. Works over any transport: { open(), write(str), onData(fn), close() }.
// Standard Mode 01 PIDs only. EcuTek-only values (knock, ethanol, oil temp on the VR30) are NOT
// available this way; they need RaceROM CAN output read by a CAN adapter (see README).
const KPA_PER_PSI = 6.89476;
const f = (c) => c * 9 / 5 + 32;

// pid -> [signal key, decode(bytes) -> value in UI units, encode(value) -> bytes (used by the fake adapter)]
export const PIDS = {
  0x04: ['load', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  0x45: ['relative_throttle', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  0x49: ['pedal', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  0x4A: ['pedal_e', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  0x4B: ['pedal_f', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  0x4C: ['commanded_throttle', d => d[0] * 100 / 255, v => [Math.round(v * 255 / 100)]],
  // Engine torque straight from the ECU (SAE J1979): actual torque as % of the reference torque.
  0x62: ['torque_pct', (d) => d[0] - 125,                   (v) => [Math.round(v + 125)]],
  0x61: ['torque_dem', (d) => d[0] - 125,                   (v) => [Math.round(v + 125)]],
  0x63: ['torque_ref', (d) => d[0] * 256 + d[1],            (v) => { const n = Math.round(v); return [n >> 8, n & 255]; }],
  0x0C: ['rpm',      (d) => (d[0] * 256 + d[1]) / 4,        (v) => { const n = Math.round(v * 4); return [n >> 8, n & 255]; }],
  0x0D: ['speed',    (d) => d[0] * 0.621371,                (v) => [Math.round(v / 0.621371)]],
  0x05: ['coolant',  (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x0F: ['iat',      (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x0B: ['_map',     (d) => d[0],                           (v) => [Math.round(v)]],
  0x33: ['_baro',    (d) => d[0],                           (v) => [Math.round(v)]],
  0x11: ['throttle', (d) => d[0] * 100 / 255,               (v) => [Math.round(v * 255 / 100)]],
  0x0E: ['timing',   (d) => d[0] / 2 - 64,                  (v) => [Math.round((v + 64) * 2)]],
  0x2F: ['fuel_level', (d) => d[0] * 100 / 255,             (v) => [Math.round(v * 255 / 100)]],
  0x42: ['battery',  (d) => (d[0] * 256 + d[1]) / 1000,     (v) => { const n = Math.round(v * 1000); return [n >> 8, n & 255]; }],
  0x5C: ['oil_temp', (d) => f(d[0] - 40),                   (v) => [Math.round((v - 32) * 5 / 9 + 40)]],
  0x52: ['ethanol',  (d) => d[0] * 100 / 255,               (v) => [Math.round(v * 255 / 100)]],
  0x06: ['stft',     (d) => (d[0] - 128) * 100 / 128,       (v) => [Math.round(v * 128 / 100 + 128)]],
  0x07: ['ltft',     (d) => (d[0] - 128) * 100 / 128,       (v) => [Math.round(v * 128 / 100 + 128)]],
  0x10: ['maf',      (d) => (d[0] * 256 + d[1]) / 100,      (v) => { const n = Math.round(v * 100); return [n >> 8, n & 255]; }],
  0x44: ['lambda_cmd', (d) => (d[0] * 256 + d[1]) / 32768,  (v) => { const n = Math.round(v * 32768); return [n >> 8, n & 255]; }],
  // wide-band O2 sensor 1: lambda in the first two bytes (0x34 current type, 0x24 voltage type)
  0x34: ['lambda',   (d) => (d[0] * 256 + d[1]) / 32768,    (v) => { const n = Math.round(v * 32768); return [n >> 8, n & 255, 128, 0]; }],
  // Newer multi-sensor PIDs some ECUs use instead of 0F / 10: first byte says which sensors exist.
  0x66: ['maf',      (d) => (d[1] * 256 + d[2]) / 32,       (v) => { const n = Math.round(v * 32); return [1, n >> 8, n & 255, 0, 0]; }],
  0x68: ['iat',      (d) => f(d[1] - 40),                   (v) => [1, Math.round((v - 32) * 5 / 9 + 40), 0, 0, 0, 0, 0]],
  0x24: ['lambda',   (d) => (d[0] * 256 + d[1]) / 32768,    (v) => { const n = Math.round(v * 32768); return [n >> 8, n & 255, 128, 0]; }],
};
// Data bytes per PID, so a reply to several PIDs at once can be split up.
export const PID_LEN = { 0x04: 1, 0x45: 1, 0x49: 1, 0x4A: 1, 0x4B: 1, 0x4C: 1, 0x0C: 2, 0x0D: 1, 0x05: 1, 0x0F: 1, 0x0B: 1, 0x33: 1, 0x11: 1, 0x0E: 1, 0x2F: 1, 0x42: 2, 0x5C: 1, 0x52: 1, 0x06: 1, 0x07: 1, 0x10: 2, 0x44: 2, 0x34: 4, 0x24: 4, 0x66: 5, 0x68: 7, 0x61: 1, 0x62: 1, 0x63: 2 };
// Fast values every cycle, the rest a couple at a time in rotation.
const FAST = [0x0C, 0x0D, 0x0B, 0x11, 0x62];   // 62 = live engine torque (dropped at connect if the ECU lacks it)
const SLOW = [0x04, 0x45, 0x49, 0x4A, 0x4B, 0x4C, 0x05, 0x0F, 0x42, 0x0E, 0x5C, 0x52, 0x2F, 0x10, 0x34, 0x24, 0x06, 0x07, 0x44, 0x68, 0x66, 0x63];   // dash values first, engine-tab extras after
const BASIC_FAST = [0x0C, 0x0D, 0x11];
const BASIC_SLOW = [0x05, 0x2F, 0x33, 0x0B, ...SLOW.filter((pid) => pid !== 0x05 && pid !== 0x2F)];
const hx = (n) => n.toString(16).toUpperCase().padStart(2, '0');

export function parseResponse(text, pid) {
  // ATS0 (no spaces) and ATH0 (no headers) are set, but accept spaces anyway.
  const tag = '41' + hx(pid);
  const minimum = PID_LEN[pid] ?? (pid % 0x20 === 0 ? 4 : 1);
  for (const line of text.split(/[\r\n]+/)) {
    if (/NODATA|UNABLE|ERROR|STOPPED/i.test(line.replace(/\s/g, ''))) continue;
    const hex = line.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const i = hex.indexOf(tag);
    if (i < 0 || hex.length < i + 4 + minimum * 2) continue;
    const bytes = [];
    for (let k = i + 4; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
    return bytes;
  }
  return null;
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

// Plain names for values the car doesn't give over OBD-II (a value is missing only when every PID
// that could carry it is unavailable), with where to get it instead.
const VALUE_NAMES = { torque_pct: 'live torque', torque_ref: 'reference torque', torque_dem: 'torque demand', iat: 'intake temp', maf: 'airflow (MAF)', lambda: 'wide-band lambda', ethanol: 'ethanol (EcuTek RaceROM CAN)',
  oil_temp: 'oil temp (EcuTek RaceROM CAN)', stft: 'short fuel trim', ltft: 'long fuel trim', lambda_cmd: 'target lambda', battery: 'battery voltage',
  timing: 'ignition timing', coolant: 'coolant', fuel_level: 'fuel level', load: 'engine load', pedal: 'pedal', relative_throttle: 'relative throttle',
  pedal_e: 'pedal E', pedal_f: 'pedal F', commanded_throttle: 'throttle command' };
export function missingValues(unsupported) {
  const byKey = {};
  for (const pid of SLOW.concat(FAST)) { const k = PIDS[pid]?.[0]; if (k && !k.startsWith('_')) (byKey[k] ||= []).push(pid); }
  return Object.entries(byKey).filter(([, pids]) => pids.every((p) => unsupported.has(p))).map(([k]) => VALUE_NAMES[k] || k);
}

export class Elm327 {
  constructor(transport, store) {
    this.t = transport; this.store = store; this.running = false; this.stopped = false; this.buf = ''; this.waiter = null; this.baro = 101.3;
    this.unsupported = new Set(); this.redundant = new Set(); this.observed = new Set(); this.retryAt = new Map(); this.misses = {}; this.basic = false;
    this.sfx = ''; this.mode = 'single'; this.ok = 0; this.fail = 0; this.rxBytes = 0; this.rxSample = '';
    this.rawQ = [];
    this.t.onData((s) => this._data(s));
  }
  /** One raw request (diagnostics: "03", "0101", ...) slotted in between polls. Refused while paused. */
  raw(cmd, timeoutMs = 4000) {
    if (this.store.paused) return Promise.reject(new Error('OBD is paused'));
    if (!this.running) return Promise.reject(new Error('No adapter connected'));
    return new Promise((resolve, reject) => this.rawQ.push({ cmd, timeoutMs, resolve, reject }));
  }
  async _drainRaw() {
    while (this.rawQ.length) {
      const q = this.rawQ.shift();
      try { const text = await this.ask(q.cmd, q.timeoutMs); this.store.log(`> ${q.cmd}  < ${text.replace(/\s+/g, ' ').trim()}`); q.resolve(text); } catch (e) { q.reject(e); }
    }
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
    const t0 = performance.now();
    try { const r = await this.request(cmd, timeoutMs); this.rtt = (this.rtt ?? 150) * 0.85 + Math.min(2000, performance.now() - t0) * 0.15; return r; }
    catch (e) { if (this.running) await this.resync(); throw e; }
  }
  /** Poll timeout follows the link: ~3x the usual reply time, 0.6-2 s (a fixed 0.6 s flushed whole cycles on a slow link). */
  get pollTimeout() { return Math.min(2000, Math.max(600, (this.rtt ?? 150) * 3 + 150)); }
  request(cmd, timeoutMs = 1500) {
    if (!this.running) return Promise.reject(new Error('Adapter stopped'));
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('timeout: ' + cmd)); }, timeoutMs);
      const wait = { resolve, reject, timer, cmd: cmd.toUpperCase() };
      this.waiter = wait;
      Promise.resolve().then(() => {
        if (this.waiter === wait) return this.t.write(cmd + '\r');
      }).catch((error) => {
        if (this.waiter !== wait) return;
        this.waiter = null; clearTimeout(timer); reject(error);
      });
    });
  }
  async start() {
    await this.t.open();
    if (this.stopped) { this.t.close(); throw new Error('Adapter stopped'); }
    this.running = true;
    const name = (this.t.info?.name || '').toLowerCase().replace(/[^a-z]/g, '');
    this.basic = name.includes('fixd') || name.includes('appraisalpro');
    this.store.status = 'ADAPTER INIT';
    const tidy = (r) => r.replace(/\s+/g, ' ').trim();
    // Reset. Some adapters are slow after power-up or ignore the first command, so try twice.
    let reset = null;
    for (let attempt = 0; attempt < 2 && reset === null; attempt++) {
      try { reset = await this.ask('ATZ', 4000); } catch (error) {
        if (!this.running) throw error;
        try { await this.t.write('\r'); } catch { /* a bare CR wakes some adapters */ }
        await this.resync();
      }
    }
    if (!this.running) throw new Error('Adapter stopped');
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
    const setup = this.basic ? ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0'] : ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT2', 'ATSP0'];
    for (const c of setup) {
      try {
        const reply = await this.ask(c, 1500);
        if (this.running) this.store.log(`> ${c}   < ${tidy(reply)}`);
      } catch (e) {
        if (this.running) this.store.log(`! ${c} ${e.message}`);
      }
      if (!this.running) throw new Error('Adapter stopped');
    }
    let ident = '';
    try { ident = tidy(await this.ask('ATI', 1500)); } catch { /* optional */ }
    if (!this.running) throw new Error('Adapter stopped');
    this.store.adapter = { ...(this.t.info || {}), elm: ident || tidy(reset) };
    this.store.status = 'ECU SEARCH';
    let first = '';
    for (let attempt = 0; attempt < 2; attempt++) {   // the first 0100 can take seconds while it searches
      try { first = await this.ask('0100', 10000); break; } catch { /* retry once */ }
    }
    if (!this.running) throw new Error('Adapter stopped');
    this.store.log(`> 0100  < ${tidy(first) || '(no reply)'}`);
    const probe = async (pid) => {
      const cmd = '01' + hx(pid);
      let reply = '';
      try { reply = await this.ask(cmd); } catch { /* try the other PID */ }
      if (!this.running) throw new Error('Adapter stopped');
      this.store.log(`> ${cmd}  < ${tidy(reply) || '(no reply)'}`);
      const bytes = parseResponse(reply, pid);
      if (bytes) this._apply(pid, bytes);
      return bytes !== null;
    };
    const rpm = await probe(0x0C), speed = await probe(0x0D);
    if (!rpm && !speed) throw new Error('Adapter answered Bluetooth commands, but the ECU returned no usable RPM or speed data. Is the ignition on? Check the BUS tab.');
    if (!this.basic && (!rpm || !speed || !parseSupport(first, 0x00))) {
      this.basic = true;
      try { await this.ask('ATAT1'); } catch { /* optional adapter setting */ }
    }
    if (this.basic) {
      if (!rpm) this._miss(0x0C);
      if (!speed) this._miss(0x0D);
      for (const pid of [0x11, 0x05, 0x2F]) if (!(await probe(pid))) this._miss(pid);
      this.store.adapter.fast = 'compatibility mode · standard single-PID requests';
      this.store.log('OBD compatibility mode: standard single-PID requests');
    } else await this._tune(first);
    let b = null; try { b = parseResponse(await this.ask('0133' + this.sfx), 0x33); } catch { /* keep the 101.3 kPa default */ }
    if (b) this.baro = b[0];
    if (!this.running) throw new Error('Adapter stopped');
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
      // The bitmap isn't always complete either, so give every unlisted PID one direct try before
      // dropping it (a quick NO DATA costs ~50 ms once, at connect time).
      for (const pid of SLOW) {
        if (all.has(pid)) continue;
        let ok = false;
        try { ok = !!parseResponse(await this.ask('01' + hx(pid) + this.sfx, 700), pid); } catch { /* no answer */ }
        if (ok) { all.add(pid); note.push(hx(pid) + ' answers although not listed'); } else this.unsupported.add(pid);
      }
      // One source per value: skip the alternate PID when the usual one works.
      for (const [main, alt] of [[0x0F, 0x68], [0x10, 0x66], [0x34, 0x24]]) if (!this.unsupported.has(main) && !this.unsupported.has(alt)) { this.unsupported.add(alt); this.redundant.add(alt); }
      // The list can be wrong for the values that matter most (boost, throttle), so ask for them
      // directly before giving up on them.
      for (const pid of FAST) {
        if (pid === 0x0C || pid === 0x0D || all.has(pid)) continue;
        let ok = false;
        try { ok = !!parseResponse(await this.ask('01' + hx(pid) + this.sfx, 1000), pid); } catch { /* no answer */ }
        if (ok) note.push(hx(pid) + ' answers although not listed'); else this.unsupported.add(pid);
      }
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
    const missing = missingValues(this.unsupported);
    if (missing.length) summary += '; this car does not report over OBD: ' + missing.join(', ');
    if (this.running) {
      this.store.log(`fast mode: ${summary}`);
      this.store.adapter = { ...this.store.adapter, fast: summary };
    }
  }

  async _loop() {
    let n = 0, slowAt = 0, multiFails = 0;
    const available = (pid) => !this.unsupported.has(pid) && (this.retryAt.get(pid) ?? 0) <= Date.now();
    const slowNext = (k) => {   // the next k supported slow PIDs, in rotation
      // one PID per request (no batching): live torque joins the slow rotation so rpm keeps its rate
      const list = (this.basic ? BASIC_SLOW : this.mode === 'multi' ? SLOW : [0x62, ...SLOW]).filter(available), out = [];
      for (let i = 0; i < Math.min(k, list.length); i++) out.push(list[(slowAt + i) % list.length]);
      slowAt = list.length ? (slowAt + out.length) % list.length : 0;
      return out;
    };
    while (this.running) {
      if (this.store.paused) { this.store.status = 'PAUSED'; this.rawQ.splice(0).forEach((q) => q.reject(new Error('OBD is paused'))); await new Promise((r) => setTimeout(r, 300)); continue; }
      this.store.status = this.store.count('ble') > 0 ? 'OBD' : 'NO DATA';
      if (this.rawQ.length) await this._drainRaw();
      if (!this.running) return;
      // Batched: when the ECU has no live torque (62), engine load (04) rides along every cycle instead.
      const batched = this.unsupported.has(0x62) && !this.unsupported.has(0x04) ? FAST.filter((p) => p !== 0x62).concat(0x04) : FAST;
      const fast = (this.basic ? BASIC_FAST : this.mode === 'multi' ? batched : FAST.filter((p) => p !== 0x62)).filter(available);
      if (this.mode === 'multi') {
        // one request: the 4 fast PIDs, plus 2 slow ones every other cycle (6 is the OBD limit)
        // multi-sensor PIDs (66, 68) go last so a length surprise can't spoil the values before them
        const pids = n++ % 2 === 0 && !(this.lean > 0) ? fast.concat(slowNext(6 - fast.length >= 2 ? 2 : 6 - fast.length).filter((p) => !fast.includes(p)).sort((a, b) => (a === 0x66 || a === 0x68) - (b === 0x66 || b === 0x68))) : fast;
        const cmd = '01' + pids.map(hx).join('') + this.sfx;
        try {
          const text = await this.ask(cmd, this.pollTimeout);
          if (!this.running || this.store.paused) continue;
          this.store.log(`> ${cmd}  < ${text.replace(/\s+/g, ' ').trim()}`);
          const got = parseMulti(text);
          let any = false, cut = false;
          for (const pid of pids) {
            if (got[pid]) { this._apply(pid, got[pid]); this.ok++; any = true; }
            else { this.fail++; this._miss(pid); cut = true; }
          }
          // reply cut short: only the live values for a while, so replies are shorter on a weak link
          if (any && cut) this.lean = 20; else if (this.lean > 0) this.lean--;
          multiFails = any ? 0 : multiFails + 1;
        } catch (e) {
          if (!this.running) return;
          this.fail++; multiFails++; this.store.log('! ' + e.message);
        }
        if (multiFails >= 4) {   // not for good: batching is tried again after 10 s
          this.mode = 'single'; this.multiRetryAt = Date.now() + (this.multiRetryMs ?? 10000); multiFails = 0;
          this.store.log('! batched requests stopped working; one PID at a time for 10 s');
        }
        continue;
      }
      if (this.multiRetryAt && Date.now() > this.multiRetryAt) { this.mode = 'multi'; this.multiRetryAt = 0; this.store.log('OBD: trying batched requests again'); continue; }
      const pids = this.basic || n % 4 === 0 ? fast.concat(slowNext(1)) : fast;
      n++;
      let asked = 0;
      for (const pid of pids) {
        if (!this.running || this.store.paused) break;
        if (!available(pid)) continue;
        const cmd = '01' + hx(pid) + this.sfx;
        asked++;
        try {
          const text = await this.ask(cmd, this.basic ? Math.max(1500, this.pollTimeout) : this.pollTimeout);
          if (!this.running || this.store.paused) break;
          this.store.log(`> ${cmd}  < ${text.replace(/\s+/g, ' ').trim()}`);
          const bytes = parseResponse(text, pid);
          if (!bytes) { this._miss(pid); this.fail++; continue; }
          this._apply(pid, bytes); this.ok++;
          this.store.status = 'OBD';
        } catch (e) {
          if (!this.running) return;
          if (this.basic && !this.store.paused) this._miss(pid);
          this.fail++; this.store.log('! ' + e.message);
        }
      }
      if (!asked) { this.store.status = 'NO DATA'; await new Promise((r) => setTimeout(r, 1000)); }   // never spin
    }
  }
  _miss(pid) {
    const count = (this.misses[pid] ?? 0) + 1;
    this.misses[pid] = count;
    if (this.basic) {
      const wasLive = this.observed.has(pid);
      if (!wasLive || count > 1) this.retryAt.set(pid, Date.now() + (wasLive ? 2500 : 8000));
    } else if (this.observed.has(pid) || pid === 0x0C || pid === 0x0D) {
      // A value the car has answered before is never dropped: cut-off replies on a weak Bluetooth link used
      // to retire boost / throttle / torque for good after 4 misses. Pause it briefly instead.
      if (count >= 3) { this.retryAt.set(pid, Date.now() + 500); this.misses[pid] = 0; }
    } else if (count >= 4) this.unsupported.add(pid);
  }
  _apply(pid, bytes) {
    this.observed.add(pid); this.retryAt.delete(pid); this.misses[pid] = 0;
    const [key, dec] = PIDS[pid];
    let v; try { v = dec(bytes); } catch { return; }
    if (Number.isNaN(v)) return;
    if (key === '_baro') this.baro = v;
    else if (key === '_map') this.store.set('boost', (v - this.baro) / KPA_PER_PSI, 'ble');
    else if (key === 'lambda') { if (v > 0.5 && v < 2) { this.store.set('lambda', v, 'ble'); this.store.set('afr', v * 14.7, 'ble'); } }   // AFR as gasoline-equivalent
    else this.store.set(key, v, 'ble');
  }
  stop() {
    this.running = false; this.stopped = true;
    const error = new Error('Adapter stopped');
    const wait = this.waiter;
    this.waiter = null;
    if (wait) { clearTimeout(wait.timer); wait.reject(error); }
    this.rawQ.splice(0).forEach((q) => q.reject(error));
    try { this.t.close(); } catch { /* already closed */ }
  }
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
    if (cmd === '0120') return '412000021001';   // supports 0x2F (fuel level), 0x34 (wide-band lambda) and 0x40
    if (cmd === '0140') return '414050000010';   // supports 0x42, 0x44, 0x5C
    if (this.diag && /^(03|07|0A|04|01(01|21|4D|30|31|4E))$/.test(cmd)) return this.diag(cmd);
    const m = /^01([0-9A-F]{2})$/.exec(cmd);
    if (!m) return '?';
    const pid = parseInt(m[1], 16), p = PIDS[pid];
    if (!p) return 'NO DATA';
    const key = p[0];
    let v;
    if (key === '_map') { const b = this.values('boost'); v = b == null ? undefined : b * KPA_PER_PSI + 101; }
    else if (key === '_baro') v = 101;
    else if (key === 'lambda') { const a = this.values('afr'); v = a == null ? undefined : a / 14.7; }
    else v = this.values(key);
    if (v === undefined || v === null) return 'NO DATA';
    return '41' + m[1] + p[2](v).map((x) => Math.max(0, Math.min(255, x)).toString(16).toUpperCase().padStart(2, '0')).join('');
  }
}
