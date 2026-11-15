import { Store, SIGNALS, fmt, frac, level } from './store.js';
import { Derived } from './derive.js';
import { SimSource } from './sim.js';
import { Elm327 } from './elm327.js';
import { Wire, VIEW_NAMES } from './wire.js';
import { Sensors } from './sensors.js';
import { Perf } from './perf.js';
import { Drives, drawRoute } from './drives.js';
import { readAll, clearCodes, describe, simAnswer } from './diag.js';
import { drawGMeter, drawImuTrace, drawShift, drawBlip, drawSpark, drawDyno } from './charts.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ACCENTS = { IGNITION: '#ff263e', ICE: '#46c8ff', CHAMPAGNE: '#e2ba6e', VOLT: '#beff3c' };

const pref = (() => { try { return JSON.parse(localStorage.getItem('carbox') || '{}'); } catch { return {}; } })();
pref.accent = pref.accent || 'IGNITION'; pref.night = pref.night || 'auto';
const save = () => { try { localStorage.setItem('carbox', JSON.stringify({ accent: pref.accent, night: pref.night, weightLb: perf.weightLb, best60: perf.launch.best60, bestEt: perf.launch.bestEt, bestTrap: perf.launch.bestTrap })); } catch { /* private mode */ } };

const store = new Store(), derived = new Derived(store), wire = new Wire(), sensors = new Sensors();
const perf = new Perf(store, derived, sensors, pref), drives = new Drives();
sensors.carMph = () => store.get('speed');
let sim = null, elm = null, bleError = '', screen = 'home';
const rec = { on: false, rows: [], t0: 0 };
const native = window.webkit?.messageHandlers?.carbox;
const post = (msg) => native && native.postMessage(msg);

// ---- tabs
const TABS = [['home', 'HOME'], ['handling', 'HANDLING'], ['shift', 'SHIFT'], ['engine', 'ENGINE'], ['dyno', 'DYNO'], ['diag', 'DIAG'], ['drives', 'DRIVES'], ['bus', 'BUS'], ['settings', 'SETTINGS']];
TABS.forEach(([t, name]) => { const b = el('button', '', name); b.onclick = () => setScreen(t); b.dataset.t = t; $('tabs').append(b); });
function setScreen(t) {
  if (!TABS.some(([k]) => k === t)) t = 'home';
  screen = t;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + t));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'drives') renderDriveList();
  if (typeof frame === 'function') frame();
}

// ---- driver column (always visible)
const mkSeg = (node, n) => { for (let i = 0; i < n; i++) node.append(el('i')); return [...node.children]; };
const rpmSeg = mkSeg($('rpmseg'), 28);
const CHIPS = ['ON BOOST', 'WOT', 'KNOCK', 'LEAN', 'REV MATCH', 'DRIFT', 'LAUNCH', 'PAUSED'].map((n) => { const c = el('span', 'chip', n); $('chips').append(c); return c; });
const ROWS = ['boost', 'throttle', 'afr', 'coolant', 'iat'].map((k) => {
  const r = el('div', 'kv', `<label>${SIGNALS[k].label}</label>${k === 'boost' || k === 'throttle' ? '<span class="lbar"><i></i></span>' : ''}<span><b></b> <u>${['°F', '%'].includes(SIGNALS[k].unit) ? SIGNALS[k].unit : ''}</u></span>`);
  $('rows').append(r); return { k, r, b: r.querySelector('b'), bar: r.querySelector('.lbar i') };
});
const GROW = el('div', 'kv', '<label>G-FORCE</label><span><b>--</b> <u>G</u></span>'); $('rows').append(GROW);
const VIEWBTN = VIEW_NAMES.map((v) => { const b = el('button', '', v); b.onclick = () => wire.setView(v); $('views').append(b); return b; });

// ---- HOME panel buttons
$('resetDrift').onclick = () => perf.resetDrift();
$('clearTimes').onclick = () => { perf.clearTimes(); save(); };
const MULT = [1, 2, 3, 4, 5].map((m) => { const s = el('span', 'chip', 'x' + m); $('driftmult').append(s); return s; });

// ---- HANDLING
$('calib').onclick = () => { $('calib').textContent = sensors.calibrate() ? 'CALIBRATED ✓' : 'NO MOTION DATA'; setTimeout(() => { $('calib').textContent = 'CALIBRATE'; }, 2000); };
$('motionPerm').onclick = async () => { const r = await sensors.enableWeb(); $('motionPerm').textContent = r === 'ok' || r === 'native' ? 'SENSORS ✓' : 'NOT ALLOWED'; };

// ---- ENGINE: six sparkline cards
const ENGINE_KEYS = ['timing', 'lambda', 'maf', 'iat', 'stft', 'ltft'];
const ENGINE_FALLBACK = { lambda: 'afr' };   // the simulator has AFR, not lambda
const series = {};
const CARDS = ENGINE_KEYS.map((k) => {
  const c = el('div', 'panel ecard', `<label></label><span class="pk"></span><div class="val"></div><canvas></canvas>`);
  $('egrid').append(c); return { k, label: c.querySelector('label'), pk: c.querySelector('.pk'), val: c.querySelector('.val'), cv: c.querySelector('canvas') };
});
function recordSeries(now) {
  for (const k of [...ENGINE_KEYS, 'afr']) {
    const s = series[k] || (series[k] = []), v = store.get(k);
    if (!s.length || now - s[s.length - 1][0] > 100) s.push([now, v]);
    while (s.length && now - s[0][0] > 31000) s.shift();
  }
}

// ---- DYNO
$('wminus').onclick = () => { perf.weightLb = Math.max(2500, perf.weightLb - 50); save(); };
$('wplus').onclick = () => { perf.weightLb = Math.min(5000, perf.weightLb + 50); save(); };
$('dyclear').onclick = () => perf.clearDyno();

// ---- confirm dialog
function confirmBox(title, text) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirm').hidden = false;
    const done = (v) => { $('confirm').hidden = true; $('confirmYes').onclick = $('confirmNo').onclick = null; resolve(v); };
    $('confirmYes').onclick = () => done(true); $('confirmNo').onclick = () => done(false);
  });
}

// ---- DIAG: raw OBD requests go to whichever adapter is in use
const nativeWait = new Map(); let nativeId = 0;
function obdAsk(cmd) {
  if (store.source === 'sim') return new Promise((r) => setTimeout(() => r(simAnswer(cmd)), 60));
  if (store.paused) return Promise.reject(new Error('OBD is paused'));
  if (native) {
    return new Promise((resolve, reject) => {
      const id = ++nativeId;
      nativeWait.set(id, { resolve, reject });
      post({ cmd: 'obd', id, req: cmd });
      setTimeout(() => { if (nativeWait.delete(id)) reject(new Error('timeout ' + cmd)); }, 8000);
    });
  }
  if (elm) return elm.raw(cmd);
  return Promise.reject(new Error('No adapter connected'));
}
let diagBusy = false, diagResult = null;
async function runDiag() {
  if (diagBusy) return;
  diagBusy = true; $('diagsub').textContent = 'READING…';
  try { diagResult = await readAll(obdAsk); renderDiag(); }
  catch (e) { $('diagsub').textContent = 'COULD NOT READ: ' + e.message.toUpperCase(); }
  diagBusy = false;
}
function renderDiag() {
  const r = diagResult; if (!r) return;
  const st = r.status;
  $('diagsub').textContent = `${st ? (st.mil ? 'CHECK ENGINE ON' : 'CHECK ENGINE OFF') + ' · ' : ''}READ ${r.at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${store.source === 'sim' ? ' · SIMULATED' : ''}`;
  const group = (title, cls, codes) => codes.map((c) => `<div class="code ${cls}"><b>${c}</b><span>${esc(describe(c))}</span><em>${title}</em></div>`).join('');
  const html = group('STORED', 'crit', r.stored) + group('PENDING', 'warn', r.pending) + group('PERMANENT', 'perm', r.permanent);
  $('codelist').innerHTML = html || '<p class="ok">NO TROUBLE CODES</p>';
  $('monitors').innerHTML = st && st.monitors.length ? st.monitors.map((m) => `<div class="mon"><span>${m.name}</span><b class="${m.ready ? 'ok' : 'warn'}">${m.ready ? 'READY' : 'NOT READY'}</b></div>`).join('') : '<p class="dim">NOT REPORTED</p>';
  $('counters').innerHTML = r.counters.length ? r.counters.map(([l, v]) => `<div class="mon"><span>${l}</span><b>${v}</b></div>`).join('') : '<p class="dim">NOT REPORTED</p>';
}
$('readCodes').onclick = runDiag;
$('clearCodes').onclick = async () => {
  if (!(await confirmBox('CLEAR TROUBLE CODES?', 'This turns off the check-engine light and resets every readiness monitor, so the car will not pass an emissions test until they finish again. The fault itself is not fixed. Engine off, ignition on is safest.'))) return;
  try { const ok = await clearCodes(obdAsk); $('diagsub').textContent = ok ? 'CODES CLEARED' : 'THE CAR DID NOT CONFIRM'; setTimeout(runDiag, 1500); }
  catch (e) { $('diagsub').textContent = 'COULD NOT CLEAR: ' + e.message.toUpperCase(); }
};

// ---- DRIVES
let selDrive = null, replayAt = 1, playing = false;
function renderDriveList() {
  const list = drives.list;
  if (!selDrive || !list.includes(selDrive)) selDrive = list[0] || null;
  $('drivelist').innerHTML = list.length ? list.map((d) => {
    const s = new Date(d.start), mins = Math.max(1, Math.round((d.end - d.start) / 60000));
    return `<button class="drive${d === selDrive ? ' on' : ''}" data-id="${d.id}"><b>${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b><span>${d.miles.toFixed(1)} MI · ${mins} MIN · TOP ${Math.round(d.top)}</span>${d === drives.cur ? '<em>LIVE</em>' : ''}</button>`;
  }).join('') : '<p class="dim">DRIVES RECORD ON THEIR OWN WHEN THE CAR MOVES.</p>';
}
$('drivelist').addEventListener('click', (e) => { const b = e.target.closest('.drive'); if (!b) return; selDrive = drives.list.find((d) => d.id === +b.dataset.id); replayAt = 1; playing = false; renderDriveList(); });
$('scrub').oninput = (e) => { replayAt = e.target.value / 1000; playing = false; };
$('playBtn').onclick = () => { if (replayAt >= 0.999) replayAt = 0; playing = !playing; };

// ---- SETTINGS
const btn = (title, cb) => { const b = el('button', 'panel btn', `<label>${title}</label><b></b>`); b.onclick = cb; $('btns').append(b); return { b, v: b.querySelector('b'), set(text, on) { if (this.v.textContent !== text) this.v.textContent = text; b.classList.toggle('on', !!on); } }; };
const B = {
  src: btn('Data source', () => setSource(store.source === 'sim' ? 'ble' : 'sim')),
  adapter: btn('OBD adapter', () => { if (native) post({ cmd: 'scan' }); else setSource('ble'); }),
  pause: btn('Pause OBD', () => { if (native) post({ cmd: 'pause' }); else store.paused = !store.paused; }),
  log: btn('Datalog', () => toggleLog()),
  sensors: btn('Phone sensors', async () => { await sensors.enableWeb(); }),
  accent: btn('Style · accent', () => { const n = Object.keys(ACCENTS); pref.accent = n[(n.indexOf(pref.accent) + 1) % n.length]; applyTheme(); save(); }),
  night: btn('Night mode', () => { const o = ['auto', 'on', 'off']; pref.night = o[(o.indexOf(pref.night) + 1) % 3]; applyTheme(); save(); }),
  trip: btn('Trip', () => { derived.trip = 0; perf.resetTrip(); post({ cmd: 'resetTrip' }); }),
};
const TRIP = [['DISTANCE', 'mi'], ['DRIVING', 'time'], ['IDLE', 'time'], ['AVG SPEED', 'mph'], ['TOP SPEED', 'mph'], ['FUEL USED', 'gal'], ['ECONOMY', 'mpg'], ['PEAK BOOST', 'psi']].map(([l, u]) => {
  const d = el('div', 'stat', `<label>${l}</label><b>--</b><u>${u === 'time' ? '' : u.toUpperCase()}</u>`); $('tripgrid').append(d); return d.querySelector('b');
});
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
  const csv = ['time_s,' + keys.map((k) => `${k} (${SIGNALS[k].unit})`).join(',') + ',lat_g,long_g,yaw_dps,gps_lat,gps_lon', ...rec.rows.map((r) => r.join(','))].join('\n');
  const a = el('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `carbox-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`; a.click();
}

// ---- iPhone app bridge: native Swift owns Bluetooth/OBD, motion and GPS, and pushes them in.
window.carboxNative = {
  push(p) {
    for (const k in p.v) store.set(k, p.v[k]);
    store.source = p.source === 'obd' ? 'ble' : p.source; store.status = p.status; store.paused = p.paused; bleError = p.error || '';
    if (p.adapter && Object.keys(p.adapter).length) store.adapter = p.adapter;
    if (p.bus) for (const line of p.bus) store.log(line);
    if (p.imu || p.gps) sensors.push(p, store.get('speed'));
    showPicker(p.scanning ? (p.devices || []) : null);
  },
  reply(id, text, error) {   // answer to a raw OBD request (diagnostics)
    const w = nativeWait.get(id); if (!w) return;
    nativeWait.delete(id); if (error) w.reject(new Error(error)); else w.resolve(text);
  },
};
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

// ---- per-frame helpers
const clamp = (v) => Math.max(0, Math.min(1, v));
function lit(segs, f, redFrom) { const n = Math.round(clamp(f) * segs.length); segs.forEach((s, i) => { s.classList.toggle('on', i < n); s.classList.toggle('hot', redFrom != null && i >= Math.floor(redFrom * segs.length)); }); }
const col = (k, v) => ({ crit: 'var(--crit)', warn: 'var(--warn)', ok: 'var(--text)', none: 'var(--faint)' })[level(k, v)];
const fit = (c) => { const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return [c.width, c.height]; };
const setText = (id, t) => { const n = $(id); if (n.textContent !== t) n.textContent = t; };
const setChip = (c, state) => { const cls = 'chip' + (state ? ' ' + state : ''); if (c.className !== cls) c.className = cls; };
const f2 = (v) => v == null ? '--' : v.toFixed(2);
const hms = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + 'H ' : ''}${Math.floor(s / 60) % 60}M ${String(Math.floor(s % 60)).padStart(2, '0')}S`;

// Displayed values glide toward the latest reading (35 ms), so numbers and bars move smoothly between
// OBD samples. Big jumps (new source, reconnect) snap.
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

// Callouts on the car follow their anchor, stay inside the panel and push away from each other.
const callPos = {};
function placeCallouts(rect, sx, sy, dt, texts) {
  const credit = $('credit'), floor = credit.offsetHeight ? credit.offsetTop - 4 : rect.height - 48;
  const pad = 6, box = { l: pad, t: 26, r: rect.width - pad, b: Math.min(rect.height - 48, floor) };
  const placed = [], k = 1 - Math.exp(-dt / 70);
  for (const [id, anchor, dx, dy, text] of texts) {
    const c = $(id);
    if (c.textContent !== text) c.textContent = text;
    const w = c.offsetWidth, h = c.offsetHeight;
    let x = anchor[0] * sx + dx - w / 2, y = anchor[1] * sy + dy - h / 2;
    const cl = () => { x = Math.max(box.l, Math.min(box.r - w, x)); y = Math.max(box.t, Math.min(box.b - h, y)); };
    cl();
    for (let i = 0; i < 10; i++) {
      const hit = placed.find((p) => x < p.x + p.w + 4 && x + w + 4 > p.x && y < p.y + p.h + 4 && y + h + 4 > p.y);
      if (!hit) break;
      const down = y + h / 2 >= hit.y + hit.h / 2;
      y = down ? hit.y + hit.h + 4 : hit.y - h - 4;
      if (y < box.t || y + h > box.b) { y = down ? hit.y - h - 4 : hit.y + hit.h + 4; x = x + w / 2 < rect.width / 2 ? hit.x + hit.w + 6 : hit.x - w - 6; }
      cl();
    }
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
const trace = [];
const blipCv = el('canvas', 'blip'); $('rmdetail').after(blipCv);
let simPrevMph = 0, lastDriveList = 0;

function frame() {
  const now = performance.now(), dt = Math.min(250, now - lastNow); lastNow = now;
  derived.update(now);
  const E = easeAll(dt), g = (k) => E[k], snap = store.snapshot();
  if (store.source === 'sim' && !sensors.native && !sensors.webOn) { const m = store.get('speed') ?? 0; sensors.simulate(m, simPrevMph, dt / 1000, now); simPrevMph = m; }
  perf.update(now);
  trace.push({ t: now, rpm: E.rpm ?? 0, gear: derived.gear }); while (trace.length && now - trace[0].t > 8600) trace.shift();
  recordSeries(now);
  const imu = sensors.motionLive ? sensors.imu : null, gps = sensors.gpsLive ? sensors.gps : null;
  drives.update({ mph: store.get('speed') ?? gps?.mph, rpm: store.get('rpm'), boost: store.get('boost'), gear: derived.gear, lat: gps?.lat, lon: gps?.lon, g: imu ? Math.hypot(imu.lat, imu.lon) : null });

  // header
  $('hub').classList.toggle('live', store.count() > 0);
  const srcName = store.source === 'ble' ? 'OBD' : store.source.toUpperCase();
  setText('hubText', `${srcName} · ${store.count()} SIG` + (store.status && store.status !== srcName && store.status !== 'OBD' ? ` · ${store.status}` : ''));
  setText('srcChip', store.source === 'sim' ? 'SIM' : store.source === 'ble' ? 'LIVE' : 'OFF');
  setChip($('imuChip'), imu ? 'on' : ''); setChip($('gpsChip'), gps ? 'on' : '');
  $('flashChip').hidden = !store.paused; $('recChip').hidden = !rec.on;
  setText('clock', new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false }));

  // driver column
  const mph = g('speed') ?? gps?.mph ?? null, rpm = g('rpm'), boost = g('boost'), afr = g('afr'), thr = g('throttle'), knock = g('knock');
  setText('mph', mph == null ? '--' : String(Math.round(mph))); setText('gear', derived.gear);
  setText('rpmv', rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US'));
  lit(rpmSeg, (rpm || 0) / SIGNALS.rpm.hi, 6800 / SIGNALS.rpm.hi);
  const rm = perf.rev.last, recentRm = rm && now - rm.t < 3000;
  setChip(CHIPS[0], (boost ?? -99) > 1 ? 'accent' : ''); setChip(CHIPS[1], (thr || 0) > 90 ? 'on' : '');
  setChip(CHIPS[2], (knock || 0) >= SIGNALS.knock.warn ? 'crit' : ''); setChip(CHIPS[3], (afr || 0) > 13.2 && (boost ?? -99) > 5 ? 'crit' : '');
  setChip(CHIPS[4], recentRm ? (rm.score >= 75 ? 'accent' : 'warn') : ''); CHIPS[4].textContent = recentRm ? `REV ${rm.score}` : 'REV MATCH';
  setChip(CHIPS[5], perf.drift.active ? 'accent' : ''); setChip(CHIPS[6], perf.launch.state === 'running' ? 'accent' : perf.launch.state === 'staged' ? 'on' : '');
  setChip(CHIPS[7], store.paused ? 'crit' : '');
  ROWS.forEach(({ k, b, bar }) => { const v = g(k), t = fmt(k, v); if (b.textContent !== t) b.textContent = t; b.style.color = col(k, v); if (bar) bar.style.transform = `scaleX(${frac(k, v).toFixed(4)})`; });
  GROW.querySelector('b').textContent = imu ? Math.hypot(imu.lat, imu.lon).toFixed(2) : '--';

  if (screen === 'home') {
    const r = $('wire').getBoundingClientRect(), [w, h] = fit($('wire'));
    const a = wire.draw($('wire'), w, h, now / 1000);
    if (a) placeCallouts(r, r.width / w, r.height / h, dt, [
      ['c-cabin', a.cabin, 0, -36, `COOLANT ${fmt('coolant', g('coolant'))}°F`],
      ['c-front', a.front, 30, -52, `BOOST ${fmt('boost', boost)} PSI`],
      ['c-rear', a.rear, -26, 44, imu ? `${imu.lat >= 0 ? 'R' : 'L'} ${Math.abs(imu.lat).toFixed(2)} G` : `AFR ${fmt('afr', afr)}`],
    ]);
    setText('viewname', 'VIEW · ' + wire.view); VIEWBTN.forEach((b, i) => b.classList.toggle('on', VIEW_NAMES[i] === wire.view));
    setText('credit', wire.model ? wire.model.credit.split(', converted')[0] : '');
    const L = perf.launch, el60 = perf.launchElapsed(now);
    const stateName = { wait: 'WAITING', staged: 'STAGED', running: 'TIMING', done: 'DONE' }[L.state];
    setText('l60state', stateName); setChip($('l60state'), L.state === 'running' ? 'accent' : L.state === 'staged' ? 'on' : '');
    setText('qmstate', stateName); setChip($('qmstate'), L.state === 'running' ? 'accent' : L.state === 'staged' ? 'on' : '');
    $('l60').firstChild.textContent = L.state === 'running' && L.t60 == null ? el60.toFixed(2) : f2(L.t60);
    $('qm').firstChild.textContent = L.state === 'running' && L.et == null ? el60.toFixed(2) : f2(L.et);
    setText('l60hint', L.state === 'staged' ? 'READY · LAUNCH WHEN SAFE' : L.state === 'running' ? 'TIMING…' : 'STOP, THEN LAUNCH');
    setText('l60best', 'BEST ' + f2(L.best60));
    setText('qmtrap', L.trap != null ? `TRAP ${L.trap.toFixed(1)} MPH` : L.state === 'running' ? `${Math.round(L.dist * 3.28084)} FT` : 'ET AND TRAP SPEED');
    setText('qmbest', L.bestEt != null ? `BEST ${f2(L.bestEt)} @ ${L.bestTrap.toFixed(1)}` : 'BEST --');
    const D = perf.drift;
    setText('driftscore', Math.round(D.score).toLocaleString('en-US'));
    setText('driftangle', imu ? Math.round(sensors.beta) + '°' : '--°');
    MULT.forEach((m, i) => setChip(m, D.active && D.mult >= i + 1 ? 'accent' : ''));
    setText('driftstate', !imu ? 'NO IMU' : D.active ? 'DRIFTING' : 'READY'); setChip($('driftstate'), D.active ? 'accent' : imu ? 'on' : '');
    setText('drifthint', !imu ? 'NEEDS THE PHONE MOTION SENSOR (SETTINGS)' : D.active ? `COMBO ${Math.round(D.combo)}` : 'TURN VDC OFF FIRST · CLOSED COURSE ONLY');
  } else if (screen === 'handling') {
    drawGMeter($('gmeter'), imu, sensors.trace, sensors.peakG, ACCENTS[pref.accent]);
    drawImuTrace($('imutrace'), sensors.trace, sensors.level, ACCENTS[pref.accent]);
    const n2 = (v) => v == null ? '--' : v.toFixed(2);
    setText('h-lat', n2(imu && Math.abs(imu.lat))); setText('h-lon', n2(imu?.lon)); setText('h-peak', n2(imu ? sensors.peakG : null));
    setText('h-yaw', imu ? Math.round(imu.yaw).toString() : '--'); setText('h-beta', imu ? Math.round(sensors.beta).toString() : '--');
    setText('h-level', sensors.level ? Math.hypot(sensors.level.pitch, sensors.level.roll).toFixed(1) : '--');
    setText('imusub', imu ? (sensors.native ? 'IPHONE MOTION SENSOR' : store.source === 'sim' && !sensors.webOn ? 'SIMULATED MOTION' : 'PHONE MOTION SENSOR') : 'NO MOTION DATA · TAP ENABLE');
    $('motionPerm').hidden = sensors.native;
  } else if (screen === 'shift') {
    drawShift($('graph'), trace, now, ACCENTS[pref.accent]);
    const s = derived.shifts[derived.shifts.length - 1];
    setText('lastshift', s ? `${s.from}→${s.to}` : '--'); setText('lastshift2', s ? `${Math.round(s.before)} → ${Math.round(s.after)} RPM · DROP ${Math.round(s.before - s.after)}` : 'NO SHIFTS YET');
    setText('shiftcount', String(derived.shifts.length)); setText('shiftsub', `GEAR ${derived.gear} · LAST 8 S`);
    setText('rmscore', rm ? `${rm.from}→${rm.to} ${rm.score}` : '--');
    setText('rmdetail', rm ? `${rm.verdict} · ${rm.got.toLocaleString('en-US')} VS ${rm.target.toLocaleString('en-US')} RPM` : 'DOWNSHIFT TO SCORE');
    drawBlip(blipCv, rm, ACCENTS[pref.accent]);
    const hist = perf.rev.history.slice(1, 5).map((h) => `<span class="chip${h.score >= 75 ? ' on' : ''}">${h.from}→${h.to} ${h.score}</span>`).join('');
    if ($('rmhist').innerHTML !== hist) $('rmhist').innerHTML = hist;
  } else if (screen === 'engine') {
    CARDS.forEach((c) => {
      let k = c.k; if (store.get(k) == null && ENGINE_FALLBACK[k] && store.get(ENGINE_FALLBACK[k]) != null) k = ENGINE_FALLBACK[k];
      const s = SIGNALS[k], v = g(k);
      setText_(c.label, s.label); setText_(c.pk, 'PK ' + fmt(k, derived.peaks[k]));
      const html = `${fmt(k, v)}<small>${s.unit}</small>`; if (c.val.innerHTML !== html) c.val.innerHTML = html; c.val.style.color = col(k, v);
      drawSpark(c.cv, series[k] || [], s.lo, s.hi, k === 'ltft' || k === 'stft' ? 'rgb(70,200,255)' : 'rgb(232,232,238)');
    });
  } else if (screen === 'dyno') {
    const D = perf.dyno, live = D.cur ? Object.keys(D.cur.pts).map(Number).sort((a, b) => a - b).map((r) => ({ rpm: r, ...D.cur.pts[r] })) : null;
    drawDyno($('dynograph'), D.runs, live, ACCENTS[pref.accent]);
    $('dyhp').firstChild.textContent = D.peakHp ? Math.round(D.peakHp.hp) : '--';
    $('dytq').firstChild.textContent = D.peakTq ? Math.round(D.peakTq.tq) : '--';
    setText('dyhpat', D.peakHp ? `@ ${D.peakHp.rpm.toLocaleString('en-US')} RPM · ~${Math.round(D.peakHp.hp / (1 - perf.loss))} AT THE CRANK` : 'BEST RUN');
    setText('dytqat', D.peakTq ? `@ ${D.peakTq.rpm.toLocaleString('en-US')} RPM · CRANK` : 'BEST RUN');
    setText('dyweight', perf.weightLb.toLocaleString('en-US'));
    setText('dynosub', D.cur ? `PULL IN ${D.cur.gear} · RECORDING` : D.runs.length ? `${D.runs.length} RUN${D.runs.length > 1 ? 'S' : ''}` : 'WAITING FOR A PULL');
  } else if (screen === 'diag') {
    $('readCodes').disabled = diagBusy || store.paused; $('clearCodes').disabled = diagBusy || store.paused;
  } else if (screen === 'drives') {
    if (playing && selDrive) { const span = Math.max(1, selDrive.end - selDrive.start); replayAt = Math.min(1, replayAt + dt * 30 / span); if (replayAt >= 1) playing = false; }
    drawRoute($('routemap'), selDrive, replayAt, ACCENTS[pref.accent]);
    $('scrub').value = Math.round(replayAt * 1000); setText('playBtn', playing ? 'PAUSE' : 'PLAY');
    const p = selDrive?.pts[Math.round(replayAt * (selDrive.pts.length - 1))];
    setText('replayTime', p ? new Date(p[0]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '--');
    const html = p ? [['MPH', p[3] == null ? '--' : Math.round(p[3])], ['RPM', p[4] ? p[4].toLocaleString('en-US') : '--'], ['BOOST', p[5] ?? '--'], ['GEAR', p[6] ?? '--'], ['G', p[7] ?? '--']].map(([l, v]) => `<div class="stat"><label>${l}</label><b>${v}</b></div>`).join('') : '';
    if ($('replaydata').innerHTML !== html) $('replaydata').innerHTML = html;
    if (now - lastDriveList > 5000) { lastDriveList = now; renderDriveList(); }
    setText('drivesub', drives.cur ? 'RECORDING THIS DRIVE' : `${drives.list.length} SAVED · ON THIS PHONE ONLY`);
  } else if (screen === 'bus') {
    const lines = store.busLog.slice(-26); setText('bussub', `${store.busCount.toLocaleString('en-US')} LINES`);
    setText('busfast', store.adapter?.fast ? 'FAST MODE: ' + store.adapter.fast.toUpperCase() : '');
    $('buslog').innerHTML = lines.map(([t, l]) => `<div class="l"><span>${(t / 1000 % 1000).toFixed(3).padStart(7)}</span>  ${esc(l)}</div>`).join('');
  } else if (screen === 'settings') {
    B.src.set(store.source === 'sim' ? 'SIMULATOR' : store.source === 'ble' ? 'ADAPTER' : 'NONE', false);
    B.pause.set(store.paused ? 'PAUSED · SILENT' : 'OFF', store.paused);
    B.log.set(rec.on ? (native ? 'RECORDING' : `RECORDING · ${rec.rows.length}`) : 'STOPPED', rec.on);
    B.sensors.set(imu || gps ? `${imu ? 'MOTION' : ''}${imu && gps ? ' + ' : ''}${gps ? 'GPS' : ''}` : 'TAP TO ENABLE', false);
    B.accent.set(pref.accent, false); B.night.set(pref.night.toUpperCase(), false);
    const T = perf.tripStats; B.trip.set(`RESET (${T.miles.toFixed(1)} MI)`, false);
    const vals = [T.miles.toFixed(1), hms(T.moving), hms(T.idle), T.avg == null ? '--' : T.avg.toFixed(0), T.top.toFixed(0), T.gallons == null ? '--' : T.gallons.toFixed(2), T.mpg == null ? '--' : T.mpg.toFixed(1), fmt('boost', derived.peaks.boost)];
    TRIP.forEach((b, i) => setText_(b, String(vals[i])));
    const ad = store.adapter;
    B.adapter.set(ad?.name ? ad.name.toUpperCase() : 'CHOOSE…', false);
    const note = [
      'DATA SOURCE TOGGLES BETWEEN THE SIMULATOR AND YOUR BLUETOOTH OBD ADAPTER. OBD ADAPTER PICKS A DIFFERENT ONE.',
      ad ? `ADAPTER: ${esc(ad.name || '?')} · ${esc(ad.elm || 'NO ELM327 REPLY')}` : '',
      'PAUSE OBD STOPS ALL TRANSMISSION: TURN IT ON BEFORE FLASHING WITH ECUTEK.',
      'LAUNCH TIMES, DYNO NUMBERS AND DRIFT ANGLE ARE ESTIMATES FROM OBD SPEED AND THE PHONE’S SENSORS. CLOSED COURSE ONLY.',
      bleError ? 'LAST ERROR: ' + esc(bleError.toUpperCase()) : ''].filter(Boolean).join('<br>');
    if ($('sysnote').innerHTML !== note) $('sysnote').innerHTML = note;
  }
  if (rec.on && !native) rec.rows.push([((now - rec.t0) / 1000).toFixed(3), ...Object.keys(SIGNALS).map((k) => snap[k] == null ? '' : snap[k].toFixed(3)),
    imu ? imu.lat.toFixed(3) : '', imu ? imu.lon.toFixed(3) : '', imu ? imu.yaw.toFixed(1) : '', gps ? gps.lat.toFixed(6) : '', gps ? gps.lon.toFixed(6) : '']);
}
function setText_(n, t) { if (n.textContent !== t) n.textContent = t; }

// ---- go
applyTheme(); setScreen('home'); if (native) store.status = 'WAITING'; else setSource('sim');
// Draw on the display's own refresh (60/120 Hz). requestAnimationFrame pauses in a background tab,
// so a slow timer keeps data, timers and the drive log going there.
let lastRaf = 0;
(function loop() { lastRaf = performance.now(); frame(); requestAnimationFrame(loop); })();
setInterval(() => { if (performance.now() - lastRaf > 200) frame(); }, 100);
setInterval(applyTheme, 60000);
addEventListener('pagehide', () => drives._save());
(async function loadModel(tries = 4) {
  try {
    await wire.load('data/z-model.json');
    post({ cmd: 'ready', info: `tabs=${TABS.length} model=${wire.model.n}pts webgl=${!!document.createElement('canvas').getContext('webgl')}` });
  } catch (e) {
    if (tries > 1) setTimeout(() => loadModel(tries - 1), 1500);
    else { console.warn('model failed', e); post({ cmd: 'jsError', msg: 'model failed: ' + e.message }); }
  }
})();
setTimeout(() => $('boot').classList.add('done'), 2300);
window.carbox = { store, derived, wire, sensors, perf, drives, setScreen, setSource, pref, runDiag }; // handy for debugging in the console
