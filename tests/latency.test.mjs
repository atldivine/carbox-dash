// node tests/latency.test.mjs
// How long a change at the engine (say, you floor it) takes to reach the app, and how often each value
// refreshes, against a fake CAN car with realistic BLE + ELM327 timing (tests/fake-car.mjs).
// Also checks the driver still works on older clones that can't batch PIDs or take a response count.
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Store } from '../js/store.js';
import { FakeCanCar } from './fake-car.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(name, opt, limits) {
  const truth = { rpm: 900, speed: 30, boost: -10, throttle: 5, coolant: 194, iat: 95, battery: 14.2, timing: 20 };
  const store = new Store();
  const updates = {};
  const set = store.set.bind(store);
  store.set = (k, v) => { updates[k] = (updates[k] || 0) + 1; set(k, v); };
  const elm = new Elm327(new FakeCanCar((k) => truth[k], opt), store);
  await elm.start();
  await sleep(300);
  for (const k in updates) updates[k] = 0;
  const lags = [];
  const t0 = performance.now();
  for (let i = 0; i < 12; i++) {
    const want = 2000 + ((i * 1373) % 4500);           // a new rpm, like stabbing the throttle
    truth.rpm = want; truth.throttle = (i * 37) % 100;
    const tc = performance.now();
    while (Math.abs((store.get('rpm') ?? -1) - want) > 1 && performance.now() - tc < 3000) await sleep(2);
    lags.push(performance.now() - tc);
    await sleep(150 + (i * 53) % 200);
  }
  const secs = (performance.now() - t0) / 1000;
  elm.stop();
  const avg = lags.reduce((a, b) => a + b) / lags.length, worst = Math.max(...lags);
  const hz = (k) => (updates[k] || 0) / secs;
  console.log(`  ${name.padEnd(30)} rpm lag avg ${avg.toFixed(0).padStart(4)} ms, worst ${worst.toFixed(0).padStart(4)} ms | ` +
    `rpm ${hz('rpm').toFixed(1)} Hz, boost ${hz('boost').toFixed(1)} Hz, throttle ${hz('throttle').toFixed(1)} Hz, coolant ${hz('coolant').toFixed(2)} Hz | mode: ${elm.mode || 'single'}`);
  for (const k of ['speed', 'boost', ...(limits ? ['coolant', 'iat', 'battery', 'timing'] : [])]) assert.ok(store.get(k) !== null || updates[k], `${name}: ${k} never arrived`);
  assert.equal(store.get('oil_temp'), null, `${name}: unsupported PID must stay empty`);
  if (limits) {
    assert.ok(avg <= limits.avg, `${name}: average lag ${avg.toFixed(0)} ms > ${limits.avg}`);
    assert.ok(hz('rpm') >= limits.hz, `${name}: rpm ${hz('rpm').toFixed(1)} Hz < ${limits.hz}`);
  }
  return { avg, hz: hz('rpm') };
}

console.log('latency (fake CAN car, realistic BLE timing):');
await measure('modern adapter', {}, { avg: 110, hz: 10 });
// one-at-a-time modes also fetch 2 slow values per round so temps etc. never go blank: ~4 Hz rpm
await measure('no ATSH (header locked)', { setHeader: false }, { avg: 210, hz: 3.7 });
await measure('no PID batching', { multi: false }, { avg: 210, hz: 3.7 });
{   // the car's supported-PID list leaves out boost (0B) but it answers anyway: it must still show up
  const truth = { rpm: 2000, speed: 20, boost: 7.5, throttle: 40, coolant: 190, iat: 90, battery: 14.1, timing: 15 };
  const store = new Store();
  const elm = new Elm327(new FakeCanCar((k) => truth[k], { hideFromList: [0x0B] }), store);
  await elm.start(); await sleep(400); elm.stop();
  assert.ok(Math.abs(store.get('boost') - 7.5) < 0.6, 'boost missing when the list leaves it out: ' + store.get('boost'));
  console.log('  ok  boost answered although not in the supported list');
}
await measure('old clone (nothing extra)', { multi: false, count: false, setHeader: false });
console.log('latency ok (before this change: ~400 ms average lag, rpm 1.5 Hz on the modern adapter)');
