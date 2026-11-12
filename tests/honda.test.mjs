// node tests/honda.test.mjs
// A fussy ECU like the Integra's might be: batched requests answered only in part, and the odd NO DATA.
// Every gauge the car offers must keep showing a fresh value for the whole drive.
import assert from 'node:assert/strict';
import { Elm327 } from '../js/elm327.js';
import { Store } from '../js/store.js';
import { FakeCanCar } from './fake-car.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Honda 1.5T-like: MAP, wide-band O2 (34), load, DI rail pressure, no oil temp / ethanol
const HONDA = [0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x23, 0x33, 0x34, 0x42];
const truth = { rpm: 3200, speed: 41, boost: 12.5, throttle: 70, coolant: 194, iat: 95, battery: 14.2, timing: 18, afr: 12.1, load: 78, fuel_pressure: 2175 };
const KEYS = ['rpm', 'speed', 'boost', 'afr', 'throttle', 'coolant', 'iat', 'battery', 'timing', 'load', 'fuel_pressure'];

async function drive(name, opt, secs = 25) {
  const store = new Store(), elm = new Elm327(new FakeCanCar((k) => truth[k], { supported: HONDA, ...opt }), store);
  await elm.start();
  const blank = Object.fromEntries(KEYS.map((k) => [k, 0]));
  let checks = 0;
  for (let t = 0; t < secs * 4; t++) {           // look at the screen 4 times a second
    await sleep(250);
    if (t < 8) continue;                          // first 2 s: still filling in
    checks++;
    for (const k of KEYS) if (store.get(k) === null) blank[k]++;
  }
  elm.stop();
  const bad = KEYS.filter((k) => blank[k] / checks > 0.02);
  console.log(`  ${name.padEnd(42)} mode ${elm.mode.padEnd(6)} blank: ${KEYS.map((k) => `${k} ${Math.round(blank[k] / checks * 100)}%`).filter((x) => !/ 0%$/.test(x)).join(', ') || 'none'}`);
  return bad;
}
const cases = [
  ['batched, ECU answers 3 PIDs per request', { multiMax: 3 }],
  ['one at a time (no batching), 3 % NO DATA', { multi: false, noData: 0.03 }],
  ['batched, 3 % NO DATA', { noData: 0.03 }],
  ['one at a time, old clone (no reply count)', { multi: false, count: false, setHeader: false, noData: 0.02 }],
];
{   // coolant goes quiet for 5 s mid-drive (ECU busy), then answers again: it must come back by itself
  const store = new Store(), elm = new Elm327(new FakeCanCar((k) => truth[k], { supported: HONDA, multi: false, outage: { pid: 0x05, from: 4000, to: 9000 } }), store);
  await elm.start(); await sleep(24000); elm.stop();
  assert.ok(store.get('coolant') !== null, 'coolant came back after going quiet');
  console.log('  ok  a value that goes quiet for 5 s comes back on its own');
}
let failed = [];
for (const [name, opt] of cases) { const bad = await drive(name, opt); if (bad.length) failed.push(`${name}: ${bad.join(', ')}`); }
assert.deepEqual(failed, [], 'gauges went blank:\n  ' + failed.join('\n  '));
console.log('honda ok');
