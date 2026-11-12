// node tools/analyze-recording.mjs carbox-test-....txt
// Summary of a test recording (format in ios/App/Recorder.swift): how often each value arrived and the
// longest gaps, adapter timeouts, gear changes and whether the RPM/speed ratio agreed with them, reverse,
// screen smoothness, and what was happening around each MARK.
import fs from 'node:fs';
import { CARS, MPH_PER_MPS } from '../js/cars.js';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/analyze-recording.mjs <recording.txt>'); process.exit(1); }
const lines = [];
for (const [i, raw] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
  if (!raw.trim()) continue;
  try { lines.push(JSON.parse(raw)); } catch { console.log(`! line ${i + 1} is not JSON (file cut off?)`); }
}
const meta = lines.find((l) => l.y === 'meta') || {}, end = lines[lines.length - 1]?.t ?? 0;
const car = meta.ratios ? { ratios: meta.ratios, final: meta.final, tire: meta.tire } : CARS[meta.car] || CARS['z-6mt'];
const f1 = (x) => x.toFixed(1), pct = (a, b) => b ? `${Math.round(a / b * 100)} %` : '-';
console.log(`${file}\n  ${f1(end)} s, ${lines.length} lines · car ${meta.car} · source ${meta.source} · app ${meta.app ?? '-'} · iOS ${meta.ios ?? '-'} ${meta.device ?? ''}`);
if (meta.adapter) console.log(`  adapter: ${meta.adapter.name ?? '?'} · ${meta.adapter.elm ?? ''}\n  fast mode: ${meta.adapter.fast ?? '-'}\n  car offers: ${meta.adapter.pids ?? '-'}`);

// readings: rate and gaps
const byKey = {};
for (const l of lines) if (l.y === 'v') (byKey[l.k] ||= []).push(l);
console.log('\nreadings (per second · longest gap · range)');
for (const [k, a] of Object.entries(byKey).sort((x, y) => y[1].length - x[1].length)) {
  let gap = 0, at = 0;
  for (let i = 1; i < a.length; i++) if (a[i].t - a[i - 1].t > gap) { gap = a[i].t - a[i - 1].t; at = a[i - 1].t; }
  const vs = a.map((x) => x.v);
  console.log(`  ${k.padEnd(14)} ${f1(a.length / Math.max(end, 0.001)).padStart(5)}/s · gap ${Math.round(gap * 1000)} ms at ${f1(at)} s · ${f1(Math.min(...vs))} .. ${f1(Math.max(...vs))}`);
}
for (const k of ['boost', 'afr', 'throttle']) if (!byKey[k]) console.log(`  ${k.padEnd(14)} never arrived`);

// adapter
const bus = lines.filter((l) => l.y === 'bus' && !l.before);
const tos = bus.filter((l) => /timeout/i.test(l.l)), polls = bus.filter((l) => l.l.startsWith('>'));
console.log(`\nadapter: ${polls.length} replies, ${tos.length} timeouts (${pct(tos.length, polls.length + tos.length)})`);
const tcount = {}; for (const l of tos) { const c = l.l.replace(/.*timeout\s*/i, ''); tcount[c] = (tcount[c] || 0) + 1; }
for (const [c, n] of Object.entries(tcount).sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  timeout ${c} ×${n}`);
for (const l of lines.filter((x) => x.y === 'bus' && /fast mode|car offers|batched/i.test(x.l))) console.log('  ' + l.l);

// gear: what was shown vs what RPM/speed said a moment later
const ui = lines.filter((l) => l.y === 'ui');
const shown = ui.length ? ui : lines.filter((l) => l.y === 'gear');
const changes = []; let prev = null;
for (const l of shown) { const g = l.gear ?? l.g; if (g !== prev) { changes.push({ t: l.t, g }); prev = g; } }
const valAt = (k, t) => { const a = byKey[k]; if (!a) return null; let v = null; for (const x of a) { if (x.t > t) break; v = x.v; } return v; };
const ratioAt = (t) => { const r = valAt('rpm', t), m = valAt('speed', t); return r && m > 3 ? r / (m / MPH_PER_MPS / car.tire * 60 * car.final) : null; };
const nearest = (r) => { let b = 0; car.ratios.forEach((x, i) => { if (Math.abs(x - r) < Math.abs(car.ratios[b] - r)) b = i; }); return { g: String(b + 1), err: Math.abs(car.ratios[b] - r) / car.ratios[b] }; };
let disagree = 0;
console.log(`\ngear: ${changes.length} changes on screen`);
for (const c of changes.slice(0, 80)) {
  const r = ratioAt(c.t + 0.3), n = r ? nearest(r) : null;
  const bad = n && /^\d$/.test(c.g) && n.err < 0.05 && n.g !== c.g;
  if (bad) disagree++;
  console.log(`  ${f1(c.t).padStart(7)} s  ${String(c.g).padEnd(2)} ${n ? `ratio says ${n.g} (${(n.err * 100).toFixed(1)} % off)` : ''}${bad ? '  <-- disagrees' : ''}`);
}
if (changes.length > 80) console.log(`  ... ${changes.length - 80} more`);
const flick = changes.filter((c, i) => i > 0 && c.t - changes[i - 1].t < 0.4).length;
console.log(`  quick back-and-forth changes (<0.4 s apart): ${flick} · disagreeing with RPM/speed: ${disagree}`);
const ks = lines.filter((l) => l.k != null && (l.y === 'gear' || l.y === 'ui')).map((l) => l.k);
if (ks.length) console.log(`  gearing correction: ${ks[0]} -> ${ks[ks.length - 1]}`);

// reverse
const revs = lines.filter((l) => l.y === 'rev'), learn = lines.filter((l) => l.y === 'learn');
console.log(`\nreverse: ${revs.filter((r) => r.on).length} times on · sensor ${learn.length ? (learn[learn.length - 1].ready ? 'ready' : 'learning') : meta.reverseReady ? 'ready' : 'not ready'} · ${lines.filter((l) => l.y === 'acc').length} motion samples`);

// smoothness
const fps = ui.filter((l) => l.fps != null).slice(1);   // the first report covers a partial second
if (fps.length) {
  const fs_ = fps.map((l) => l.fps).sort((a, b) => a - b), worst = Math.max(...fps.map((l) => l.worstMs));
  console.log(`\nscreen: ${fs_[Math.floor(fs_.length / 2)]} fps median, ${fs_[0]} lowest second, slowest frame ${worst} ms · look ${fps[fps.length - 1].look} · background ${fps[fps.length - 1].bg}`);
  const janks = fps.filter((l) => l.worstMs > 50);
  if (janks.length) console.log(`  seconds with a frame over 50 ms: ${janks.length} (e.g. ${janks.slice(0, 6).map((l) => `${f1(l.t)} s on ${l.tab}`).join(', ')})`);
}

// marks
const marks = lines.filter((l) => l.y === 'mark');
if (marks.length) console.log(`\nmarks: ${marks.length}`);
for (const m of marks) {
  const w = lines.filter((l) => l.t >= m.t - 3 && l.t <= m.t + 1);
  const g = w.filter((l) => l.y === 'ui').map((l) => l.gear).join(' ');
  const to = w.filter((l) => l.y === 'bus' && /timeout/i.test(l.l)).length;
  console.log(`  #${m.n} at ${f1(m.t)} s: rpm ${Math.round(valAt('rpm', m.t) ?? 0)}, ${Math.round(valAt('speed', m.t) ?? 0)} mph, boost ${valAt('boost', m.t)?.toFixed(1) ?? '--'}; gear in the 3 s before: ${g || '-'}; timeouts: ${to}`);
}
const errs = lines.filter((l) => l.y === 'err');
if (errs.length) { console.log(`\npage errors: ${errs.length}`); for (const e of errs.slice(0, 5)) console.log('  ' + e.m); }
