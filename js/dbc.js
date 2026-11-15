// Minimal DBC reader: messages (BO_), signals (SG_) with Intel / Motorola byte order, signed values,
// scale and offset, and simple multiplexing. Enough for the DBCs the cansub-reverse-engineering
// skill writes (decoding-output/<app>/<app>.dbc). encodeMessage() is used by the simulator and tests.

export function parseDbc(text) {
  const db = { messages: [], byId: new Map() };
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line);
    if (m) {
      let id = Number(m[1]); const ext = id >= 0x80000000; if (ext) id -= 0x80000000;   // bit 31 marks extended IDs
      cur = { id, ext, name: m[2], len: Number(m[3]), sender: m[4], signals: [] };
      db.messages.push(cur); db.byId.set(id, cur); continue;
    }
    m = /^SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\[\s*([-\d.eE+]+)\s*\|\s*([-\d.eE+]+)\s*\]\s*"([^"]*)"/.exec(line);
    if (m && cur) {
      cur.signals.push({ name: m[1], mux: m[2] || null, start: +m[3], len: +m[4], intel: m[5] === '1', signed: m[6] === '-',
        scale: +m[7], offset: +m[8], min: +m[9], max: +m[10], unit: m[11] });
      continue;
    }
    if (line && !line.startsWith('SG_')) cur = null;   // any other statement ends the message
  }
  return db;
}

// Bit positions of a signal, least significant bit first.
function bitPositions(s) {
  const bits = [];
  if (s.intel) for (let i = 0; i < s.len; i++) bits.push(s.start + i);
  else {
    // Motorola: start bit is the MSB in DBC "sawtooth" numbering; walk toward the LSB.
    let b = s.start;
    const msbFirst = [];
    for (let i = 0; i < s.len; i++) { msbFirst.push(b); b = b % 8 === 0 ? b + 15 : b - 1; }
    bits.push(...msbFirst.reverse());
  }
  return bits;
}

export function rawValue(s, data) {
  let v = 0, mul = 1;
  for (const b of bitPositions(s)) { const byte = b >> 3; if (byte >= data.length) return null; if (data[byte] & (1 << (b & 7))) v += mul; mul *= 2; }
  if (s.signed && v >= mul / 2) v -= mul;
  return v;
}

/** { signalName: physicalValue } for one frame. Multiplexed signals only when their mux value matches. */
export function decodeMessage(msg, data) {
  const out = {};
  const muxSig = msg.signals.find((s) => s.mux === 'M');
  const muxVal = muxSig ? rawValue(muxSig, data) : null;
  for (const s of msg.signals) {
    if (s.mux && s.mux !== 'M' && Number(s.mux.slice(1)) !== muxVal) continue;
    const r = rawValue(s, data);
    if (r !== null) out[s.name] = r * s.scale + s.offset;
  }
  return out;
}

/** Inverse of decodeMessage: { signalName: value } -> bytes. */
export function encodeMessage(msg, values) {
  const data = new Uint8Array(msg.len);
  for (const s of msg.signals) {
    if (!(s.name in values)) continue;
    let r = Math.round((values[s.name] - s.offset) / s.scale);
    const span = 2 ** s.len;
    if (r < 0) r += span;
    r = Math.max(0, Math.min(span - 1, r));
    for (const b of bitPositions(s)) { if (r % 2) data[b >> 3] |= 1 << (b & 7); r = Math.floor(r / 2); }
  }
  return data;
}
