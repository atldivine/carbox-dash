// node tests/elm.test.mjs  -- checks the ELM327 driver end to end against a fake adapter.
import assert from 'node:assert/strict';
import { Elm327, FakeElmTransport, parseResponse, parseMulti, parseSupport } from '../js/elm327.js';
import { Store } from '../js/store.js';
import { Derived, FINAL_6MT } from '../js/derive.js';

// parsing
assert.deepEqual(parseResponse('410C1AF8', 0x0C), [0x1A, 0xF8]);
assert.deepEqual(parseResponse('41 0D 3C ', 0x0D), [0x3C]);
assert.equal(parseResponse('NO DATA', 0x0C), null);
assert.equal(parseResponse('SEARCHING...\rUNABLE TO CONNECT', 0x0C), null);
assert.deepEqual(parseResponse('SEARCHING...\r410D50', 0x0D), [0x50]);
assert.deepEqual(parseResponse('NO DATA\r41 0D 00', 0x0D), [0], 'a second ECU can return useful data');
assert.equal(parseResponse('41 0C 1A\r41 0D 00', 0x0C), null, 'a partial RPM reply must not consume the next line');

// several PIDs in one reply: multi-frame (length line + numbered frames), with and without spaces
assert.deepEqual(parseMulti('00A\r0:410C1AF80D3C\r1:0B651180000000'), { 0x0C: [0x1A, 0xF8], 0x0D: [0x3C], 0x0B: [0x65], 0x11: [0x80] });
assert.deepEqual(parseMulti('00A\r\n0: 41 0C 1A F8 0D 3C \r\n1: 0B 65 11 80 AA AA AA'), { 0x0C: [0x1A, 0xF8], 0x0D: [0x3C], 0x0B: [0x65], 0x11: [0x80] });
assert.deepEqual(parseMulti('410C1AF80D3C'), { 0x0C: [0x1A, 0xF8], 0x0D: [0x3C] });                  // fits one frame
assert.deepEqual(parseMulti('410C1AF80D3C\r410D3C'), { 0x0C: [0x1A, 0xF8], 0x0D: [0x3C] });          // 2nd ECU ignored
assert.deepEqual(parseMulti('00A\r0:410C1AF8'), { 0x0C: [0x1A, 0xF8] }, 'cut-off reply keeps what is complete');
assert.deepEqual(parseMulti('NO DATA'), {});
assert.deepEqual(parseMulti('?'), {});
assert.deepEqual([...parseSupport('4100BE3FA813', 0x00)].filter((p) => [0x0C, 0x0D, 0x0B, 0x11, 0x05, 0x20].includes(p)).sort(), [0x05, 0x0B, 0x0C, 0x0D, 0x11, 0x20].sort());

// end to end: truth values -> fake adapter -> driver -> store
const truth = { rpm: 3250, speed: 62, boost: 14.2, throttle: 80, coolant: 194, iat: 101, battery: 14.3, timing: 18, oil_temp: 215 };
const store = new Store();
const elm = new Elm327(new FakeElmTransport((k) => truth[k]), store);
await elm.start();
await new Promise((r) => setTimeout(r, 2500));
elm.stop();

const near = (key, want, tol) => { const got = store.get(key); assert.ok(got !== null && Math.abs(got - want) <= tol, `${key}: want ${want}±${tol}, got ${got}`); };
near('rpm', 3250, 1); near('speed', 62, 1); near('boost', 14.2, 0.5); near('throttle', 80, 0.5);
near('coolant', 194, 1); near('iat', 101, 1); near('battery', 14.3, 0.01); near('timing', 18, 0.5); near('oil_temp', 215, 1);
assert.equal(store.get('ethanol'), null, 'unsupported PID must stay empty, not 0');
assert.ok(elm.ok > 20, 'polled ' + elm.ok);
console.log(`ELM327 ok: ${elm.ok} good replies, ${elm.fail} misses, status ${store.status}`);

// gear detection: 3rd gear at 45 mph is about 3,060 rpm with the 6-speed's ratios
const s2 = new Store(); s2.set('rpm', 45 / 2.23694 / 2.121 * 60 * 1.624 * FINAL_6MT); s2.set('speed', 45);
const d = new Derived(s2);
assert.equal(d.calcGear(s2.get('rpm'), 45), '3');
assert.equal(d.calcGear(800, 0), 'N');
assert.equal(d.calcGear(5000, 20), 'N', 'rpm far off any gear means clutch in');
console.log('gear detection ok');

// Replies copied from the user's Z (BUS tab, 2026-11-15): engine ECU direct, reply count, 4 PIDs per request
{
  const idle = parseMulti('00A\r0: 410C0B540D00\r1: 0B25111C000000');
  assert.deepEqual(idle, { 0x0C: [0x0B, 0x54], 0x0D: [0], 0x0B: [0x25], 0x11: [0x1C] });   // 724.5 rpm, 0 mph, MAP 37 kPa, throttle 11%
  const six = parseMulti('011\r0: 410C0B220D00\r1: 0B25111C2481F2\r2: 80000641000000');   // + 24 (wide-band lambda) and 06 (trim)
  assert.deepEqual(six[0x24], [0x81, 0xF2, 0x80, 0x00]); assert.deepEqual(six[0x06], [0x41]);
  console.log('real Z replies parse ok');
}

// A Z-like ECU: bitmap leaves out 0F/10/34/52, intake temp comes from 68 instead, ethanol from nowhere
{
  const { PIDS } = await import('../js/elm327.js');
  const truth = { rpm: 725, speed: 0, boost: -10.4, throttle: 11, coolant: 190, iat: 86, battery: 14.4, timing: 4 };
  const fake = new FakeElmTransport((k) => truth[k]);
  const answer = fake._answer.bind(fake), has = new Set([0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x11, 0x20]);
  const bitmap = (base, set) => { let b = [0, 0, 0, 0]; for (const p of set) if (p > base && p <= base + 32) { const i = p - base - 1; b[i >> 3] |= 0x80 >> (i & 7); } return '41' + base.toString(16).toUpperCase().padStart(2, '0') + b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(''); };
  fake._answer = (cmd) => {
    if (cmd === '0100') return bitmap(0, has);
    if (cmd === '0120') return bitmap(0x20, [0x24, 0x33, 0x40]);
    if (cmd === '0140') return bitmap(0x40, [0x42, 0x44, 0x5C, 0x68]);
    if (/^01(0F|10|34|52|66)$/.test(cmd)) return 'NO DATA';
    return answer(cmd);
  };
  const st = new Store(), e = new Elm327(fake, st);
  await e.start();
  for (let i = 0; i < 100 && st.get('iat') == null; i++) await new Promise((r) => setTimeout(r, 100));   // 68 is last in the slow rotation
  e.stop();
  assert.ok(Math.abs(st.get('iat') - 86) <= 1, 'intake temp via PID 68: ' + st.get('iat'));
  const fast = st.adapter.fast;
  assert.ok(!/not offered/.test(fast) && /ethanol/.test(fast) && !/intake temp/.test(fast), fast);
  console.log('Z-like ECU ok: intake temp from PID 68; summary: ' + fast.split('; ').pop());
}
