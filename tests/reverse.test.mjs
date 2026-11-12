// node tests/reverse.test.mjs
// Reverse from the phone's motion sensor: a phone in a mount at an odd angle, sensor noise and bias,
// engine vibration. Learns "forward" on a normal drive, then must tell backing out from pulling away.
import assert from 'node:assert/strict';
import { ReverseDetector } from '../js/reverse.js';

function rot(ax, ay, az) {   // rotation matrix: car frame -> phone frame
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  return [[cb * cc, -cb * sc, sb], [sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb], [-ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb]];
}
let GENTLE = 1.0;
function run(seed, mount) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const R = rot(...mount), bias = [rnd() * 0.06, rnd() * 0.06, rnd() * 0.06];
  const det = new ReverseDetector();
  let t = 0, mph = 0;
  // one 50 ms sample; a = car acceleration along its length in m/s^2 (+ forward)
  const step = (a, gear) => {
    t += 50;
    mph = Math.max(0, mph + (gear === 'R' ? -a : a) * 0.05 / 0.44704);   // speed has no sign: backing up still counts up
    const car = [a, rnd() * 0.25, rnd() * 0.35];             // + sideways sway and bumps
    const ph = R.map((row, i) => row[0] * car[0] + row[1] * car[1] + row[2] * car[2] + bias[i] + rnd() * 0.12);
    const shown = mph < 0.5 ? 'N' : gear;
    return det.update(t, Math.round(mph / 0.621371) * 0.621371, ph, /^[2-6]$/.test(shown));
  };
  // a few minutes of normal driving to learn which way is forward
  for (let lap = 0; lap < 6; lap++) {
    for (let i = 0; i < 60; i++) step(2.5, '1');
    for (let i = 0; i < 120; i++) step(1.6, '2');
    for (let i = 0; i < 120; i++) step(1.0, '3');
    for (let i = 0; i < 100; i++) step(-2.8, '3');
    while (mph > 0) step(-2.5, '2');
    for (let i = 0; i < 20; i++) step(0, 'N');
  }
  const out = {};
  // backing out of a space
  let seen = false; for (let i = 0; i < 100; i++) { seen = step(i < 40 ? -GENTLE : 0, 'R') || seen; }
  out.reverseSeen = seen; out.reverseAtEnd = det.reverse;
  while (mph > 0) step(1.2, 'R'); for (let i = 0; i < 20; i++) step(0, 'N');
  // pulling away forwards in 1st (same RPM/speed ratio as reverse on the Integra)
  let wrong = false; for (let i = 0; i < 80; i++) wrong = step(i < 30 ? 1.2 : 0.3, '1') || wrong;
  out.forwardFlaggedReverse = wrong;
  out.learned = det.learned;
  return out;
}
let n = 0;
for (let seed = 1; seed <= 40; seed++) {
  const mount = [(seed % 7 - 3) * 0.5, (seed % 5 - 2) * 0.6, (seed % 11) * 0.57];   // all sorts of angles
  const r = run(seed * 7919, mount);
  assert.ok(r.learned, `seed ${seed}: learned`);
  assert.ok(r.reverseSeen && r.reverseAtEnd, `seed ${seed}: reverse shown while backing up`);
  assert.ok(!r.forwardFlaggedReverse, `seed ${seed}: pulling away forwards never shows R`);
  n++;
}
GENTLE = 0.45;   // creeping back at walking pace (~2 mph after 2 s)
let gentle = 0; for (let seed = 1; seed <= 40; seed++) { const r = run(seed * 7919, [(seed % 7 - 3) * 0.5, (seed % 5 - 2) * 0.6, (seed % 11) * 0.57]); if (r.reverseSeen) gentle++; assert.ok(!r.forwardFlaggedReverse); }
console.log(`  ok  gentle back-up at walking pace: R shown in ${gentle}/40`);
assert.ok(gentle >= 36);
console.log(`  ok  ${n} phone mounting angles: reverse shown when backing up, never when pulling away`);
console.log('reverse ok');
