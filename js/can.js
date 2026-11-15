// Raw CAN bus input. Reads a CSS Electronics CANsub over its WebSocket API (HDLC framing, byte
// stuffing, CRC32, serialized CAN frames; format per the CANsub.4 manual, checked against its test
// vectors in tests/can.test.mjs), decodes frames with a DBC (js/dbc.js) and writes the signals to
// the store. Also counts messages per second per module for the BUS tab and the boot screen.
import { parseDbc, decodeMessage } from './dbc.js';

const TS_EPOCH_US = 1735689600000000;   // CANsub timestamps: microseconds since 2025-01-01 UTC
const FD_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Streaming HDLC deframer: feed() bytes as they arrive, get back verified payloads. */
export class Hdlc {
  constructor() { this.buf = []; this.inFrame = false; this.esc = false; this.bad = 0; }
  feed(bytes) {
    const out = [];
    for (const b of bytes) {
      if (b === 0x7E) {
        if (this.inFrame && this.buf.length >= 4) {
          const p = this.buf, n = p.length - 4;
          const want = ((p[n] << 24) | (p[n + 1] << 16) | (p[n + 2] << 8) | p[n + 3]) >>> 0;
          const payload = Uint8Array.from(p.slice(0, n));
          if (crc32(payload) === want) out.push(payload); else this.bad++;
        }
        this.buf = []; this.inFrame = true; this.esc = false;   // a boundary both ends one frame and starts the next
        continue;
      }
      if (!this.inFrame) continue;
      if (this.esc) { this.buf.push(b ^ 0x20); this.esc = false; }
      else if (b === 0x7D) this.esc = true;
      else this.buf.push(b);
    }
    return out;
  }
}

/** Serialized CAN frames in one payload -> [{ t (ms since 1970), id, ext, fd, rtr, tx, data }]. Error frames are counted, not returned. */
export function parseFrames(p, stats) {
  const out = [];
  let i = 0;
  while (i + 7 <= p.length) {
    let ts = 0; for (let k = 0; k < 6; k++) ts = ts * 256 + p[i + k];
    const f = p[i + 6];
    if (f & 0x20 && !(f & 0x80)) { if (stats) stats.errors = (stats.errors || 0) + 1; i += 7; continue; }   // error frame
    const fd = !!(f & 0x80), rtr = !fd && !!(f & 0x40), tx = !!(f & 0x10), dlc = f & 0x0F;
    if (i + 9 > p.length) break;
    const ext = !!(p[i + 7] & 0x80);
    let id, at;
    if (ext) { if (i + 11 > p.length) break; id = ((p[i + 7] & 0x1F) * 0x1000000) + (p[i + 8] << 16) + (p[i + 9] << 8) + p[i + 10]; at = i + 11; }
    else { id = ((p[i + 7] & 0x07) << 8) | p[i + 8]; at = i + 9; }
    const len = rtr ? 0 : fd ? FD_LEN[dlc] : Math.min(8, dlc);
    if (at + len > p.length) break;
    out.push({ t: (ts + TS_EPOCH_US) / 1000, id, ext, fd, rtr, tx, dlc, data: p.slice(at, at + len) });
    i = at + len;
  }
  return out;
}

/** WebSocket link to a CANsub channel. host e.g. "aabbccdd-eth.local" or an IP; listen only (never transmits). */
export class CansubTransport {
  constructor(host, channel = 0) { this.host = host; this.channel = channel; this.ws = null; this.onFrames = () => {}; this.onState = () => {}; this.stats = { bad: 0, errors: 0 }; }
  open() {
    return new Promise((resolve, reject) => {
      const url = `wss://${this.host}/api/can/${this.channel}/ws`;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      const hdlc = new Hdlc();
      const timer = setTimeout(() => { ws.close(); reject(new Error('CANsub did not answer at ' + this.host + ' (same Wi-Fi? certificate trusted?)')); }, 6000);
      ws.onopen = () => { clearTimeout(timer); this.onState('CAN'); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not open ' + url + '. On iPhone the CANsub certificate must be installed and trusted.')); };
      ws.onclose = () => this.onState('CLOSED');
      ws.onmessage = (e) => {
        const payloads = hdlc.feed(new Uint8Array(e.data));
        this.stats.bad = hdlc.bad;
        for (const p of payloads) { const fr = parseFrames(p, this.stats); if (fr.length) this.onFrames(fr); }
      };
      this.ws = ws;
    });
  }
  close() { try { this.ws?.close(); } catch { /* already closed */ } this.ws = null; }
}

// Which module each CAN ID comes from, for the "listening" boot screen and the BUS tab. Filled from the
// DBC's BO_ transmitter names; IDs the DBC doesn't know are grouped as "OTHER".
export class CanSource {
  constructor(store, dbcText, keyMap) {
    this.store = store; this.keyMap = keyMap || {};
    this.db = parseDbc(dbcText || '');
    this.counts = new Map(); this.rates = {}; this.nodeRates = {}; this._t = performance.now(); this.total = 0; this.decoded = 0;
    this.last = new Map();     // id -> latest data (BUS tab)
    this.transport = null;
  }
  setDbc(text) { this.db = parseDbc(text); }
  /** Frames from any transport (CANsub, simulator, replayed log). */
  ingest(frames, source = 'can') {
    for (const f of frames) {
      if (f.tx || f.rtr) continue;
      this.total++;
      this.counts.set(f.id, (this.counts.get(f.id) || 0) + 1);
      this.last.set(f.id, f.data);
      const msg = this.db.byId.get(f.id);
      if (!msg) continue;
      const vals = decodeMessage(msg, f.data);
      for (const name in vals) {
        const key = this.keyMap[name] || this.keyMap[name.toLowerCase()];
        if (key) { this.store.set(key, vals[name], source); this.decoded++; }
      }
    }
    const now = performance.now();
    if (now - this._t >= 1000) {   // per-second rates by ID and by module
      const s = (now - this._t) / 1000, nodes = {};
      this.rates = {};
      for (const [id, n] of this.counts) {
        this.rates[id] = n / s;
        const node = this.db.byId.get(id)?.sender || 'OTHER';
        nodes[node] = (nodes[node] || 0) + n / s;
      }
      this.nodeRates = nodes; this.counts.clear(); this._t = now;
    }
  }
  async connect(host, channel = 0) {
    this.transport = new CansubTransport(host, channel);
    this.transport.onFrames = (fr) => this.ingest(fr);
    this.transport.onState = (s) => { if (s === 'CLOSED' && this.store.source === 'can') this.store.status = 'CAN CLOSED'; };
    await this.transport.open();
  }
  close() { this.transport?.close(); this.transport = null; }
  get msgRate() { return Object.values(this.rates).reduce((a, b) => a + b, 0); }
}
