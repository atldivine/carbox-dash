// node tests/shift.test.mjs
// Drives an Integra 6MT at real OBD timing and checks the gear display. Each sample: speed in whole km/h,
// RPM with 1 % noise. Hard launches through 1st-6th with ~0.4 s clutch-in per shift (revs fall), rev-matched
// downshifts, and crawling in 1st. Run with RPM and speed read together (batched adapter) and with them read
// 150 ms apart (one value at a time), where hard acceleration skews the ratio.
// Scored: "wrong" = time a gear is shown that isn't the one engaged (outside the 300 ms after a shift);
// "flash" = a gear shown that you never selected around then; delay = clutch out -> new gear on screen.
import assert from 'node:assert/strict';
import { CARS, MPH_PER_MPS } from '../js/cars.js';
import { Store } from '../js/store.js';

export async function drive(Derived, { tyreErr = 1.0, skew = 0, seed = 7 } = {}) {
  const car = CARS['integra-6mt'];
  let rnd = seed; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const rpmFor = (mph, g) => mph / MPH_PER_MPS / car.tire * 60 * car.ratios[g - 1] * car.final * tyreErr;
  const store = new Store();
  let now = 0; const realNow = performance.now.bind(performance); performance.now = () => now;
  const d = new Derived(store, { car: car.id });
  let mph = 0, rpm = 850, prevG = '1', before = '1';
  const hist = [], log = [], outs = [];
  const step = (g, engaged, slip) => {     // one 50 ms OBD sample
    now += 50;
    hist.push({ t: now, mph });
    const sp = skew ? (hist.find((x) => x.t >= now - skew) ?? hist[0]) : { mph };
    store.set('rpm', Math.round(rpm * (1 + (rand() - 0.5) * 0.01) * 4) / 4);
    store.set('speed', Math.round(sp.mph / 0.621371) * 0.621371);
    if (skew) store.v.speed[1] = now - skew;
    for (let k = 0; k < 3; k++) d.update(now);        // the dash draws several frames per sample
    if (engaged && String(g) !== prevG) { before = prevG; prevG = String(g); }
    log.push({ t: now, mph, rpm, truth: engaged && !slip && mph >= 2 ? String(g) : null, near: prevG, before, shown: d.gear });
  };
  const acc = [0, 10, 6.5, 4.3, 3.1, 2.3, 1.7];      // mph per second at full throttle, per gear
  // standing start: idle, then the clutch slips until 1st is fully engaged
  for (let t = 0; t < 1000; t += 50) { rpm = 850; step(1, false); }
  while (rpmFor(mph, 1) < 2600) { mph += acc[1] * 0.05; rpm = 2600; step(1, true, true); }
  for (let g = 1; g <= 6; g++) {
    if (g > 1) {
      for (let t = 0; t < 400; t += 50) { mph -= 0.03; rpm = Math.max(1300, rpm - 5500 * 0.05); step(g - 1, false); }   // clutch in, revs fall
      outs.push({ t: now, to: String(g) });
    }
    const top = g === 6 ? 1500 : 0;
    for (let t = 0; g === 6 ? t < 2500 : rpmFor(mph, g) < 6000; t += 50) { mph += acc[g] * 0.05; rpm = rpmFor(mph, g); step(g, true); }
    void top;
  }
  // braking with rev-matched downshifts 6 -> 2 (the Integra blips the throttle itself)
  for (const g of [5, 4, 3, 2]) {
    const target = 3800 / rpmFor(1, g);                                                                  // brake in gear until the lower gear would sit at ~3,800 rpm
    while (mph > target) { mph -= 18 * 0.05; rpm = rpmFor(mph, g + 1); step(g + 1, true); }
    for (let t = 0; t < 380; t += 50) { mph -= 0.2; rpm += (rpmFor(mph, g) * 1.02 - rpm) * 0.35; step(g + 1, false); }
    outs.push({ t: now, to: String(g) });
    for (let t = 0; t < 1500; t += 50) { mph = Math.max(3, mph - 4 * 0.05); rpm = rpmFor(mph, g); step(g, true); }
  }
  performance.now = realNow;
  let wrong = 0, flash = 0;
  for (const x of log) {
    const sinceOut = now - (outs.filter((o) => o.t <= x.t).pop()?.t ?? -1e9);
    const recent = outs.filter((o) => o.t <= x.t + 400 && x.t - o.t < 3000).map((o) => o.to);   // a rev-match may show the next gear just before the clutch is out
    if (x.truth && x.shown !== x.truth && (x.t - (outs.filter((o) => o.t <= x.t).pop()?.t ?? -1e9)) > 300) wrong += 50;
    if (/^\d$/.test(x.shown) && x.shown !== x.near && x.shown !== x.before && !recent.includes(x.shown)) flash += 50;   // holding the gear just left is fine
    void sinceOut;
  }
  const delays = outs.filter((o) => o.to !== '1').map((o) => { const hit = log.find((x) => x.t > o.t && x.shown === o.to); return hit ? hit.t - o.t : 5000; });
  return { wrong, flash, avg: delays.reduce((a, b) => a + b, 0) / delays.length, worst: Math.max(...delays), k: d.k };
}

const { Derived } = await import('../js/derive.js');
let Old = null; try { Old = (await import('/tmp/old/js/derive.js')).Derived; } catch { /* not around */ }
const f = (r) => `wrong gear ${String(r.wrong).padStart(4)} ms, stray flashes ${String(r.flash).padStart(3)} ms, shows ${String(Math.round(r.avg)).padStart(3)} ms after clutch out (worst ${r.worst >= 5000 ? 'never' : Math.round(r.worst) + ' ms'})`;
const runs = [['batched adapter', {}], ['RPM/speed 150 ms apart', { skew: 150 }], ['tyres 5 % big + 150 ms apart', { skew: 150, tyreErr: 1.05 }]];
for (const [name, opt] of runs) {
  if (Old) console.log(`  before  ${name.padEnd(30)} ${f(await drive(Old, opt))}`);
  const r = await drive(Derived, opt);
  console.log(`  now     ${name.padEnd(30)} ${f(r)}`);
  assert.equal(r.flash, 0, name + ': no stray gears');
  const late = opt.skew || 0;   // with RPM and speed read apart, matching values only exist that much later
  assert.ok(r.wrong <= 100 + late * 2, name + ': wrong gear time ' + r.wrong);
  assert.ok(r.worst <= 250 + late, name + ': slowest shift ' + r.worst);
}
console.log('shift ok');
