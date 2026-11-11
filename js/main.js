import { Store, SIGNALS, fmt, frac, level } from './store.js';
import { Derived } from './derive.js';
import { SimSource } from './sim.js';
import { Elm327 } from './elm327.js';
import { Wire, VIEW_NAMES } from './wire.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const ACCENTS = { IGNITION: '#ff263e', ICE: '#46c8ff', CHAMPAGNE: '#e2ba6e', VOLT: '#beff3c' };

const store = new Store(), derived = new Derived(store), wire = new Wire();
let sim = null, elm = null, bleError = '';
const pref = (() => { try { return JSON.parse(localStorage.getItem('carbox') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('carbox', JSON.stringify({ accent: pref.accent, night: pref.night, tiles })); } catch { /* private mode */ } };
pref.accent = pref.accent || 'IGNITION'; pref.night = pref.night || 'auto';
let tiles = pref.tiles || ['boost', 'afr', 'iat', 'oil_temp', 'knock', 'ethanol'];
let screen = 'drive';
const rec = { on: false, rows: [], t0: 0 };

// ---- build static pieces
const TABS = ['drive', 'engine', 'shift', 'perf', 'bus', 'systems'];
TABS.forEach((t) => { const b = el('button', '', t); b.onclick = () => setScreen(t); b.dataset.t = t; $('tabs').append(b); });
function setScreen(t) {
  screen = t;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + t));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (typeof frame === 'function') frame();   // fill the new screen now, not one tick later
}
const mkSeg = (node, n) => { for (let i = 0; i < n; i++) node.append(el('i')); return [...node.children]; };
const rpmSeg = mkSeg($('rpmseg'), 28), ethSeg = mkSeg($('ethseg'), 12);
ethSeg.forEach((i) => i.parentElement.classList.add('amber'));
const CHIPS = ['ON BOOST', 'WOT', 'KNOCK', 'LEAN', 'ETHANOL', 'PAUSED'].map((n) => { const c = el('span', 'chip', n); $('chips').append(c); return c; });
const ROWS = ['boost', 'throttle', 'afr', 'coolant', 'oil_temp'].map((k) => {
  const r = el('div', 'kv', `<label>${SIGNALS[k].label}</label>${k === 'boost' || k === 'throttle' ? '<span class="lbar"><i></i></span>' : ''}<span><b></b> <u>${['°F', '%'].includes(SIGNALS[k].unit) ? SIGNALS[k].unit : ''}</u></span>`);
  $('rows').append(r); return { k, r, b: r.querySelector('b'), bar: r.querySelector('.lbar i') };
});
const VIEWBTN = VIEW_NAMES.map((v) => { const b = el('button', '', v); b.onclick = () => wire.setView(v); $('views').append(b); return b; });
const TILES = [0, 1, 2, 3, 4, 5].map((i) => {
  const t = el('button', 'panel tile', `<label></label><span class="pk"></span><div class="val"></div><div class="seg small"></div>`);
  t.onclick = () => { const keys = Object.keys(SIGNALS).filter((k) => !tiles.includes(k) || k === tiles[i]); tiles[i] = keys[(keys.indexOf(tiles[i]) + 1) % keys.length]; save(); };
  $('tiles').append(t); return { t, label: t.querySelector('label'), pk: t.querySelector('.pk'), val: t.querySelector('.val'), seg: mkSeg(t.querySelector('.seg'), 20) };
});
const PEAKS = ['boost', 'knock', 'iat', 'rpm'].map((k) => { const p = el('div', 'panel', `<label>PEAK ${SIGNALS[k].label}</label><div class="mid"></div>`); $('peaks').append(p); return { k, v: p.querySelector('.mid') }; });

// ---- system buttons
const btn = (title, cb) => { const b = el('button', 'panel btn', `<label>${title}</label><b></b>`); b.onclick = cb; $('btns').append(b); return { b, v: b.querySelector('b'), set(text, on) { this.v.textContent = text; b.classList.toggle('on', !!on); } }; };
const B = {
  src: btn('Data source', () => setSource(store.source === 'sim' ? 'ble' : 'sim')),
  pause: btn('Pause OBD', () => { if (native) post({ cmd: 'pause' }); else store.paused = !store.paused; }),
  log: btn('Datalog', () => toggleLog()),
  accent: btn('Style · accent', () => { const n = Object.keys(ACCENTS); pref.accent = n[(n.indexOf(pref.accent) + 1) % n.length]; applyTheme(); save(); }),
  night: btn('Night mode', () => { const o = ['auto', 'on', 'off']; pref.night = o[(o.indexOf(pref.night) + 1) % 3]; applyTheme(); save(); }),
  trip: btn('Trip', () => { derived.trip = 0; post({ cmd: 'resetTrip' }); }),
  adapter: btn('OBD adapter', () => { if (native) post({ cmd: 'scan' }); else setSource('ble'); }),
};
function applyTheme() {
  document.documentElement.style.setProperty('--accent', ACCENTS[pref.accent]); wire.color = ACCENTS[pref.accent];
  const h = new Date().getHours(), night = pref.night === 'on' || (pref.night === 'auto' && (h >= 19 || h < 6));
  document.body.classList.toggle('night', night); store.night = night;
}
function toggleLog() {
  if (native) { rec.on = !rec.on; post({ cmd: 'log' }); return; }   // native saves the CSV to the Files app
  if (!rec.on) { rec.on = true; rec.rows = []; rec.t0 = performance.now(); return; }
  rec.on = false;
  const keys = Object.keys(SIGNALS);
  const csv = ['time_s,' + keys.map((k) => `${k} (${SIGNALS[k].unit})`).join(','), ...rec.rows.map((r) => r.join(','))].join('\n');
  const a = el('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `carbox-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`; a.click();
}
// Inside the iPhone app, native Swift owns Bluetooth/OBD (it keeps running while the phone is locked
// and feeds CarPlay). The page then shows what native pushes and sends button presses back.
const native = window.webkit?.messageHandlers?.carbox;
const post = (msg) => native && native.postMessage(msg);
window.carboxNative = {
  push(p) {
    for (const k in p.v) store.set(k, p.v[k]);
    store.source = p.source === 'obd' ? 'ble' : p.source; store.status = p.status; store.paused = p.paused; bleError = p.error || '';
    if (p.adapter && Object.keys(p.adapter).length) store.adapter = p.adapter;
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
  if (kind === 'sim') { sim = new SimSource(store); sim.start(); return; }
  store.source = 'ble'; store.status = 'CONNECTING';
  try {
    const { WebBleTransport } = await import('./ble.js');
    elm = new Elm327(new WebBleTransport(), store);
    await elm.start();
  } catch (e) { bleError = e.message; store.source = 'none'; store.status = 'NO SOURCE'; if (!sim) { sim = new SimSource(store); sim.start(); } }
}

// ---- per-frame update
const clamp = (v) => Math.max(0, Math.min(1, v));
function lit(segs, f, redFrom) { const n = Math.round(clamp(f) * segs.length); segs.forEach((s, i) => { s.classList.toggle('on', i < n); s.classList.toggle('hot', redFrom != null && i >= Math.floor(redFrom * segs.length)); }); }
const col = (k, v) => ({ crit: 'var(--crit)', warn: 'var(--warn)', ok: 'var(--text)', none: 'var(--faint)' })[level(k, v)];
const gctx = $('graph').getContext('2d');
function fit(c) { const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return [c.width, c.height]; }
const live = () => store.source === 'ble' || store.source === 'sim';

// Displayed values glide toward the latest reading (about 90 ms), so numbers and bars move
// smoothly between OBD samples instead of stepping. Big jumps (new source, reconnect) snap.
const shown = {};
let lastNow = performance.now();
function easeAll(dt) {
  const out = {}, k = 1 - Math.exp(-dt / 90);
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
  derived.update(now);
  const E = easeAll(dt), g = (k) => E[k], snap = store.snapshot();
  recordTrace(now, E.rpm);
  // header
  $('hub').classList.toggle('live', store.count() > 0);
  const srcName = store.source === 'ble' ? 'OBD' : store.source.toUpperCase();
  $('hubText').textContent = `${srcName} · ${store.count()} SIG` + (store.status && store.status !== srcName && store.status !== 'OBD' ? ` · ${store.status}` : '');
  $('srcChip').textContent = store.source === 'sim' ? 'SIM' : store.source === 'ble' ? 'LIVE' : 'OFF';
  $('flashChip').hidden = !store.paused; $('recChip').hidden = !rec.on;
  $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
  // driver column
  const mph = g('speed'), rpm = g('rpm'), boost = g('boost'), afr = g('afr'), thr = g('throttle'), knock = g('knock'), eth = g('ethanol');
  $('mph').textContent = mph == null ? '--' : Math.round(mph); $('gear').textContent = derived.gear;
  $('rpmv').textContent = rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US');
  lit(rpmSeg, (rpm || 0) / SIGNALS.rpm.hi, 6800 / SIGNALS.rpm.hi);
  const set = (c, state) => { c.className = 'chip' + (state ? ' ' + state : ''); };
  set(CHIPS[0], (boost ?? -99) > 1 ? 'accent' : ''); set(CHIPS[1], (thr || 0) > 90 ? 'on' : '');
  set(CHIPS[2], (knock || 0) >= SIGNALS.knock.warn ? 'crit' : ''); set(CHIPS[3], (afr || 0) > 13.2 && (boost ?? -99) > 5 ? 'crit' : '');
  set(CHIPS[4], eth != null ? 'warn' : ''); CHIPS[4].textContent = eth != null ? 'E' + Math.round(eth) : 'ETHANOL'; set(CHIPS[5], store.paused ? 'crit' : '');
  ROWS.forEach(({ k, b, bar }) => { const v = g(k); b.textContent = fmt(k, v); b.style.color = col(k, v); if (bar) bar.style.transform = `scaleX(${frac(k, v).toFixed(4)})`; });

  if (screen === 'drive') {
    const r = $('wire').getBoundingClientRect(), [w, h] = fit($('wire'));
    const a = wire.draw($('wire'), w, h, now / 1000);
    if (a) placeCallouts(a, r, r.width / w, r.height / h, dt, [
      ['c-cabin', a.cabin, 0, -36, `OIL ${fmt('oil_temp', g('oil_temp'))}°F`],
      ['c-front', a.front, 30, -52, `BOOST ${fmt('boost', boost)} PSI`],
      ['c-rear', a.rear, -26, 44, `AFR ${fmt('afr', afr)}`],
    ]);
    $('viewname').textContent = 'VIEW · ' + wire.view; VIEWBTN.forEach((b, i) => b.classList.toggle('on', VIEW_NAMES[i] === wire.view));
    $('credit').textContent = wire.model ? wire.model.credit.split(', converted')[0] : '';
    $('trip').textContent = derived.trip.toFixed(1);
    $('eth').textContent = fmt('ethanol', eth); lit(ethSeg, (eth || 0) / 100);
    ['iat', 'battery', 'timing'].forEach((k) => { $('kv-' + k).textContent = fmt(k, g(k)); });
    $('pkboost').textContent = fmt('boost', derived.peaks.boost);
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
    $('buslog').innerHTML = lines.map(([t, l]) => `<div class="l"><span>${(t / 1000 % 1000).toFixed(3).padStart(7)}</span>  ${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('');
  } else if (screen === 'systems') {
    B.src.set(store.source === 'sim' ? 'SIMULATOR' : store.source === 'ble' ? 'ADAPTER' : 'NONE', false);
    B.pause.set(store.paused ? 'PAUSED · SILENT' : 'OFF', store.paused);
    B.log.set(rec.on ? (native ? "RECORDING" : `RECORDING · ${rec.rows.length}`) : "STOPPED", rec.on);
    B.accent.set(pref.accent, false); B.night.set(pref.night.toUpperCase(), false); B.trip.set(`RESET (${derived.trip.toFixed(1)} MI)`, false);
    const ad = store.adapter;
    B.adapter.set(ad?.name ? ad.name.toUpperCase() : 'CHOOSE…', false);
    $('sysnote').innerHTML = [
      'DATA SOURCE TOGGLES BETWEEN THE SIMULATOR AND YOUR BLUETOOTH OBD ADAPTER. OBD ADAPTER PICKS A DIFFERENT ONE.',
      ad ? `ADAPTER: ${esc(ad.name || '?')} · ${esc(ad.elm || 'NO ELM327 REPLY')}` : '',
      ad?.channel ? `CHANNEL: ${esc(typeof ad.channel === 'string' ? ad.channel : `${ad.channel.service} RX ${ad.channel.rx} TX ${ad.channel.tx}`)}` : '',
      ad?.services ? `SERVICES: ${esc(Array.isArray(ad.services) ? ad.services.join(', ') : ad.services)}` : '',
      'PAUSE OBD STOPS ALL TRANSMISSION: TURN IT ON BEFORE FLASHING WITH ECUTEK.',
      bleError ? 'LAST ERROR: ' + bleError.toUpperCase() : ''].filter(Boolean).join('<br>');
  }
  if (rec.on && !native) rec.rows.push([((now - rec.t0) / 1000).toFixed(3), ...Object.keys(SIGNALS).map((k) => snap[k] == null ? '' : snap[k].toFixed(3))]);
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
  const sy = Y(6800);
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
applyTheme(); setScreen('drive'); if (native) store.status = 'WAITING'; else setSource('sim');
// Draw on the display's own refresh (60/120 Hz on phones). requestAnimationFrame pauses in a
// background tab, so a slow timer keeps data, peaks and the datalog going there.
let lastRaf = 0;
(function loop() { lastRaf = performance.now(); frame(); requestAnimationFrame(loop); })();
setInterval(() => { if (performance.now() - lastRaf > 200) frame(); }, 100);
setInterval(applyTheme, 60000);
wire.load('data/z-model.json').catch((e) => console.warn('model failed', e));
setTimeout(() => $('boot').classList.add('done'), 2300);
window.carbox = { store, derived, wire, setScreen, setSource }; // handy for debugging in the console
