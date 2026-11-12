// node tests/cars.test.mjs
// Car profiles: gear detection for each car (incl. learning a tyre-size error), and that every gauge
// gets a value from the PIDs each kind of car actually offers.
import assert from 'node:assert/strict';
import { CARS, MPH_PER_MPS } from '../js/cars.js';
import { Derived } from '../js/derive.js';
import { Store } from '../js/store.js';
import { Elm327 } from '../js/elm327.js';
import { FakeCanCar } from './fake-car.mjs';

const rpmAt = (car, gear, mph, err = 1) => mph / MPH_PER_MPS / car.tire * 60 * car.ratios[gear - 1] * car.final * err;

// 1. every gear of every car reads right, from crawling to near redline
for (const car of Object.values(CARS)) {
  const d = new Derived(new Store(), { car: car.id });
  for (let g = 1; g <= car.ratios.length; g++) {
    for (let mph = 5; mph < 180; mph += 3) {
      const rpm = rpmAt(car, g, mph);
      if (rpm < 1000 || rpm > car.rpm.crit) continue;
      assert.equal(d.calcGear(rpm, mph), String(g), `${car.id}: gear ${g} at ${mph} mph / ${Math.round(rpm)} rpm`);
    }
  }
  assert.equal(d.calcGear(850, 0), 'N', `${car.id}: stopped`);
}
console.log('  ok  every gear of every car');

// 2. the Integra with tyres 6 % bigger round than stock (or a speedo 6 % off): reads after learning
{
  const car = CARS['integra-6mt'], s = new Store(), d = new Derived(s, { car: car.id });
  let t = 0;
  const drive = (g, mph, secs) => { for (let i = 0; i < secs * 30; i++) { s.set('rpm', rpmAt(car, g, mph, 1.06)); s.set('speed', mph); d.update(t += 33); } };
  drive(3, 40, 6);
  assert.ok(d.k > 1.04, 'learned the 6 % error: k=' + d.k.toFixed(3));
  for (let g = 1; g <= 6; g++) {
    const mph = [20, 30, 45, 60, 70, 80][g - 1];
    assert.equal(d.calcGear(rpmAt(car, g, mph, 1.06), mph), String(g), `learned gear ${g}`);
  }
  console.log(`  ok  Integra learns a 6 % tyre/speedo error (k = ${d.k.toFixed(3)})`);
}

// 3. the Z automatic is not read with the manual's gearing (why the gear stuck on N)
{
  const at = CARS['z-9at'], mt = new Derived(new Store(), { car: 'z-6mt' }), auto = new Derived(new Store(), { car: 'z-9at' });
  let wrong = 0, total = 0;
  for (let g = 1; g <= 9; g++) for (let mph = 10; mph < 150; mph += 5) {
    const rpm = rpmAt(at, g, mph); if (rpm < 1100 || rpm > 6800) continue;
    total++; if (mt.calcGear(rpm, mph) !== String(g)) wrong++;
    assert.equal(auto.calcGear(rpm, mph), String(g));
  }
  assert.ok(wrong / total > 0.5, 'manual gearing misreads the automatic');
  console.log(`  ok  Z 9AT profile reads every gear (6MT gearing got ${Math.round(wrong / total * 100)} % wrong)`);
}

// 4. PIDs: every gauge fills on an Integra-like ECU, a car with boost only on PID 70, and a car with no boost
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(supported, truth) {
  const store = new Store(), elm = new Elm327(new FakeCanCar((k) => truth[k], { supported }), store);
  await elm.start(); await sleep(700); elm.stop();
  return { store, elm };
}
const truth = { rpm: 3200, speed: 41, boost: 12.5, throttle: 70, coolant: 194, iat: 95, battery: 14.2, timing: 18, afr: 12.1, load: 78, fuel_pressure: 2175 };
{
  // Honda 1.5T: MAP, wide-band lambda (34), load, DI rail pressure; no oil temp / ethanol
  const { store, elm } = await connect([0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x23, 0x33, 0x34, 0x42], truth);
  for (const k of ['rpm', 'speed', 'boost', 'throttle', 'coolant', 'iat', 'battery', 'timing', 'afr', 'load', 'fuel_pressure']) {
    const tol = { boost: 0.2, afr: 0.05, fuel_pressure: 2, speed: 1 }[k] ?? 1;
    assert.ok(Math.abs(store.get(k) - truth[k]) <= tol, `Integra: ${k} = ${store.get(k)}, want ${truth[k]}`);
  }
  assert.equal(store.get('oil_temp'), null); assert.equal(elm.mode, 'multi');
  assert.match(store.adapter.fast, /boost from 0B, air\/fuel from 34/);
  console.log('  ok  Integra-like ECU: every gauge reads (' + store.adapter.fast + ')');
}
{
  const { store } = await connect([0x05, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x33, 0x42, 0x70], truth);
  assert.ok(Math.abs(store.get('boost') - 12.5) < 0.2, 'boost via PID 70: ' + store.get('boost'));
  assert.match(store.adapter.fast, /boost from 70/);
  console.log('  ok  boost read from PID 70 when 0B is not there');
}
{
  const { store } = await connect([0x05, 0x0C, 0x0D, 0x0E, 0x0F, 0x11, 0x33, 0x42], truth);
  assert.equal(store.get('boost'), null); assert.equal(store.get('rpm'), 3200);
  assert.match(store.adapter.fast, /boost from nowhere/);
  console.log('  ok  a car with no boost PID says so and the rest still works');
}
console.log('cars ok');
