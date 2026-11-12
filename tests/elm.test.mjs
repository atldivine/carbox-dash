// node tests/elm.test.mjs  -- checks the ELM327 driver end to end against a fake adapter.
import assert from 'node:assert/strict';
import { Elm327, FakeElmTransport, parseResponse, parseMulti, parseSupport } from '../js/elm327.js';
import { Store } from '../js/store.js';
import { Derived } from '../js/derive.js';

// parsing
assert.deepEqual(parseResponse('410C1AF8', 0x0C), [0x1A, 0xF8]);
assert.deepEqual(parseResponse('41 0D 3C ', 0x0D), [0x3C]);
assert.equal(parseResponse('NO DATA', 0x0C), null);
assert.equal(parseResponse('SEARCHING...\rUNABLE TO CONNECT', 0x0C), null);
assert.deepEqual(parseResponse('SEARCHING...\r410D50', 0x0D), [0x50]);

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

// gear detection: 3rd gear at 45 mph with the Z 6-speed's ratios (final drive 3.538)
const s2 = new Store(); s2.set('rpm', 45 / 2.23694 / 2.121 * 60 * 1.624 * 3.538); s2.set('speed', 45);
const d = new Derived(s2);
assert.equal(d.calcGear(s2.get('rpm'), 45), '3');
assert.equal(d.calcGear(800, 0), 'N');
assert.equal(d.calcGear(5000, 20), 'N', 'rpm far off any gear means clutch in');
console.log('gear detection ok');
