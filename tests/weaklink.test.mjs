// node tests/weaklink.test.mjs -- a weak Bluetooth link: batched replies get cut short, then fail outright for a
// while, then the link recovers. The driver must keep rpm/speed/boost coming, go back to batching by itself
// (it used to stay on one-PID-at-a-time for the rest of the drive), and never retire boost.
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Store } from '../js/store.js';
import { FakeCanCar } from './fake-car.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truth = { rpm: 3200, speed: 45, boost: 9, throttle: 60, coolant: 190, iat: 90, battery: 14.2, timing: 15 };
const car = new FakeCanCar((k) => truth[k]), answer = car._answer.bind(car);
let phase = 'good';
car._answer = (cmd) => {
  const [text, extra] = answer(cmd);
  const batched = /^01([0-9A-F]{2}){2,}/.test(cmd);
  if (batched && phase === 'cut') return [text.split(/\r/).filter((l) => !/^1:/.test(l)).join('\r'), extra];   // 2nd CAN frame lost
  if (batched && phase === 'dead') return ['NO DATA', extra];
  return [text, extra];
};
const store = new Store(), elm = new Elm327(car, store);
elm.multiRetryMs = 1500;
await elm.start();
assert.equal(elm.mode, 'multi', 'starts batched');

phase = 'cut'; await sleep(1500);
assert.ok(store.get('rpm') != null && store.get('speed') != null, 'rpm/speed keep coming while replies are cut');
assert.ok(elm.lean > 0, 'went lean (live values only) on cut replies');

phase = 'dead'; await sleep(1500);
assert.equal(elm.mode, 'single', 'falls back to one PID at a time when batching fails');
assert.ok(store.get('boost') != null, 'boost still coming one PID at a time');

phase = 'good'; await sleep(2500);
assert.equal(elm.mode, 'multi', 'goes back to batched requests by itself');
assert.ok(!elm.unsupported.has(0x0B) && !elm.unsupported.has(0x11), 'boost/throttle never retired');
for (let i = 0; i < 30 && elm.lean > 0; i++) await sleep(100);
assert.equal(elm.lean, 0, 'back to full batches once replies are whole again');
elm.stop();
console.log('weak link ok: cut replies -> lean, failed batches -> one PID for a while -> batched again; boost never lost');
