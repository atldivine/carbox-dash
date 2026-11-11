// node tests/adapters.test.mjs
// Checks the driver against the ways real BLE OBD adapters misbehave, and the channel finder against
// plausible GATT layouts. FIXD doesn't publish its layout, so these cover the shapes it could take.
import assert from 'node:assert/strict';
import { Elm327, FakeElmTransport } from '../js/elm327.js';
import { chooseChannel } from '../js/ble.js';
import { Store } from '../js/store.js';

const truth = { rpm: 2800, speed: 41, boost: 6.4, throttle: 35, coolant: 195, iat: 98, battery: 14.2, timing: 21 };

// A fake adapter with quirks layered on top of the clean FakeElmTransport.
class QuirkyAdapter {
  constructor(q = {}) { this.q = q; this.inner = new FakeElmTransport((k) => truth[k]); this.cb = () => {}; this.sawSearch = false; this.resetCount = 0; }
  async open() {}
  close() {}
  onData(cb) { this.cb = cb; this.inner.onData((s) => this._out(s)); }
  write(s) {
    const cmd = s.trim().toUpperCase();
    if (this.q.locked) return;                                              // connects, never answers
    if (this.q.foreign) { setTimeout(() => this.cb('\x02FX\x9b\x01OK\x03'), 10); return; }  // proprietary bytes, no '>'
    if (cmd === 'ATZ' && this.q.ignoreFirstReset && this.resetCount++ === 0) return;
    if (this.q.unknownAt && /^ATL0|ATS0$/.test(cmd)) { setTimeout(() => this.cb('?\r\r>'), 10); return; }
    this.lastCmd = cmd;
    this.inner.write(s);
  }
  _out(s) {
    let text = s;
    const cmd = this.lastCmd || '';
    if (this.q.headers && /^41/.test(text)) text = '7E8 06 ' + text;
    if (this.q.spaces) text = text.replace(/(41[0-9A-F]{2,})/, (hex) => hex.match(/../g).join(' '));
    if (this.q.searching && cmd === '0100' && !this.sawSearch) { this.sawSearch = true; text = 'SEARCHING...\r' + text; }
    if (this.q.echo) text = cmd + '\r' + text;
    if (this.q.crlf) text = text.replace(/\r/g, '\r\n');
    if (this.q.split) {                                                      // arrives in 20-byte BLE packets
      const parts = text.match(/[\s\S]{1,20}/g);
      parts.forEach((p, i) => setTimeout(() => this.cb(p), 5 * i));
    } else this.cb(text);
  }
}

async function run(name, quirks, expectError) {
  const store = new Store();
  const elm = new Elm327(new QuirkyAdapter(quirks), store);
  let err = null;
  try { await elm.start(); await new Promise((r) => setTimeout(r, 1500)); } catch (e) { err = e; }
  elm.stop();
  if (expectError) {
    assert.ok(err, `${name}: expected an error`);
    assert.match(err.message, expectError, `${name}: wrong message: ${err.message}`);
    console.log(`  ok  ${name.padEnd(34)} -> "${err.message.slice(0, 70)}…"`);
    return;
  }
  assert.equal(err, null, `${name}: ${err?.message}`);
  const near = (k, tol) => { const v = store.get(k); assert.ok(v !== null && Math.abs(v - truth[k]) <= tol, `${name}: ${k} want ${truth[k]} got ${v}`); };
  near('rpm', 1); near('speed', 1); near('boost', 0.5); near('throttle', 0.5);
  console.log(`  ok  ${name.padEnd(34)} ${elm.ok} replies, adapter id "${store.adapter?.elm}"`);
}

console.log('adapter behaviours:');
await run('clean ELM327', {});
await run('echo left on', { echo: true });
await run('spaces between bytes', { spaces: true });
await run('CAN headers on', { headers: true });
await run('CR+LF line endings', { crlf: true });
await run('replies split into BLE packets', { split: true });
await run('SEARCHING... before first reply', { searching: true });
await run('ignores the first reset', { ignoreFirstReset: true });
await run("answers '?' to some AT commands", { unknownAt: true });
await run('everything at once', { echo: true, spaces: true, headers: true, crlf: true, split: true, searching: true, ignoreFirstReset: true, unknownAt: true });
await run('locked: connects, never answers', { locked: true }, /never answered.*own app/);
await run('proprietary protocol', { foreign: true }, /not like an ELM327/);

console.log('channel finder:');
const c = (uuid, p) => ({ uuid, read: p.includes('r'), write: p.includes('w'), writeNoResp: p.includes('W'), notify: p.includes('n'), indicate: p.includes('i') });
const L = {
  'generic FFF0 (Vgate style)': [{ uuid: '0000180a-0000-1000-8000-00805f9b34fb', chars: [c('2a29', 'r')] },
    { uuid: '0000fff0-0000-1000-8000-00805f9b34fb', chars: [c('0000fff1-0000-1000-8000-00805f9b34fb', 'n'), c('0000fff2-0000-1000-8000-00805f9b34fb', 'wW')] }],
  'HM-10 FFE0 single characteristic': [{ uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', chars: [c('0000ffe1-0000-1000-8000-00805f9b34fb', 'rwWn')] }],
  'custom 128-bit service (FIXD-like)': [{ uuid: '0000180f-0000-1000-8000-00805f9b34fb', chars: [c('2a19', 'rn')] },
    { uuid: '0000180a-0000-1000-8000-00805f9b34fb', chars: [c('2a24', 'r')] },
    { uuid: 'a1b2c3d4-0000-4000-8000-123456789abc', chars: [c('a1b2c3d5-0000-4000-8000-123456789abc', 'n'), c('a1b2c3d6-0000-4000-8000-123456789abc', 'W')] }],
  'split: notify and write in two services': [{ uuid: 'aaaa0001-0000-4000-8000-000000000000', chars: [c('aaaa0002-0000-4000-8000-000000000000', 'n')] },
    { uuid: 'bbbb0001-0000-4000-8000-000000000000', chars: [c('bbbb0002-0000-4000-8000-000000000000', 'w')] }],
  'battery-only device (not an adapter)': [{ uuid: '0000180f-0000-1000-8000-00805f9b34fb', chars: [c('2a19', 'rn')] }],
};
const want = {
  'generic FFF0 (Vgate style)': ['0000fff1-0000-1000-8000-00805f9b34fb', '0000fff2-0000-1000-8000-00805f9b34fb'],
  'HM-10 FFE0 single characteristic': ['0000ffe1-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
  'custom 128-bit service (FIXD-like)': ['a1b2c3d5-0000-4000-8000-123456789abc', 'a1b2c3d6-0000-4000-8000-123456789abc'],
  'split: notify and write in two services': ['aaaa0002-0000-4000-8000-000000000000', 'bbbb0002-0000-4000-8000-000000000000'],
  'battery-only device (not an adapter)': null,
};
for (const [name, layout] of Object.entries(L)) {
  const ch = chooseChannel(layout);
  if (want[name] === null) assert.equal(ch, null, name);
  else { assert.ok(ch, name); assert.deepEqual([ch.rx, ch.tx], want[name], name); }
  console.log(`  ok  ${name.padEnd(42)} ${ch ? `rx ${ch.rx.slice(0, 8)} tx ${ch.tx.slice(0, 8)}` : 'no channel (correct)'}`);
}
console.log('all adapter tests passed');
