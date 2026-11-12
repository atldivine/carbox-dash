import { Store, SIGNALS, fmt, frac, level } from './store.js';
import { Derived } from './derive.js';
import { CARS, CAR_IDS, getCar } from './cars.js';
import { SimSource } from './sim.js';
import { Elm327 } from './elm327.js';
import { Wire, VIEW_NAMES } from './wire.js';
import { Backdrop } from './backdrop.js';
import { Gauge, SPECS, LOOKS, SWATCHES, MINI_KEYS } from './gauges.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const ACCENTS = { IGNITION: '#ff263e', ICE: '#46c8ff', CHAMPAGNE: '#e2ba6e', VOLT: '#beff3c' };

const store = new Store(), derived = new Derived(store), wire = new Wire();
let sim = null, elm = null, bleError = '', revReady = false;
const pref = (() => { try { return JSON.parse(localStorage.getItem('carbox') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('carbox', JSON.stringify({ accent: pref.accent, night: pref.night, tiles, gauge: pref.gauge, car: pref.car, bg: pref.bg })); } catch { /* private mode */ } };
const GAUGE_DEFAULT = { look: 'REAL', neon: '#ff263e', dial: null, glow: 1, bright: 1, per: {}, minis: ['boost', 'afr', 'coolant'] };
pref.gauge = { ...GAUGE_DEFAULT, ...(pref.gauge || {}) };
if (!pref.gauge.v2) { if (pref.gauge.look === 'NEON') pref.gauge.look = 'REAL'; pref.gauge.v2 = true; }   // the old default becomes the new realistic look, once
pref.accent = pref.accent || 'IGNITION'; pref.night = pref.night || 'auto'; pref.bg = pref.bg || 'PEARL';
const backdrop = new Backdrop(document.getElementById('bg'));
const BGS = ['PEARL', 'BLACK'];   // live pearl wallpaper, or pure black for OLED
let car = getCar(pref.car); pref.car = car.id;   // which car this is: gearing, limits and which gauges are shown
let tiles = pref.tiles || ['boost', 'afr', 'iat', 'oil_temp', 'knock', 'ethanol'];
let screen = 'drive';
const rec = { on: false, t0: 0, lines: [], marks: 0, last: null };

// ---- build static pieces
const TABS = ['drive', 'tach', 'engine', 'shift', 'perf', 'bus', 'systems'];
TABS.forEach((t) => { const b = el('button', '', t); b.onclick = () => setScreen(t); b.dataset.t = t; $('tabs').append(b); });
function setScreen(t) {
  screen = t;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + t));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'tach' && !matchMedia('(prefers-reduced-motion: reduce)').matches) gauges.forEach((g) => g.sweep());   // start-up needle sweep
  if (typeof frame === 'function') frame();   // fill the new screen now, not one tick later
}
const mkSeg = (node, n) => { for (let i = 0; i < n; i++) node.append(el('i')); return [...node.children]; };
const rpmSeg = mkSeg($('rpmseg'), 28), ethSeg = mkSeg($('ethseg'), 12);
ethSeg.forEach((i) => i.parentElement.classList.add('amber'));
let CHIPS = [], ROWS = [], PEAKS = [];
function buildChips(names) {
  $('chips').innerHTML = '';
  CHIPS = names.map((n) => { const c = el('span', 'chip', n); c.dataset.n = n; $('chips').append(c); return c; });
}
function buildRows(keys) {
  $('rows').innerHTML = '';
  ROWS = keys.map((k) => {
    const r = el('div', 'kv', `<label>${SIGNALS[k].label}</label>${k === 'boost' || k === 'throttle' || k === 'load' ? '<span class="lbar"><i></i></span>' : ''}<span><b></b> <u>${['°F', '%'].includes(SIGNALS[k].unit) ? SIGNALS[k].unit : ''}</u></span>`);
    $('rows').append(r); return { k, r, b: r.querySelector('b'), bar: r.querySelector('.lbar i') };
  });
}
const VIEWBTN = VIEW_NAMES.map((v) => { const b = el('button', '', v); b.onclick = () => wire.setView(v); $('views').append(b); return b; });
const TILES = [0, 1, 2, 3, 4, 5].map((i) => {
  const t = el('button', 'panel tile', `<label></label><span class="pk"></span><div class="val"></div><div class="seg small"></div>`);
  t.onclick = () => { const keys = Object.keys(SIGNALS).filter((k) => !tiles.includes(k) || k === tiles[i]); tiles[i] = keys[(keys.indexOf(tiles[i]) + 1) % keys.length]; save(); };
  $('tiles').append(t); return { t, label: t.querySelector('label'), pk: t.querySelector('.pk'), val: t.querySelector('.val'), seg: mkSeg(t.querySelector('.seg'), 20) };
});
function buildPeaks(keys) {
  $('peaks').innerHTML = '';
  PEAKS = keys.map((k) => { const p = el('div', 'panel', `<label>PEAK ${SIGNALS[k].label}</label><div class="mid"></div>`); $('peaks').append(p); return { k, v: p.querySelector('.mid') }; });
}

// ---- system buttons
const btn = (title, cb) => { const b = el('button', 'panel btn', `<label>${title}</label><b></b>`); b.onclick = cb; $('btns').append(b); return { b, v: b.querySelector('b'), set(text, on) { this.v.textContent = text; b.classList.toggle('on', !!on); } }; };
const B = {
  car: btn('Car', () => cycleCar()),
  src: btn('Data source', () => setSource(store.source === 'sim' ? 'ble' : 'sim')),
  pause: btn('Pause OBD', () => { if (native) post({ cmd: 'pause' }); else store.paused = !store.paused; }),
  log: btn('Test recording', () => toggleLog()),
  share: btn('Last recording', () => { if (native) post({ cmd: 'shareRec' }); else if (rec.last) download(rec.last); }),
  bg: btn('Background', () => { pref.bg = BGS[(BGS.indexOf(pref.bg) + 1) % BGS.length]; backdrop.setMode(pref.bg); save(); }),
  accent: btn('Style · accent', () => { const n = Object.keys(ACCENTS); pref.accent = n[(n.indexOf(pref.accent) + 1) % n.length]; applyTheme(); save(); }),
  night: btn('Night mode', () => { const o = ['auto', 'on', 'off']; pref.night = o[(o.indexOf(pref.night) + 1) % 3]; applyTheme(); save(); }),
  trip: btn('Trip', () => { derived.trip = 0; post({ cmd: 'resetTrip' }); }),
  adapter: btn('OBD adapter', () => { if (native) post({ cmd: 'scan' }); else setSource('ble'); }),
};
function applyTheme() {
  document.documentElement.style.setProperty('--accent', ACCENTS[pref.accent]); wire.color = ACCENTS[pref.accent];
  const h = new Date().getHours(), night = pref.night === 'on' || (pref.night === 'auto' && (h >= 19 || h < 6));
  document.body.classList.toggle('night', night); store.night = night;
  backdrop.accent = ACCENTS[pref.accent]; backdrop.bright = night ? 0.5 : 1; backdrop.last = 0;
}
// ---- test recording
// Everything needed to replay a drive in one text file, one JSON object per line (format in
// ios/App/Recorder.swift). In the iPhone app native code records; stopping opens the share sheet.
// In a browser the page records what it sees and downloads the file.
function toggleLog() {
  if (native) { post({ cmd: 'rec' }); return; }
  if (!rec.on) {
    Object.assign(rec, { on: true, t0: performance.now(), lines: [], marks: 0 });
    recLine({ y: 'meta', car: car.id, ratios: car.ratios, final: car.final, tire: car.tire, source: store.source, adapter: store.adapter || {}, ua: navigator.userAgent, started: new Date().toISOString() });
    store.busLog.forEach(([, l]) => recLine({ y: 'bus', l, before: true }));
    return;
  }
  recLine({ y: 'end', marks: rec.marks });
  rec.on = false;
  rec.last = new Blob([rec.lines.join('\n') + '\n'], { type: 'text/plain' });
  rec.lines = [];
  download(rec.last);
}
function recLine(o) { if (rec.on && !native) rec.lines.push(JSON.stringify({ t: Math.round(performance.now() - rec.t0) / 1000, ...o })); }
function download(blob) {
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = `carbox-test-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`; a.click();
}
// browser only: catch every reading and adapter line as it arrives
{
  const set = store.set.bind(store), log = store.log.bind(store);
  store.set = (k, v) => { set(k, v); if (rec.on && !native && Number.isFinite(v)) recLine({ y: 'v', k, v: Math.round(v * 1000) / 1000 }); };
  store.log = (l) => { log(l); if (rec.on && !native) recLine({ y: 'bus', l }); };
}
function mark() {
  if (native) post({ cmd: 'mark' }); else { rec.marks++; recLine({ y: 'mark', n: rec.marks }); }
  $('markBtn').classList.add('flash'); setTimeout(() => $('markBtn').classList.remove('flash'), 250);
  if (navigator.vibrate) navigator.vibrate(20);
}
$('recBtn').onclick = toggleLog;
$('markBtn').onclick = mark;
// Once a second while recording: what the screen shows and how smoothly it draws.
const recUI = { frames: 0, worst: 0, lastGear: null, lastSent: 0 };
function recReport(now, dt) {
  if (!rec.on) { recUI.frames = 0; recUI.worst = 0; return; }
  recUI.frames++; recUI.worst = Math.max(recUI.worst, dt);
  const gearChanged = derived.gear !== recUI.lastGear;
  if (!gearChanged && now - recUI.lastSent < 1000) return;
  const span = (now - recUI.lastSent) / 1000;
  const o = { gear: derived.gear, k: Math.round(derived.k * 1000) / 1000, rev: derived.reverse, tab: screen };
  if (!gearChanged || span >= 1) Object.assign(o, { fps: Math.round(recUI.frames / Math.max(span, 0.001)), worstMs: Math.round(recUI.worst), look: pref.gauge.look, bg: pref.bg });
  if (native) post({ cmd: 'recUI', ...o }); else recLine({ y: 'ui', ...o });
  if (o.fps != null) { recUI.frames = 0; recUI.worst = 0; recUI.lastSent = now; }
  recUI.lastGear = derived.gear;
}
// Inside the iPhone app, native Swift owns Bluetooth/OBD (it keeps running while the phone is locked
// and feeds CarPlay). The page then shows what native pushes and sends button presses back.
const native = window.webkit?.messageHandlers?.carbox;
const post = (msg) => native && native.postMessage(msg);
window.carboxNative = {
  push(p) {
    // keep each value's real read time (RPM and speed may be read ~150 ms apart; gear lines them up)
    const t = performance.now();
    for (const k in p.v) store.v[k] = [p.v[k], t - 1000 * ((p.age && p.age[k]) || 0)];
    derived.reverse = !!p.rev; revReady = !!p.revReady;
    store.source = p.source === 'obd' ? 'ble' : p.source; store.status = p.status; store.paused = p.paused; bleError = p.error || '';
    if (p.adapter && Object.keys(p.adapter).length) store.adapter = p.adapter;
    if (p.bus) for (const line of p.bus) store.log(line);
    if (p.rec) { rec.on = p.rec.on; rec.secs = p.rec.secs; rec.bytes = p.rec.bytes; rec.marks = p.rec.marks; rec.lastName = p.rec.last; }
    showPicker(p.scanning ? (p.devices || []) : null);
  },
};
// Adapter picker (iPhone app): native scans, the page lists devices, a tap connects. Likely OBD adapters
// (by name or service) are outlined in the accent colour and listed first.
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let pickerKey = '';
function showPicker(devices) {
  const box = $('picker');
  if (!devices) { box.hidden = true; pickerKey = ''; return; }
  box.hidden = false;
  const key = devices.map((d) => d.id + d.rssi).join();
  if (key === pickerKey) return;                    // unchanged: don't rebuild under the user's finger
  pickerKey = key;
  $('pickList').innerHTML = devices.length ? devices.map((d) =>
    `<button class="dev${d.likely ? ' likely' : ''}" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><small>${d.rssi} dBm</small></button>`).join('')
    : '<p class="dim">SEARCHING…</p>';
}
$('pickList').addEventListener('click', (e) => { const b = e.target.closest('.dev'); if (b) { post({ cmd: 'connect', id: b.dataset.id }); showPicker(null); } });
$('pickCancel').addEventListener('click', () => { post({ cmd: 'cancelScan' }); showPicker(null); });
async function setSource(kind) {
  if (native) { post({ cmd: 'source' }); return; }
  if (elm) { elm.stop(); elm = null; }
  if (sim) { sim.stop(); sim = null; }
  store.v = {}; store.paused = false; bleError = '';
  if (kind === 'sim') { sim = new SimSource(store, () => car); sim.start(); return; }
  store.source = 'ble'; store.status = 'CONNECTING';
  try {
    const { WebBleTransport } = await import('./ble.js');
    elm = new Elm327(new WebBleTransport(), store);
    await elm.start();
  } catch (e) { bleError = e.message; store.source = 'none'; store.status = 'NO SOURCE'; if (!sim) { sim = new SimSource(store, () => car); sim.start(); } }
}

// ---- analog gauges (TACH tab)
const tachG = new Gauge($('tach'), SPECS.rpm);
const minis = [...document.querySelectorAll('.mini')].map((c, i) => new Gauge(c, SPECS[pref.gauge.minis[i]] || SPECS.boost));
const gauges = [tachG, ...minis];
// Switches the whole dash to a car: gearing, rev / boost limits, and the gauges that car can really read.
// reset = true (the Car button) also puts the car's default tiles and small gauges back.
function applyCar(id, reset) {
  car = getCar(id); pref.car = car.id;
  derived.setCar(car);
  Object.assign(SIGNALS.rpm, { hi: car.rpm.hi, warn: car.rpm.warn, crit: car.rpm.crit });
  Object.assign(SPECS.rpm, { max: car.rpm.specMax, red: car.rpm.crit });
  Object.assign(SIGNALS.boost, { warn: car.boost.warn, crit: car.boost.crit }); SPECS.boost.red = car.boost.crit;
  if (reset) { tiles = car.tiles.slice(); pref.gauge.minis = car.minis.slice(); }
  tachG.setSpec(SPECS.rpm); minis.forEach((m, i) => m.setSpec(SPECS[pref.gauge.minis[i]] || SPECS.boost));
  buildChips(car.chips); buildRows(car.rows); buildPeaks(car.peaks);
  $('logo').textContent = car.mark; $('bootsub').textContent = `${car.short} · starting up`;
  $('ethlab').textContent = SIGNALS[car.side].label.toUpperCase();
  post({ cmd: 'car', id: car.id });
  save();
}
function cycleCar() { applyCar(CAR_IDS[(CAR_IDS.indexOf(car.id) + 1) % CAR_IDS.length], true); }
const gaugeId = (c) => c.dataset.g;
const gaugeName = (id) => id === 'tach' ? 'TACH' : SPECS[pref.gauge.minis[+id.slice(4)]].title;
function gaugeOpts(id) {
  const G = pref.gauge, per = G.per[id] || {};
  return { look: G.look, glow: G.glow, bright: G.bright, neon: per.needle || G.neon, dial: per.dial || G.dial };
}
// Tap a small gauge to change what it shows; press and hold any gauge to recolour it.
document.querySelectorAll('.gauge').forEach((c) => {
  let timer = null, held = false;
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('pointerdown', () => {
    held = false; c.classList.add('holding');
    timer = setTimeout(() => { held = true; timer = null; c.classList.remove('holding'); if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(15); openSheet(gaugeId(c)); }, 450);
  });
  const end = (tap) => {
    c.classList.remove('holding');
    if (timer) { clearTimeout(timer); timer = null; if (tap && !held && c.classList.contains('mini')) cycleMini(+gaugeId(c).slice(4)); }
  };
  c.addEventListener('pointerup', () => end(true));
  c.addEventListener('pointerleave', () => end(false));
  c.addEventListener('pointercancel', () => end(false));
});
function cycleMini(i) {
  const used = pref.gauge.minis, keys = MINI_KEYS.filter((k) => !used.includes(k) || k === used[i]);
  used[i] = keys[(keys.indexOf(used[i]) + 1) % keys.length];
  minis[i].setSpec(SPECS[used[i]]); save();
}

// Style sheet. sheetFor = null: whole cluster (look, colours, brightness); else one gauge's colours.
let sheetFor = null;
function swatchRow(node, current, allowNone, onPick) {
  node.innerHTML = (allowNone ? `<button class="sw none${current ? '' : ' on'}" data-c="" title="Default"></button>` : '') +
    SWATCHES.map((c) => `<button class="sw${c === current ? ' on' : ''}" style="--c:${c}" data-c="${c}"></button>`).join('') +
    `<label class="sw custom${current && !SWATCHES.includes(current) ? ' on' : ''}" title="Custom colour"><input type="color" value="${current || '#ff263e'}"></label>`;
  node.querySelectorAll('button.sw').forEach((b) => (b.onclick = () => { onPick(b.dataset.c || null); }));
  const input = node.querySelector('input');
  input.oninput = () => onPick(input.value);
}
function renderSheet() {
  const G = pref.gauge, per = sheetFor ? (G.per[sheetFor] ||= {}) : null;
  $('gsTitle').textContent = sheetFor ? `${gaugeName(sheetFor)} GAUGE COLOURS` : 'GAUGE STYLE';
  $('gsLooks').innerHTML = LOOKS.map((l) => `<button class="chip${l === G.look ? ' on' : ''}" data-l="${l}">${l}</button>`).join('');
  $('gsLooks').querySelectorAll('button').forEach((b) => (b.onclick = () => { G.look = b.dataset.l; save(); renderSheet(); }));
  $('gsColorLabel').textContent = sheetFor ? 'NEEDLE / GLOW COLOUR' : 'NEON / GLOW COLOUR';
  swatchRow($('gsNeon'), sheetFor ? per.needle : G.neon, !!sheetFor, (c) => { if (sheetFor) per.needle = c; else G.neon = c || GAUGE_DEFAULT.neon; save(); renderSheet(); });
  swatchRow($('gsDial'), sheetFor ? per.dial : G.dial, true, (c) => { if (sheetFor) per.dial = c; else G.dial = c; save(); renderSheet(); });
  $('gsGlow').value = Math.round(G.glow * 100); $('gsGlowV').textContent = Math.round(G.glow * 100) + '%';
  $('gsBright').value = Math.round(G.bright * 100); $('gsBrightV').textContent = Math.round(G.bright * 100) + '%';
}
function openSheet(id) { sheetFor = id; renderSheet(); $('gsheet').hidden = false; }
$('styleBtn').onclick = () => openSheet(null);
$('gsDone').onclick = () => { $('gsheet').hidden = true; };
$('gsheet').addEventListener('click', (e) => { if (e.target.id === 'gsheet') $('gsheet').hidden = true; });
$('gsReset').onclick = () => {
  if (sheetFor) delete pref.gauge.per[sheetFor];
  else pref.gauge = { ...GAUGE_DEFAULT, minis: pref.gauge.minis, per: {} };
  save(); renderSheet();
};
$('gsGlow').oninput = (e) => { pref.gauge.glow = e.target.value / 100; $('gsGlowV').textContent = e.target.value + '%'; };
$('gsBright').oninput = (e) => { pref.gauge.bright = e.target.value / 100; $('gsBrightV').textContent = e.target.value + '%'; };
$('gsGlow').onchange = $('gsBright').onchange = save;

// ---- per-frame update
const clamp = (v) => Math.max(0, Math.min(1, v));
function lit(segs, f, redFrom) { const n = Math.round(clamp(f) * segs.length); segs.forEach((s, i) => { s.classList.toggle('on', i < n); s.classList.toggle('hot', redFrom != null && i >= Math.floor(redFrom * segs.length)); }); }
const col = (k, v) => ({ crit: 'var(--crit)', warn: 'var(--warn)', ok: 'var(--text)', none: 'var(--faint)' })[level(k, v)];
const gctx = $('graph').getContext('2d');
function fit(c) { const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return [c.width, c.height]; }
const live = () => store.source === 'ble' || store.source === 'sim';

// Displayed values glide toward the latest reading, so numbers and bars move smoothly between OBD
// samples instead of stepping. The adapter now delivers ~20 samples a second, so the glide is short
// (35 ms) and the needle keeps up when you get on it. Big jumps (new source, reconnect) snap.
const shown = {};
let lastNow = performance.now();
function easeAll(dt) {
  const out = {}, k = 1 - Math.exp(-dt / 35);
  for (const key in SIGNALS) {
    const v = store.get(key), s = SIGNALS[key];
    if (v === null) { delete shown[key]; out[key] = null; continue; }
    const cur = shown[key];
    shown[key] = cur == null || Math.abs(v - cur) > (s.hi - s.lo) * 0.5 ? v : cur + (v - cur) * k;
    out[key] = shown[key];
  }
  return out;
}

// Callouts on the car: follow their anchor, stay inside the panel clear of the title row and the
// view buttons, and push away from each other. Positions glide so a nudge never jumps.
const callPos = {};
function placeCallouts(a, rect, sx, sy, dt, texts) {
  const credit = $('credit'), floor = credit.offsetHeight ? credit.offsetTop - 4 : rect.height - 48;
  const pad = 6, box = { l: pad, t: 26, r: rect.width - pad, b: Math.min(rect.height - 48, floor) };
  const placed = [], k = 1 - Math.exp(-dt / 70);
  for (const [id, anchor, dx, dy, text] of texts) {
    const c = $(id);
    if (c.textContent !== text) c.textContent = text;
    const w = c.offsetWidth, h = c.offsetHeight;
    let x = anchor[0] * sx + dx - w / 2, y = anchor[1] * sy + dy - h / 2;
    const clamp = () => { x = Math.max(box.l, Math.min(box.r - w, x)); y = Math.max(box.t, Math.min(box.b - h, y)); };
    clamp();
    for (let i = 0; i < 10; i++) {
      const hit = placed.find((p) => x < p.x + p.w + 4 && x + w + 4 > p.x && y < p.y + p.h + 4 && y + h + 4 > p.y);
      if (!hit) break;
      const down = y + h / 2 >= hit.y + hit.h / 2;
      y = down ? hit.y + hit.h + 4 : hit.y - h - 4;
      if (y < box.t || y + h > box.b) { y = down ? hit.y - h - 4 : hit.y + hit.h + 4; x = x + w / 2 < rect.width / 2 ? hit.x + hit.w + 6 : hit.x - w - 6; }
      clamp();
    }
    // Still colliding means the panel is too small for every label: hide this one rather than overlap.
    const blocked = placed.some((p) => x < p.x + p.w + 2 && x + w + 2 > p.x && y < p.y + p.h + 2 && y + h + 2 > p.y);
    c.style.visibility = blocked ? 'hidden' : '';
    if (blocked) continue;
    placed.push({ x, y, w, h });
    const p = callPos[id] || (callPos[id] = { x, y });
    p.x += (x - p.x) * k; p.y += (y - p.y) * k;
    if (Math.abs(x - p.x) < 0.3) p.x = x; if (Math.abs(y - p.y) < 0.3) p.y = y;
    c.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
  }
}

function frame() {
  const now = performance.now(), dt = Math.min(250, now - lastNow); lastNow = now;
  backdrop.frame(now);
  derived.update(now);
  const E = easeAll(dt), g = (k) => E[k], snap = store.snapshot();
  recordTrace(now, E.rpm);
  // header
  $('hub').classList.toggle('live', store.count() > 0);
  const srcName = store.source === 'ble' ? 'OBD' : store.source.toUpperCase();
  $('hubText').textContent = `${srcName} · ${store.count()} SIG` + (store.status && store.status !== srcName && store.status !== 'OBD' ? ` · ${store.status}` : '');
  $('srcChip').textContent = store.source === 'sim' ? 'SIM' : store.source === 'ble' ? 'LIVE' : 'OFF';
  $('flashChip').hidden = !store.paused;
  const rs = native ? rec.secs || 0 : rec.on ? (now - rec.t0) / 1000 : 0;
  const rb = $('recBtn'), rt = rec.on ? `■ ${Math.floor(rs / 60)}:${String(Math.floor(rs % 60)).padStart(2, '0')}` : '● REC';
  if (rb.textContent !== rt) rb.textContent = rt;
  rb.classList.toggle('on', !!rec.on); $('markBtn').hidden = !rec.on;
  recReport(now, dt);
  $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
  // driver column
  const mph = g('speed'), rpm = g('rpm'), boost = g('boost'), afr = g('afr'), thr = g('throttle'), knock = g('knock'), eth = g('ethanol');
  $('mph').textContent = mph == null ? '--' : Math.round(mph); $('gear').textContent = derived.gear;
  $('rpmv').textContent = rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US');
  lit(rpmSeg, (rpm || 0) / SIGNALS.rpm.hi, car.rpm.shift / SIGNALS.rpm.hi);
  const set = (c, state) => { c.className = 'chip' + (state ? ' ' + state : ''); };
  const ld = g('load'), cool = g('coolant');
  CHIPS.forEach((c) => {
    switch (c.dataset.n) {
      case 'ON BOOST': set(c, (boost ?? -99) > 1 ? 'accent' : ''); break;
      case 'WOT': set(c, (thr || 0) > 90 ? 'on' : ''); break;
      case 'KNOCK': set(c, (knock || 0) >= SIGNALS.knock.warn ? 'crit' : ''); break;
      case 'LEAN': set(c, (afr || 0) > 13.2 && (boost ?? -99) > 5 ? 'crit' : ''); break;
      case 'ETHANOL': set(c, eth != null ? 'warn' : ''); c.textContent = eth != null ? 'E' + Math.round(eth) : 'ETHANOL'; break;
      case 'HOT': set(c, (cool || 0) >= SIGNALS.coolant.warn ? 'crit' : ''); break;
      case 'LOAD': set(c, (ld || 0) >= SIGNALS.load.warn ? 'warn' : ''); break;
      case 'PAUSED': set(c, store.paused ? 'crit' : ''); break;
    }
  });
  ROWS.forEach(({ k, b, bar }) => { const v = g(k); b.textContent = fmt(k, v); b.style.color = col(k, v); if (bar) bar.style.transform = `scaleX(${frac(k, v).toFixed(4)})`; });

  if (screen === 'drive') {
    const r = $('wire').getBoundingClientRect(), [w, h] = fit($('wire'));
    const a = wire.draw($('wire'), w, h, now / 1000);
    if (a) placeCallouts(a, r, r.width / w, r.height / h, dt, [
      ['c-cabin', a.cabin, 0, -36, `${SIGNALS[car.callout].label.toUpperCase()} ${fmt(car.callout, g(car.callout))}${SIGNALS[car.callout].unit === '%' ? '%' : '°F'}`],
      ['c-front', a.front, 30, -52, `BOOST ${fmt('boost', boost)} PSI`],
      ['c-rear', a.rear, -26, 44, `AFR ${fmt('afr', afr)}`],
    ]);
    $('viewname').textContent = 'VIEW · ' + wire.view; VIEWBTN.forEach((b, i) => b.classList.toggle('on', VIEW_NAMES[i] === wire.view));
    $('credit').textContent = wire.model ? wire.model.credit.split(', converted')[0] : '';
    $('trip').textContent = derived.trip.toFixed(1);
    $('eth').textContent = fmt(car.side, g(car.side)); lit(ethSeg, frac(car.side, g(car.side)));
    ['iat', 'battery', 'timing'].forEach((k) => { $('kv-' + k).textContent = fmt(k, g(k)); });
    $('pkboost').textContent = fmt('boost', derived.peaks.boost);
  } else if (screen === 'tach') {
    const sec = dt / 1000;
    const lamps = [(knock || 0) >= SIGNALS.knock.warn && 'KNOCK', (afr || 0) > 13.2 && (boost ?? -99) > 5 && 'LEAN', ((g('coolant') || 0) >= 225 || (g('oil_temp') || 0) >= 260) && 'HOT'].filter(Boolean);
    tachG.draw(rpm, sec, { ...gaugeOpts('tach'), gear: derived.gear, speed: mph, lamps });
    minis.forEach((m, i) => m.draw(g(pref.gauge.minis[i]), sec, gaugeOpts('mini' + i)));
  } else if (screen === 'engine') {
    TILES.forEach((t, i) => { const k = tiles[i], v = g(k), s = SIGNALS[k]; t.label.textContent = s.label; t.pk.textContent = 'PK ' + fmt(k, derived.peaks[k]);
      t.val.innerHTML = `${fmt(k, v)}<small>${s.unit}</small>`; t.val.style.color = col(k, v); lit(t.seg, frac(k, v), s.warn != null ? frac(k, s.warn) : null); });
  } else if (screen === 'shift') {
    drawShift(now); const s = derived.shifts[derived.shifts.length - 1];
    $('lastshift').textContent = s ? `${s.from}→${s.to}` : '--'; $('lastshift2').textContent = s ? `${Math.round(s.before)} → ${Math.round(s.after)} RPM · DROP ${Math.round(s.before - s.after)}` : 'NO SHIFTS YET';
    $('shiftcount').textContent = derived.shifts.length; $('shiftsub').textContent = `GEAR ${derived.gear} · 8 S`;
  } else if (screen === 'perf') {
    const p = derived.perf; let big = 'STOP TO ARM', c = 'var(--dim)';
    if (p.state === 'running' && p.split60 === null) { big = ((now - p.t0) / 1000).toFixed(2); c = 'var(--accent)'; }
    else if (p.last60 !== null) { big = p.last60.toFixed(2); c = 'var(--text)'; } else if (p.state === 'armed') big = 'READY';
    $('perfbig').textContent = big; $('perfbig').style.color = c;
    const st = $('perfstate'); st.textContent = { wait: 'WAITING', armed: 'ARMED', running: 'TIMING', done: 'DONE' }[p.state]; st.className = 'chip' + (p.state === 'running' ? ' accent' : p.state === 'armed' ? ' on' : '');
    const f2 = (v) => v == null ? '--' : v.toFixed(2); $('b60').textContent = f2(p.best60); $('l100').textContent = f2(p.last100); $('b100').textContent = f2(p.best100);
    PEAKS.forEach(({ k, v }) => { v.textContent = fmt(k, derived.peaks[k]); });
  } else if (screen === 'bus') {
    const lines = store.busLog.slice(-26); $('bussub').textContent = `${store.busCount.toLocaleString('en-US')} LINES`;
    // the log scrolls; these stay. CAR OFFERS = the PIDs the car lists, for working out a missing gauge.
    $('busfast').innerHTML = [store.adapter?.fast && 'FAST MODE: ' + esc(store.adapter.fast.toUpperCase()), store.adapter?.pids && 'CAR OFFERS: ' + esc(store.adapter.pids)].filter(Boolean).join('<br>');
    $('buslog').innerHTML = lines.map(([t, l]) => `<div class="l"><span>${(t / 1000 % 1000).toFixed(3).padStart(7)}</span>  ${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('');
  } else if (screen === 'systems') {
    B.car.set(car.short, false);
    B.src.set(store.source === 'sim' ? 'SIMULATOR' : store.source === 'ble' ? 'ADAPTER' : 'NONE', false);
    B.pause.set(store.paused ? 'PAUSED · SILENT' : 'OFF', store.paused);
    const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
    B.log.set(rec.on ? `STOP · ${native ? mb(rec.bytes || 0) : rec.lines.length + ' LINES'}` : 'START', rec.on);
    B.share.set(native ? (rec.lastName ? 'SHARE' : 'NONE YET') : (rec.last ? 'DOWNLOAD' : 'NONE YET'), false);
    B.bg.set(pref.bg, false); B.accent.set(pref.accent, false); B.night.set(pref.night.toUpperCase(), false); B.trip.set(`RESET (${derived.trip.toFixed(1)} MI)`, false);
    const ad = store.adapter;
    B.adapter.set(ad?.name ? ad.name.toUpperCase() : 'CHOOSE…', false);
    $('sysnote').innerHTML = [
      'Data source switches between the simulator and your OBD adapter. OBD adapter lets you pick a different one.',
      ad ? `Adapter: ${esc(ad.name || '?')} (${esc(ad.elm || 'no ELM327 reply')})` : '',
      ad?.channel ? `Channel: ${esc(typeof ad.channel === 'string' ? ad.channel : `${ad.channel.service} RX ${ad.channel.rx} TX ${ad.channel.tx}`)}` : '',
      (() => { const pct = Math.round((derived.k - 1) * 1000) / 10; return `Car: ${esc(car.name)}. Gear match ${pct > 0 ? '+' : ''}${pct.toFixed(1)} %, adjusted as you drive.`; })(),
      native ? (revReady ? 'Reverse: ready. R shows when the car moves backwards.' : 'Reverse: still learning which way your phone faces. Drive a few minutes in 2nd and up with the phone in its mount.') : '',
      ad?.services ? `Services: ${esc(Array.isArray(ad.services) ? ad.services.join(', ') : ad.services)}` : '',
      'Pause OBD stops everything the app sends. Turn it on before flashing with EcuTek.',
      'Test recording saves every reading, the adapter traffic, gear changes and how smoothly the screen draws. Tap MARK in the header when something feels off. When you stop, share the file back to Claude.',
      bleError ? 'Last error: ' + esc(bleError) : ''].filter(Boolean).join('<br>');
  }
}

// Shift graph trace: the eased RPM sampled every frame (not the raw 33 ms readings), so the curve
// is as smooth as the numbers. Kept a little longer than the 8 s window so the left edge never pops.
const trace = [];
function recordTrace(now, rpm) {
  trace.push({ t: now, rpm: rpm ?? 0, gear: derived.gear });
  while (trace.length && now - trace[0].t > 8600) trace.shift();
}

function drawShift(now) {
  // Always render at 2x or more (supersampling), so lines stay smooth even on 1x screens.
  const cv = $('graph'), r = cv.getBoundingClientRect(), d = Math.min(3, Math.max(2, devicePixelRatio || 1));
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const c = gctx, top = SIGNALS.rpm.hi, accent = ACCENTS[pref.accent];
  c.clearRect(0, 0, w, h);
  const px = { l: 34 * d, r: 14 * d, t: 16 * d, b: 18 * d }, pw = w - px.l - px.r, ph = h - px.t - px.b;
  const Y = (v) => px.t + ph * (1 - Math.min(v, top) / top);
  const snap = (v) => Math.round(v) + 0.5;   // crisp 1-device-pixel lines
  c.lineCap = 'round'; c.lineJoin = 'round';

  // grid
  c.font = `${9 * d}px ShareMono, monospace`; c.fillStyle = '#6e6e7a'; c.textBaseline = 'middle';
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.07)';
  c.beginPath();
  for (let k = 1; k <= 7; k++) { const y = snap(Y(k * 1000)); c.moveTo(px.l, y); c.lineTo(w - px.r, y); }
  c.stroke();
  for (let k = 1; k <= 7; k++) c.fillText(k + 'K', 6 * d, Y(k * 1000));

  // shift line: accent with a soft halo
  const sy = Y(car.rpm.shift);
  c.strokeStyle = accent; c.globalAlpha = 0.25; c.lineWidth = 5 * d; c.beginPath(); c.moveTo(px.l, sy); c.lineTo(w - px.r, sy); c.stroke();
  c.globalAlpha = 1; c.lineWidth = 1.25 * d; c.stroke();

  const X = (t) => w - px.r - pw * (now - t) / 8000;
  // drop samples closer than ~1.5 device pixels apart; the curve below interpolates between them
  const pts = [];
  for (const p of trace) {
    const x = X(p.t); if (x < px.l - 4 * d) continue;
    const last = pts[pts.length - 1];
    if (!last || x - last.x >= 1.5 * d) pts.push({ x, y: Y(p.rpm), gear: p.gear, t: p.t });
  }
  if (pts.length < 2) return;
  // smooth path: quadratic curves through the midpoints of consecutive samples
  const path = () => {
    c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2; c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my); }
    const e = pts[pts.length - 1]; c.lineTo(e.x, e.y);
  };

  // fading fill under the curve
  c.save(); c.beginPath(); c.rect(px.l, px.t - 4 * d, pw, ph + 4 * d); c.clip();
  path(); c.lineTo(pts[pts.length - 1].x, px.t + ph); c.lineTo(pts[0].x, px.t + ph); c.closePath();
  const g = c.createLinearGradient(0, px.t, 0, px.t + ph);
  g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fill();

  // gear-change markers: thin fading line + label
  let prev = null;
  for (const p of pts) {
    if (p.gear !== 'N' && prev && p.gear !== prev) {
      const x = snap(p.x), lg = c.createLinearGradient(0, px.t, 0, px.t + ph);
      lg.addColorStop(0, accent); lg.addColorStop(1, 'rgba(0,0,0,0)');
      c.strokeStyle = lg; c.lineWidth = 1; c.beginPath(); c.moveTo(x, px.t); c.lineTo(x, px.t + ph); c.stroke();
      c.fillStyle = accent; c.font = `${10 * d}px Michroma, sans-serif`; c.fillText(p.gear, x + 4 * d, px.t + 6 * d);
    }
    if (p.gear !== 'N') prev = p.gear;
  }

  // the trace: wide faint glow, medium glow, then a crisp core (no shadowBlur, which looks blocky)
  path();
  c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 9 * d; c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 4 * d; c.stroke();
  c.strokeStyle = '#f4f4f6'; c.lineWidth = 1.6 * d; c.stroke();
  c.restore();

  // live head: a glowing dot at the newest point
  const e = pts[pts.length - 1];
  const rg = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, 10 * d);
  rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = rg; c.beginPath(); c.arc(e.x, e.y, 10 * d, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(e.x, e.y, 2.6 * d, 0, Math.PI * 2); c.fill();
}

// ---- go
backdrop.setMode(pref.bg); applyCar(car.id, false); applyTheme(); setScreen('drive'); if (native) store.status = 'WAITING'; else setSource('sim');
// Draw on the display's own refresh (60/120 Hz on phones). requestAnimationFrame pauses in a
// background tab, so a slow timer keeps data, peaks and the datalog going there.
let lastRaf = 0;
(function loop() { lastRaf = performance.now(); frame(); requestAnimationFrame(loop); })();
setInterval(() => { if (performance.now() - lastRaf > 200) frame(); }, 100);
setInterval(applyTheme, 60000);
// Load the car model; retry a few times (a slow phone or a hiccup in the bundle server shouldn't leave it blank).
(async function loadModel(tries = 4) {
  try {
    await wire.load('data/z-model.json');
    post({ cmd: 'ready', info: `tabs=${TABS.length} looks=${LOOKS.length} model=${wire.model.n}pts webgl=${!!document.createElement('canvas').getContext('webgl')}` });
  } catch (e) {
    if (tries > 1) setTimeout(() => loadModel(tries - 1), 1500);
    else { console.warn('model failed', e); post({ cmd: 'jsError', msg: 'model failed: ' + e.message }); }
  }
})();
setTimeout(() => $('boot').classList.add('done'), 2300);
window.carbox = { store, derived, wire, setScreen, setSource, pref, gauges, openSheet }; // handy for debugging in the console
