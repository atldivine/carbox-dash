// node tests/gear.test.mjs -- gear detection under real OBD conditions: speed in whole km/h, ~7 samples
// a second (what the Z's adapter showed on the BUS tab), a speedometer/tyre error of a few percent,
// shifts through the clutch. Checks the right gear shows, shifts are caught quickly, and the gearbox
// (6MT vs 9AT) is recognised.
import assert from 'node:assert/strict';
import { Store } from '../js/store.js';
import { Derived, TRANSMISSIONS, TIRE_M, MPH_PER_MPS } from '../js/derive.js';

const SAMPLE_MS = 150;
function drive(trans, plan, { speedoErr = 1.03, pref = 'auto', lag = 0, sampleMs = SAMPLE_MS } = {}) {
  const store = new Store(), d = new Derived(store, { trans: pref });
  let t = 0, stamp = 0;
  store.time = () => stamp;   // each set() below is one new adapter reading
  const t0 = TRANSMISSIONS[trans], log = [];
  for (const [ms, fn] of plan) {
    for (let e = 0; e < ms; e += 16) {      // 60 fps frames
      t += 16;
      if (t % sampleMs < 16) {                // a new OBD reading
        const { mph, gear, clutch } = fn(e / 1000);
        const lagged = lag ? fn(Math.max(0, e / 1000 - lag)).mph : mph;   // the ECU's speed trails the real one
        const realRpm = gear && !clutch ? mph / MPH_PER_MPS / TIRE_M * 60 * t0.ratios[gear - 1] * t0.final : clutch;
        const obdKmh = Math.round(lagged * speedoErr / 0.621371);   // what PID 0D reports
        store.set('rpm', realRpm); store.set('speed', obdKmh * 0.621371); stamp = t;
        log.push({ t, want: clutch ? null : String(gear), mph });
      }
      d.update(t);
      if (log.length) log[log.length - 1].got = d.gear;
    }
  }
  return { d, log };
}

// a pull through the gears with ~0.3 s clutch-in at each shift, then a cruise in top gear
function pull(trans) {
  const n = TRANSMISSIONS[trans].ratios.length, plan = [];
  let mph = 8;
  for (let g = 1; g <= n; g++) {
    const span = 2.2;
    const from = mph;
    plan.push([span * 1000, (s) => ({ mph: from + s * (g < 4 ? 6 : 3), gear: g })]);
    mph = from + span * (g < 4 ? 6 : 3);
    const m = mph;
    if (g < n && trans === '6MT') plan.push([300, () => ({ mph: m, gear: g, clutch: 1800 })]);   // manual: clutch in, revs fall to ~1800 (the automatic shifts gear to gear)
  }
  const m = mph;
  plan.push([4000, () => ({ mph: m, gear: n })]);
  return plan;
}

for (const trans of ['6MT', '9AT']) {
  // run the same drive 3 times so the auto-detector has samples, then score the last run
  const plan = [...pull(trans), ...pull(trans), ...pull(trans)];
  const { d, log } = drive(trans, plan);
  assert.equal(d.trans, trans, `auto-detected ${d.trans}, expected ${trans}`);
  const last = log.slice(-Math.floor(log.length / 3));
  const inGear = last.filter((x) => x.want);
  // a reading counts as right if it shows the gear, allowing one reading of lag after each change
  let right = 0;
  inGear.forEach((x, i) => { const prev = last[last.indexOf(x) - 1]; if (x.got === x.want || (prev && prev.want !== x.want)) right++; });
  const pct = right / inGear.length * 100;
  assert.ok(pct >= 97, `${trans}: right gear on ${pct.toFixed(1)}% of readings`);
  const lastStart = last[0].t, n = TRANSMISSIONS[trans].ratios.length;
  const ups = d.shifts.filter((s) => s.t >= lastStart && +s.to === +s.from + 1).length;
  assert.equal(ups, n - 1, `${trans}: ${ups} of ${n - 1} upshifts caught in the last pull`);
  console.log(`${trans}: auto-detected, right gear on ${pct.toFixed(1)}% of readings, ${ups} upshifts caught, correction ×${d.scale[trans].toFixed(3)}`);
}

// shift latency: the new gear shows on the first or second reading after the clutch comes out
{
  const plan = [[3000, (s) => ({ mph: 20 + s * 5, gear: 2 })], [300, () => ({ mph: 35, gear: 2, clutch: 2000 })], [2000, (s) => ({ mph: 35 + s * 3, gear: 3 })]];
  const { log } = drive('6MT', plan, { pref: '6MT' });
  const firstIn3 = log.findIndex((x) => x.want === '3'), shownAt = log.findIndex((x, i) => i >= firstIn3 && x.got === '3');
  assert.ok(shownAt - firstIn3 <= 1, `3rd showed ${shownAt - firstIn3} readings late`);
  console.log(`shift shows ${shownAt - firstIn3 === 0 ? 'on the first reading' : 'one reading'} after the clutch comes out (${SAMPLE_MS} ms per reading)`);
}

// your idle log: 713-725 rpm, 0 mph -> N, no crash
{
  const s = new Store(), d = new Derived(s); s.set('rpm', 724.5); s.set('speed', 0); d.update(1000);
  assert.equal(d.gear, 'N');
}
// Hard pulls with the ECU's speed 0.35 s behind (what made upshifts read N until lifting), and the same
// on a weak Bluetooth link (a reading every 450 ms)
for (const [name, opt] of [['speed 0.35 s behind', { lag: 0.35 }], ['weak link, 450 ms readings', { lag: 0.35, sampleMs: 450 }]]) {
  const hard = [[1500, () => ({ mph: 0, gear: 1, clutch: 800 })]];   // stopped, then launch
  let mph = 6;
  for (let g = 1; g <= 4; g++) {
    const acc = [14, 11, 8, 6][g - 1], from = mph;
    hard.push([2000, (s) => ({ mph: (g === 1 ? 0 : from) + s * acc, gear: g })]);
    mph = from + 2 * acc; const m = mph;
    if (g < 4) hard.push([300, () => ({ mph: m, gear: g, clutch: 2200 })]);
  }
  const { log, d } = drive('6MT', [...hard, ...hard], { pref: '6MT', ...opt });
  // from 15 mph: in the first half-second of a launch the ECU's speed hasn't caught up with the car yet
  const lastPull = log.slice(-Math.floor(log.length / 2)).filter((x) => x.want && x.mph >= 15);
  let right = 0;
  lastPull.forEach((x, i) => { if (x.got === x.want || (i && lastPull[i - 1].want !== x.want)) right++; });
  const pct = right / lastPull.length * 100;
  assert.ok(pct >= 90, `${name}: right gear on ${pct.toFixed(1)}% under hard throttle`);
  const ups = d.shifts.slice(-3).filter((s) => +s.to === +s.from + 1).length;
  assert.equal(ups, 3, `${name}: ${ups} of 3 upshifts in the last pull`);
  console.log(`${name}: right gear on ${pct.toFixed(1)}% of readings under hard throttle, all 3 upshifts caught`);
}
console.log('gear detection ok');
