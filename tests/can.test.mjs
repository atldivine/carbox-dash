// node tests/can.test.mjs -- CANsub WebSocket decoding (official test vectors), DBC decoding, CAN -> store.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hdlc, parseFrames, crc32, CanSource } from '../js/can.js';
import { parseDbc, decodeMessage, encodeMessage, rawValue } from '../js/dbc.js';
import { Store } from '../js/store.js';
import { CAN_KEYS } from '../js/canmap.js';

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);

// CANsub.4 manual, WebSocket API test vectors TV-01..TV-04
const tv = (net) => { const h = new Hdlc(), p = h.feed(hex(net)); assert.equal(h.bad, 0, 'CRC ok'); assert.equal(p.length, 1); return parseFrames(p[0]); };
let f = tv('7E 1C AE 8C 13 E0 00 01 07 FF 00 98 4F D1 B8 7E')[0];
assert.equal(iso(f.t), '2026-01-01T00:00:00'); assert.equal(f.id, 0x7FF); assert.equal(f.ext, false); assert.equal(f.dlc, 1); assert.deepEqual([...f.data], [0]);
f = tv('7E 39 5D 18 27 C0 00 01 9F FF FF FF 00 82 83 9F 92 7E')[0];
assert.equal(iso(f.t), '2027-01-01T00:00:00'); assert.equal(f.id, 0x1FFFFFFF); assert.equal(f.ext, true);
f = tv('7E 00 00 00 00 00 00 48 00 01 EF 87 F8 40 7E')[0];
assert.equal(f.rtr, true); assert.equal(f.dlc, 8); assert.equal(f.data.length, 0); assert.equal(f.id, 1);
f = tv('7E 00 00 00 00 00 00 81 00 01 00 AF 74 88 69 7E')[0];
assert.equal(f.fd, true); assert.equal(f.id, 1); assert.deepEqual([...f.data], [0]);
// split across WebSocket messages, and a corrupted frame is dropped
{
  const h = new Hdlc(), a = hex('7E 1C AE 8C 13 E0 00 01'), b = hex('07 FF 00 98 4F D1 B8 7E');
  assert.equal(h.feed(a).length, 0); assert.equal(h.feed(b).length, 1);
  const bad = hex('7E 1C AE 8C 13 E0 00 01 07 FF 01 98 4F D1 B8 7E');
  assert.equal(h.feed(bad).length, 0); assert.equal(h.bad, 1);
}
// byte stuffing: build a frame whose payload contains 0x7E / 0x7D
{
  const payload = [0, 0, 0, 0, 0, 0, 0x02, 0x01, 0x23, 0x7E, 0x7D], c = crc32(Uint8Array.from(payload));
  const body = [...payload, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255].flatMap((x) => (x === 0x7E || x === 0x7D ? [0x7D, x ^ 0x20] : [x]));
  const out = new Hdlc().feed(Uint8Array.from([0x7E, ...body, 0x7E]));
  const fr = parseFrames(out[0])[0];
  assert.equal(fr.id, 0x123); assert.deepEqual([...fr.data], [0x7E, 0x7D]);
}
console.log('CANsub WebSocket decoding ok (TV-01..TV-04, split, CRC, stuffing)');

// DBC: Intel and Motorola, signed, scale/offset, round trip
const db = parseDbc(`BO_ 100 T: 8 X
 SG_ a : 0|16@1- (0.1,0) [-100|100] "deg" X
 SG_ b : 23|16@0+ (1,0) [0|65535] "" X
 SG_ c : 40|8@1+ (1.8,-40) [0|0] "degF" X
BO_ 2565865471 Ext: 8 X
 SG_ e : 0|8@1+ (1,0) [0|255] "" X`);
const T = db.byId.get(100);
assert.equal(rawValue(T.signals[1], [0, 0, 0x12, 0x34, 0, 0, 0, 0]), 0x1234, 'Motorola');
const vals = { a: -12.3, b: 4660, c: 194 };
const back = decodeMessage(T, encodeMessage(T, vals));
assert.ok(Math.abs(back.a - -12.3) < 1e-9 && back.b === 4660 && Math.abs(back.c - 194) < 1.8, JSON.stringify(back));
assert.ok(db.byId.get(0x18EFFFFF)?.ext, 'extended ID from bit 31');

// starter Z DBC -> store keys
const zdb = parseDbc(readFileSync(new URL('../data/z-can.dbc', import.meta.url), 'utf8'));
assert.ok(zdb.messages.length >= 9);
for (const m of zdb.messages) for (const s of m.signals) assert.ok(CAN_KEYS[s.name], 'no store key for ' + s.name);
const store = new Store(), src = new CanSource(store, readFileSync(new URL('../data/z-can.dbc', import.meta.url), 'utf8'), CAN_KEYS);
const msg = (id, v) => ({ id, data: encodeMessage(zdb.byId.get(id), v) });
src.ingest([msg(2, { steer: -45.5 }), msg(644, { ws_fl: 31, ws_fr: 31.2 }), msg(1549, { locked: 1, belt: 0 }), msg(852, { brake: 42 })]);
assert.ok(Math.abs(store.get('steer') + 45.5) < 0.11); assert.ok(Math.abs(store.get('ws_fr') - 31.2) < 0.01);
assert.equal(store.get('locked'), 1); assert.equal(store.get('belt'), 0); assert.equal(store.get('brake'), 42);
console.log('DBC decoding ok; starter Z DBC maps every signal to the dash');
