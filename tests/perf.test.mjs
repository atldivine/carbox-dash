// node tests/perf.test.mjs -- diagnostics parsing, launch timing, rev-match scoring, dyno, raw OBD requests.
import assert from 'node:assert/strict';
import { decodeDtc, parseDtcs, parseMonitors, pidBytes, describe, readAll, simAnswer } from '../js/diag.js';
import { Store } from '../js/store.js';
import { Derived, GEARS_6MT, FINAL_6MT, TIRE_M, MPH_PER_MPS } from '../js/derive.js';
import { Perf } from '../js/perf.js';
import { Elm327, FakeElmTransport } from '../js/elm327.js';

// ---- trouble codes
assert.equal(decodeDtc(0x01, 0x71), 'P0171');
assert.equal(decodeDtc(0x03, 0x02), 'P0302');
assert.equal(decodeDtc(0xC1, 0x00), 'U0100');
assert.equal(decodeDtc(0x41, 0x23), 'C0123');
assert.deepEqual(parseDtcs('43 02 01 71 03 02', 0x03), ['P0171', 'P0302'], 'CAN: count byte then pairs');
assert.deepEqual(parseDtcs('43 01 71 03 02 00 00', 0x03), ['P0171', 'P0302'], 'older bus: pairs, zero padding');
assert.deepEqual(parseDtcs('43 00', 0x03), [], 'no codes');
assert.deepEqual(parseDtcs('NO DATA', 0x03), []);
assert.deepEqual(parseDtcs('47 01 04 20', 0x07), ['P0420']);
assert.deepEqual(parseDtcs('008\r0: 43 03 01 71 03 02\r1: 04 20 00 00 00 00 00', 0x03), ['P0171', 'P0302', 'P0420'], 'multi-frame');
assert.deepEqual(parseDtcs('43 01 01 71\r43 01 01 71', 0x03), ['P0171'], 'two ECUs, same code once');
assert.match(describe('P0171'), /lean/i);
assert.match(describe('P1234'), /Nissan-specific/);
assert.match(describe('P0399'), /Ignition or misfire/);

// ---- monitors and counters
const st = parseMonitors(pidBytes('41 01 82 07 E5 A1', 0x01));
assert.equal(st.mil, true); assert.equal(st.count, 2);
assert.deepEqual(st.monitors.find((m) => m.name === 'CATALYST'), { name: 'CATALYST', ready: false });
assert.deepEqual(st.monitors.find((m) => m.name === 'MISFIRE'), { name: 'MISFIRE', ready: true });
const all = await readAll(async (c) => simAnswer(c));
assert.deepEqual(all.stored, ['P0171', 'P0302']); assert.deepEqual(all.pending, ['P0420']); assert.deepEqual(all.permanent, []);
assert.equal(all.counters.length, 5);
console.log('diagnostics ok');

// ---- raw requests through the ELM327 driver (between polls), against the fake adapter
{
  const store = new Store(), fake = new FakeElmTransport((k) => ({ rpm: 900, speed: 0, afr: 14.7 })[k]);
  fake.diag = simAnswer;
  const elm = new Elm327(fake, store);
  await elm.start();
  const r = await readAll((c) => elm.raw(c));
  assert.deepEqual(r.stored, ['P0171', 'P0302']);
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(Math.abs(store.get('afr') - 14.7) < 0.05, 'AFR from the wide-band lambda PID: ' + store.get('afr'));
  store.paused = true;
  await assert.rejects(elm.raw('03'), /paused/);
  elm.stop();
  console.log('raw OBD requests ok');
}

// ---- simulated drive for the performance maths
const rpmFor = (mph, g) => mph / MPH_PER_MPS / TIRE_M * 60 * GEARS_6MT[g - 1] * FINAL_6MT;
function drive(steps) {
  const store = new Store(), derived = new Derived(store), perf = new Perf(store, derived, null);
  let t = 0;
  for (const [ms, fn] of steps) for (let e = 0; e < ms; e += 50) { t += 50; const v = fn(e / 1000, t); for (const k in v) store.set(k, v[k]); derived.update(t); perf.update(t); }
  return perf;
}

// launch: steady 0.5 g from a stop -> 0-60 in ~5.5 s, quarter mile ~12.8 s
{
  const a = 0.5 * 9.80665 * MPH_PER_MPS;   // mph per second
  const p = drive([[1500, () => ({ speed: 0, rpm: 800 })], [20000, (s) => ({ speed: a * s, rpm: 3000, throttle: 100 })]]);
  const L = p.launch;
  assert.ok(Math.abs(L.t60 - 60 / a) < 0.3, '0-60 ' + L.t60);
  const et = Math.sqrt(2 * 402.336 / (0.5 * 9.80665));
  assert.ok(Math.abs(L.et - et) < 0.3, `ET ${L.et} vs ${et}`);
  assert.ok(Math.abs(L.trap - a * et) < 1.5, 'trap ' + L.trap);
  console.log(`launch ok: 0-60 ${L.t60.toFixed(2)} s, 1/4 ${L.et.toFixed(2)} s @ ${L.trap.toFixed(1)} mph`);
}

// rev match: 4th -> 3rd at 50 mph; held revs 2% low = high score, held 10% low = under-revved
for (const [hold, want] of [[0.98, 'PERFECT'], [0.9, 'UNDER-REVVED']]) {
  const target = rpmFor(50, 3);
  const p = drive([
    [1000, () => ({ speed: 50, rpm: rpmFor(50, 4) })],                       // cruising in 4th
    [200, (s) => ({ speed: 50, rpm: rpmFor(50, 4) + s * 3000 })],          // clutch in, blip starts
    [500, () => ({ speed: 50, rpm: target * hold })],                       // held blip
    [600, () => ({ speed: 50, rpm: target })],                              // clutch out: revs pulled onto the gear
  ]);
  const r = p.rev.last;
  assert.ok(r, 'downshift scored'); assert.equal(r.from, 4); assert.equal(r.to, 3);
  if (want === 'PERFECT') assert.ok(r.score >= 85, `held 2% low scored ${r.score}`); else assert.equal(r.verdict, want);
  console.log(`rev match ok: held ${Math.round(hold * 100)}% -> ${r.score} ${r.verdict}`);
}

// dyno: a pull in 3rd at constant 0.35 g, 3,600 lb -> power rises with speed
{
  const a = 0.35 * 9.80665 * MPH_PER_MPS, mph0 = 25;
  const p = drive([[500, () => ({ speed: mph0, rpm: rpmFor(mph0, 3), throttle: 100 })],
    [6000, (s) => ({ speed: mph0 + a * s, rpm: rpmFor(mph0 + a * s, 3), throttle: 100 })],
    [500, (s, t) => ({ speed: mph0 + a * 6, rpm: rpmFor(mph0 + a * 6, 3), throttle: 0 })]]);
  const run = p.dyno.runs[0];
  assert.ok(run, 'run recorded'); assert.equal(run.gear, '3');
  const v = (mph0 + a * 6) / MPH_PER_MPS, m = 3600 * 0.453592;
  const expectHp = (m * 0.35 * 9.80665 + 0.5 * 1.204 * 0.62 * v * v + 0.013 * m * 9.80665) * v / 745.7;
  assert.ok(Math.abs(run.peakHp.hp - expectHp) / expectHp < 0.1, `peak ${run.peakHp.hp.toFixed(0)} vs ${expectHp.toFixed(0)} whp`);
  console.log(`dyno ok: ${run.peakHp.hp.toFixed(0)} whp @ ${run.peakHp.rpm}, ${run.peakTq.tq.toFixed(0)} lb-ft`);
}
