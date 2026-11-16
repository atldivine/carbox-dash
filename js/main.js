import { FeaturePages } from './features.js';
import { Store, SIGNALS, fmt, frac, level } from './store.js';
import { Derived } from './derive.js';
import { SimSource } from './sim.js';
import { Elm327 } from './elm327.js';
import { Wire, VIEW_NAMES } from './wire.js';
import { Sensors } from './sensors.js';
import { Perf } from './perf.js';
import { Drives, drawRoute } from './drives.js';
import { readAll, clearCodes, describe, simAnswer } from './diag.js';
import { drawGMeter, drawImuTrace, drawShift, drawBlip, drawSpark, drawDyno, drawWheels, drawDisc, drawSportGauge } from './charts.js';
import { PowerModel } from './power.js';
import { dockify } from './dock.js';
import { CanSource } from './can.js';
import { CAN_KEYS } from './canmap.js';
import { CanSim } from './cansim.js';
import { Particles, showShift } from './fx.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ACCENTS = { IGNITION: '#ff263e', ICE: '#46c8ff', CHAMPAGNE: '#e2ba6e', VOLT: '#beff3c' };
const OBD_LINKING = new Set(['CONNECTING', 'ADAPTER INIT', 'ECU SEARCH', 'INIT', 'SCANNING']);
const OBD_CHECK_KEYS = ['rpm', 'speed', 'throttle', 'coolant', 'fuel_level'];

const pref = (() => { try { return JSON.parse(localStorage.getItem('carbox') || '{}'); } catch { return {}; } })();
pref.accent = pref.accent || 'IGNITION'; pref.night = pref.night || 'auto';
const save = () => { try { localStorage.setItem('carbox', JSON.stringify({ accent: pref.accent, night: pref.night, canHost: pref.canHost, gauges: pref.gauges, gaugeCount: pref.gaugeCount, relayKey: pref.relayKey, trans: derived.transPref, detected: derived.trans, scale6: derived.scale['6MT'], scale9: derived.scale['9AT'], weightLb: perf.weightLb, best60: perf.launch.best60, bestEt: perf.launch.bestEt, bestTrap: perf.launch.bestTrap })); } catch { /* private mode */ } };

const store = new Store(), derived = new Derived(store, pref), wire = new Wire(), sensors = new Sensors();
const perf = new Perf(store, derived, sensors, pref), drives = new Drives();
sensors.carMph = () => store.get('speed');
let sim = null, elm = null, bleError = '', screen = 'home';
let sourceRequest = 0;
const rec = { on: false, rows: [], t0: 0 };
// Three ways to run: inside the iPhone app (WKWebView message handler), in a browser on the iPhone
// opened at http://localhost:8787 (CarTV on CarPlay: the Carbox app serves the page and streams live
// data, because iPhone browsers can't use Bluetooth), or on its own as a website (simulator / Web Bluetooth).
const IN_APP = !!window.webkit?.messageHandlers?.carbox;
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// Remote mode: the Carbox app on the phone uploads live data to the relay (relay.cjs) and this page watches it.
// Open the site once as https://carbox.nich.world/?live=KEY (the key is kept in this browser, then removed from the address bar).
const RELAY_KEY = (() => {
  if (IN_APP || (LOCAL && location.port === '8787')) return '';
  try {
    const u = new URL(location.href), k = u.searchParams.get('live');
    if (k) { localStorage.setItem('carbox-live', k); u.searchParams.delete('live'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
    return localStorage.getItem('carbox-live') || '';
  } catch { return ''; }
})();
const BRIDGE = !IN_APP && ((LOCAL && location.port === '8787') || !!RELAY_KEY);
const LIVE_URL = RELAY_KEY ? '/live?key=' + encodeURIComponent(RELAY_KEY) : '/live';
const CMD_URL = RELAY_KEY ? '/cmd?key=' + encodeURIComponent(RELAY_KEY) : '/cmd';
const native = window.webkit?.messageHandlers?.carbox
  || (BRIDGE ? { postMessage: (m) => fetch(CMD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Carbox': '1' }, body: JSON.stringify(m) }).catch(() => {}) } : null);
const LITE = BRIDGE || new URLSearchParams(location.search).has('lite');   // CarPlay mirroring: lighter effects
document.documentElement.classList.toggle('lite', LITE);
const WEBSITE = !native && !LOCAL;
const VIEW = !!RELAY_KEY || WEBSITE || new URLSearchParams(location.search).has('clean');   // the website: clean cockpit instead of the full dash
document.documentElement.classList.toggle('view', VIEW);
const post = (msg) => native && native.postMessage(msg);

// ---- tabs
const ALL_TABS = [['home', 'HOME'], ['power', 'POWER'], ['body', 'BODY'], ['handling', 'HANDLING'], ['drift', 'DRIFT'], ['diff', 'DIFF'], ['shift', 'SHIFT'], ['clutch', 'CLUTCH'], ['throttle', 'THROTTLE'], ['engine', 'ENGINE'], ['dyno', 'DYNO'], ['vdc', 'VDC'], ['diag', 'DIAG'], ['imu', 'IMU'], ['map', 'MAP'], ['drives', 'DRIVES'], ['systems', 'SYSTEMS'], ['bus', 'BUS'], ['settings', 'SETTINGS']];
const VIEW_TABS = ['drive', 'power', 'handling', 'engine', 'dyno', 'diag', 'map', 'settings'];
const TABS = VIEW ? [['overview', 'HOME'], ['drive', 'DRIVE'], ...ALL_TABS.filter(([k]) => VIEW_TABS.includes(k))] : ALL_TABS;
const featurePages = new FeaturePages({store, sensors, perf, drives, tabs: TABS, post, native});
TABS.forEach(([t, name]) => { const b = el('button', '', name); b.onclick = () => setScreen(t); b.dataset.t = t; $('tabs').append(b); });
function setScreen(t) {
  if (!TABS.some(([k]) => k === t)) t = 'home';
  screen = t;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + t));
  document.querySelectorAll('#tabs button').forEach((b) => { const on = b.dataset.t === t; b.classList.toggle('on', on); if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
  if (t === 'drives') renderDriveList();
  if (typeof frame === 'function') frame();
}

const DRIVE_ITEMS = [['boost', 'BOOST'], ['coolant', 'COOLANT'], ['iat', 'INTAKE'], ['battery', 'BATTERY']];
const driveRows = {};
if (VIEW) {
  $('rpmRed').style.strokeDasharray = `0 ${405.3 * 6800 / SIGNALS.rpm.hi} ${405.3 * (1 - 6800 / SIGNALS.rpm.hi)} 541`;
  for (const [k, name] of DRIVE_ITEMS) { const row = el('div', '', `<label>${name}</label><b>--</b>`); row.hidden = true; $('dvList').append(row); driveRows[k] = Object.assign(row, { b: row.querySelector('b') }); }
}
featurePages.configureTabs();
dockify($('tabs'), (t) => setScreen(t), { haptic: () => post({ cmd: 'haptic' }) });

// ---- driver column (always visible)
const mkSeg = (node, n) => { for (let i = 0; i < n; i++) node.append(el('i')); return [...node.children]; };
const rpmSeg = mkSeg($('rpmseg'), 28);
const CHIPS = ['ON BOOST', 'WOT', 'KNOCK', 'REV MATCH', 'VDC OFF', 'SLIP', 'P-BRAKE', 'ABS', 'DRIFT'].map((n) => { const c = el('span', 'chip', n); $('chips').append(c); return c; });
const ROWS = ['boost', 'throttle', 'brake', 'steer', 'coolant'].map((k) => {
  const bar = k === 'steer' ? '<span class="lbar mid"><i></i></span>' : ['boost', 'throttle', 'brake'].includes(k) ? '<span class="lbar"><i></i></span>' : '';
  const r = el('div', 'kv', `<label>${SIGNALS[k].label}</label>${bar}<span><b></b> <u>${['°F', '%', '°'].includes(SIGNALS[k].unit) ? SIGNALS[k].unit : ''}</u></span>`);
  $('rows').append(r); return { k, r, b: r.querySelector('b'), bar: r.querySelector('.lbar i') };
});
const GROW = el('div', 'kv', '<label>G-FORCE</label><span><b>--</b> <u>G</u></span>'); $('rows').append(GROW);
const CROW = el('div', 'kv', '<label>CLUTCH</label><span><b>--</b></span><label>CRUISE</label><span><b>--</b></span>'); $('rows').append(CROW);

// ---- CAN bus (CANsub + DBC). The starter DBC is a template until the Z's messages are confirmed.
const canSrc = new CanSource(store, '', CAN_KEYS), canSim = new CanSim(canSrc);
let dbcName = 'STARTER (UNVERIFIED)';
(async () => {
  let text = null; try { text = localStorage.getItem('carbox-dbc'); dbcName = localStorage.getItem('carbox-dbc-name') || dbcName; } catch { /* private mode */ }
  if (!text) { try { text = await (await fetch('data/z-can.dbc')).text(); dbcName = 'STARTER (UNVERIFIED)'; } catch { text = ''; } }
  canSrc.setDbc(text);
})();
$('canHost').value = pref.canHost || '';
$('canGo').onclick = async () => {
  const host = $('canHost').value.trim(); if (!host) return;
  pref.canHost = host; save();
  $('canNote').textContent = 'CONNECTING…';
  try { await canSrc.connect(host, 0); store.can = true; $('canNote').textContent = 'CONNECTED · LISTEN ONLY'; }
  catch (e) { store.can = false; $('canNote').textContent = e.message.toUpperCase(); }
};
const RELAY_HOST = 'carbox.nich.world';
// In the app, the pairing box is a dialog (opened from Settings > Website link) so it can't be missed
// below the fold; the same panel also sits first in Settings.
function openAppPair() {
  const panel = $('relayPanel'), dlg = $('pairDialog');
  dlg.querySelector('.pick').prepend(panel); panel.hidden = false;
  dlg.hidden = false; setTimeout(() => $('relayCode').focus(), 50);
}
function closeAppPair() { $('pairDialog').hidden = true; $('s-settings').prepend($('relayPanel')); }
if (IN_APP) {   // inside the phone app: pair with the website by code, or use a key; turn the upload on/off
  $('relayPanel').hidden = false;
  $('s-settings').prepend($('relayPanel'));   // first thing in Settings
  $('pairClose').onclick = closeAppPair;
  $('pairDialog').addEventListener('click', (e) => { if (e.target.id === 'pairDialog') closeAppPair(); });
  $('relayCode').oninput = (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d; };
  $('relayPair').onclick = async () => {
    const code = $('relayCode').value.replace(/\D/g, '');
    if (code.length !== 6) { $('relayNote').textContent = 'TYPE THE 6-DIGIT CODE SHOWN ON THE WEBSITE'; return; }
    $('relayNote').textContent = 'PAIRING…';
    try {
      // plain-text POST: no CORS preflight from the app's own page origin
      const r = await fetch(`https://${RELAY_HOST}/pair/claim`, { method: 'POST', body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.key) { $('relayNote').textContent = String(j.error || 'COULD NOT PAIR').toUpperCase(); return; }
      pref.relayKey = j.key; save(); $('relayKey').value = j.key; $('relayCode').value = '';
      post({ cmd: 'relay', on: true, key: j.key, host: RELAY_HOST });
      $('relayNote').textContent = 'PAIRED · STARTING THE UPLOAD…';
    } catch {
      // the page couldn't reach the site itself: let the app do it
      post({ cmd: 'relayPair', code, host: RELAY_HOST });
      $('relayNote').textContent = 'PAIRING THROUGH THE APP…';
    }
  };
  $('relayKey').value = pref.relayKey || '';
  $('relayGo').onclick = () => {
    const on = $('relayGo').textContent === 'START', key = $('relayKey').value.trim();
    if (on && !key) { $('relayNote').textContent = 'PASTE THE RELAY KEY FIRST'; return; }
    pref.relayKey = key; save();
    post({ cmd: 'relay', on, key, host: 'carbox.nich.world' });
  };
}
let relayState = 'off', ctlFull = false;
function showRelay(state) {
  if (!IN_APP || state == null) return;
  relayState = state; if (state !== 'live') ctlFull = false;
  const on = state !== 'off';
  $('relayGo').textContent = on ? 'STOP' : 'START';
  const msg = { off: 'OFF', connecting: 'CONNECTING…', live: 'LIVE · UPLOADING', retry: 'CAN’T REACH THE SERVER · RETRYING', denied: 'NOT ACCEPTED · CHECK THE CODE OR KEY' }[state];
  if (msg) $('relayNote').textContent = msg;
  $('control').hidden = !(state === 'live' && !ctlFull);   // control mode: while the site is the display, the phone is the remote
}
if (IN_APP) {
  $('ctlPause').onclick = () => post({ cmd: 'pause' });
  $('ctlPick').onclick = () => post({ cmd: 'scan' });
  $('ctlFull').onclick = () => { ctlFull = true; $('control').hidden = true; };
  $('ctlStop').onclick = () => post({ cmd: 'relay', on: false, key: pref.relayKey || '', host: 'carbox.nich.world' });
}
function updateControl() {   // called from frame(): only while the control screen is up
  if ($('control').hidden) return;
  const ad = store.adapter, sig = store.count('ble'), obdLive = store.source === 'ble' && store.status === 'OBD' && !store.paused && sig > 0;
  setText_($('ctlCar'), store.paused ? 'PAUSED' : obdLive ? 'LIVE' : store.status === 'OBD' ? 'NO DATA' : String(store.status || '--').toUpperCase());
  setText_($('ctlAdapter'), ad ? `${ad.name || 'ADAPTER'}`.toUpperCase() : 'NO ADAPTER · TAP ADAPTER');
  setText_($('ctlRate'), derived.rate && performance.now() - derived._lastSampleT < 3000 ? String(Math.round(derived.rate)) : '--');
  setText_($('ctlSignals'), `${sig} SIGNALS`);
  setText_($('ctlUp'), relayState === 'live' ? 'LIVE' : '--');
  setText_($('ctlPause'), store.paused ? 'RESUME OBD' : 'PAUSE OBD');
}
$('dbcFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text(); canSrc.setDbc(text); dbcName = f.name.toUpperCase();
  try { localStorage.setItem('carbox-dbc', text); localStorage.setItem('carbox-dbc-name', dbcName); } catch { /* too big / private */ }
};
$('dbcReset').onclick = async () => {
  try { localStorage.removeItem('carbox-dbc'); localStorage.removeItem('carbox-dbc-name'); } catch { /* private mode */ }
  canSrc.setDbc(await (await fetch('data/z-can.dbc')).text()); dbcName = 'STARTER (UNVERIFIED)';
};
const fx = new Particles($('fx'));
const power = new PowerModel(store), ovShown = { hp: null, tq: null };
// POWER page gauges, BMW sport-display style: each slot shows one of these; tap a gauge to change it.
const GAUGE_DEFS = {
  hp:       { label: 'POWER',    unit: 'HP',    get: (pw) => pw.hp, max: () => power.maxHp },
  tq:       { label: 'TORQUE',   unit: 'LB-FT', get: (pw) => pw.tq, max: () => power.maxTq },
  boost:    { label: 'BOOST',    unit: 'PSI',   get: () => store.get('boost'), min: -15, max: () => 25, dec: 1 },
  g:        { label: 'G-FORCE',  unit: 'G',     get: () => (sensors.motionLive ? Math.hypot(sensors.imu.lat, sensors.imu.lon) : null), max: () => 1.5, dec: 2 },
  rpm:      { label: 'RPM',      unit: 'RPM',   get: () => store.get('rpm'), max: () => 7500, step: 1000 },
  speed:    { label: 'SPEED',    unit: 'MPH',   get: () => store.get('speed'), max: () => 180, step: 20 },
  oil_temp: { label: 'OIL',      unit: '°F',    get: () => store.get('oil_temp'), min: 100, max: () => 300 },
  coolant:  { label: 'COOLANT',  unit: '°F',    get: () => store.get('coolant'), min: 100, max: () => 260, step: 40 },
  iat:      { label: 'INTAKE',   unit: '°F',    get: () => store.get('iat'), max: () => 200, step: 40 },
  afr:      { label: 'AFR',      unit: ':1',    get: () => store.get('afr'), min: 9, max: () => 18, dec: 1, step: 1 },
  throttle: { label: 'THROTTLE', unit: '%',     get: () => store.get('throttle'), max: () => 100, step: 20 },
  brake:    { label: 'BRAKE',    unit: '%',     get: () => store.get('brake'), max: () => 100, step: 20 },
};
const GAUGE_IDS = Object.keys(GAUGE_DEFS);
pref.gauges = Array.isArray(pref.gauges) && pref.gauges.length === 4 ? pref.gauges : ['hp', 'tq', 'boost', 'g'];
pref.gaugeCount = pref.gaugeCount === 4 ? 4 : 2;
const gaugeSlots = [...document.querySelectorAll('#powerbody .pgauge')].map((b, i) => {
  b.onclick = () => { pref.gauges[i] = GAUGE_IDS[(GAUGE_IDS.indexOf(pref.gauges[i]) + 1) % GAUGE_IDS.length]; gaugePeaks[i] = null; gaugeShown[i] = null; save(); };
  return { b, cv: b.querySelector('canvas'), name: b.querySelector('.gname') };
});
const gaugePeaks = [null, null, null, null], gaugeShown = [null, null, null, null];
function layoutGauges() { $('powerbody').classList.toggle('four', pref.gaugeCount === 4); gaugeSlots.forEach((s, i) => { s.b.hidden = i >= pref.gaugeCount; }); $('gaugeCount').textContent = pref.gaugeCount === 4 ? '2 GAUGES' : '4 GAUGES'; }
layoutGauges();
$('gaugeCount').onclick = () => { pref.gaugeCount = pref.gaugeCount === 4 ? 2 : 4; layoutGauges(); save(); };
$('powerReset').onclick = () => { power.resetPeaks(); gaugePeaks.fill(null); };
const shiftPop = $('shiftPop');
let lastRevT = 0, lastShiftT = 0, lastGear = 'N';
const clutchStats = { count: 0, wasIn: false, launchSlip: null, engAng: 0, inAng: 0 };
const ON = (k) => store.get(k);
const BODY = [
  ['DRIVER DOOR', () => ON('door_fl'), (v) => (v ? 'OPEN' : 'CLOSED'), (v) => v],
  ['PASSENGER DOOR', () => ON('door_fr'), (v) => (v ? 'OPEN' : 'CLOSED'), (v) => v],
  ['HATCH', () => ON('hatch'), (v) => (v ? 'OPEN' : 'SHUT'), (v) => v],
  ['LOCKS', () => ON('locked'), (v) => (v ? 'LOCKED' : 'UNLOCKED'), () => false],
  ['SEAT BELT', () => ON('belt'), (v) => (v ? 'ON' : 'OFF'), (v) => !v],
  ['IGNITION', () => ON('ignition'), (v) => ['OFF', 'ACC', 'ON', 'RUNNING'][v] || '--', () => false],
  ['HEADLIGHTS', () => ON('lights'), (v) => ['OFF', 'PARKING', 'LOW BEAM', 'HIGH BEAM'][v] || '--', () => false],
  ['WIPERS', () => ON('wiper'), (v) => ['OFF', 'INT', 'LOW', 'HIGH'][v] || '--', () => false],
  ['TURN SIGNAL', () => (ON('turn_l') == null && ON('turn_r') == null ? null : (ON('turn_l') ? 1 : 0) + (ON('turn_r') ? 2 : 0)), (v) => ['OFF', 'LEFT', 'RIGHT', 'BOTH'][v], () => false],
  ['HAZARDS', () => ON('hazard'), (v) => (v ? 'ON' : 'OFF'), (v) => v],
  ['PARKING BRAKE', () => ON('pbrake'), (v) => (v ? 'SET' : 'OFF'), (v) => v && (store.get('speed') || 0) > 3],
  ['VDC', () => ON('vdc_off'), (v) => (v ? 'OFF' : 'ON'), (v) => v],
  ['ABS', () => ON('abs'), (v) => (v ? 'ACTIVE' : 'READY'), (v) => v],
  ['TRACTION', () => ON('tcs'), (v) => (v ? 'SLIPPING' : 'GRIP'), (v) => v],
  ['CRUISE', () => ON('cruise'), (v) => (v ? 'ON' : 'OFF'), () => false],
  ['FUEL', () => ON('fuel_level'), (v) => Math.round(v) + '%', (v) => v < 12],
  ['ODOMETER', () => ON('odo'), (v) => Math.round(v).toLocaleString('en-US') + ' MI', () => false],
  ['BRAKE', () => ON('brake'), (v) => Math.round(v) + '%', () => false],
].map(([label, get, text, alert]) => { const t = el('div', 'stat btile', `<label>${label}</label><b>--</b>`); $('bodygrid').append(t); return { get, text, alert, t, b: t.querySelector('b') }; });
const TIRES = ['fl', 'fr', 'rl', 'rr'].map((k) => { const t = el('div', 'stat', `<label>${k.toUpperCase()}</label><b>--</b>`); $('tiregrid').append(t); return { k: 'tpms_' + k, t, b: t.querySelector('b') }; });
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
  if (store.source !== 'ble' || store.status !== 'OBD') return Promise.reject(new Error(bleError || 'Live OBD connection required'));
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
featurePages.selectedDrive = () => selDrive;
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
  link: btn('Website link', () => {
    if (IN_APP) { openAppPair(); return; }   // in the phone app: the box to type the website's code
    startPairing();   // new code (the pairing screen also has FORGET THIS CAR); no confirm(): in-car browsers block pop-ups
  }),
  trans: btn('Transmission', () => { const o = ['auto', '6MT', '9AT']; derived.setTransmission(o[(o.indexOf(derived.transPref) + 1) % 3]); post({ cmd: 'trans', value: derived.transPref }); save(); }),
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
    useStoreSource(p.source === 'obd' ? 'ble' : p.source);
    // In the app's own page a key missing from a frame means native retired it. Through the bridge/relay, one thin or
    // dropped frame must not blank a value: the store's own expiry (2 s fast keys, 12 s the rest) retires it instead.
    if (store.source === 'ble' && !BRIDGE) store.clearSource('ble', p.v);
    for (const k in p.v) store.set(k, p.v[k]);
    store.status = p.status; store.paused = p.paused; bleError = p.error || '';
    store.adapter = p.adapter && Object.keys(p.adapter).length ? p.adapter : null;
    if (p.bus) for (const line of p.bus) store.log(line);
    if (p.imu || p.gps) sensors.push(p, store.get('speed'));
    showPicker(p.scanning ? (p.devices || []) : null);
    showRelay(p.relay);
  },
  reply(id, text, error) {   // answer to a raw OBD request (diagnostics)
    const w = nativeWait.get(id); if (!w) return;
    nativeWait.delete(id); if (error) w.reject(new Error(error)); else w.resolve(text);
  },
};
// Bridge mode: live data arrives as Server-Sent Events from the Carbox app on this iPhone.
if (BRIDGE) {
  let es = null, lastMsg = 0;
  const open = () => {
    es?.close(); es = new EventSource(LIVE_URL);
    es.onmessage = (e) => {
      lastMsg = performance.now();
      try { const m = JSON.parse(e.data); if (m.push) window.carboxNative.push(m.push); if (m.reply) window.carboxNative.reply(m.reply.id, m.reply.text, m.reply.error); } catch { /* partial */ }
    };
  };
  open();
  setInterval(() => {
    const quiet = performance.now() - lastMsg;
    if (quiet > 4000) { store.status = RELAY_KEY ? 'NO DATA · OPEN THE CARBOX APP ON THE PHONE' : 'BRIDGE LOST · OPEN THE CARBOX APP'; open(); }   // the app was closed: retry
    if (RELAY_KEY) $('offBar').hidden = quiet < 10000 || !$('pairScreen').hidden;   // car offline for 10 s: offer a new code
  }, 2000);
}
let pickerKey = '';
function showPicker(devices) {
  const box = $('picker');
  if (!devices) { box.hidden = true; pickerKey = ''; return; }
  box.hidden = false;
  const key = devices.map((d) => d.id + d.rssi).join();
  if (key === pickerKey) return;                    // unchanged: don't rebuild under the user's finger
  pickerKey = key;
  $('pickList').innerHTML = devices.length ? devices.map((d) =>
    d.ecutek
      ? `<div class="dev ecutek"><span>${esc(d.name)}</span><small>ECUTEK · ECU CONNECT ONLY</small></div>`
      : `<button class="dev${d.likely ? ' likely' : ''}" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><small>${d.rssi} dBm</small></button>`).join('')
    + (devices.some((d) => d.ecutek) ? '<p class="dim">ECUTEK EVI-BT FOUND: IT ONLY WORKS WITH ECU CONNECT AND FLASHES YOUR ECU, SO CARBOX LEAVES IT ALONE. FOR ECUTEK VALUES USE RACEROM CAN OUTPUT (SETTINGS &gt; CAN BUS).</p>' : '')
    : '<p class="dim">SEARCHING…</p>';
}
$('pickList').addEventListener('click', (e) => { const b = e.target.closest('.dev[data-id]'); if (b) { post({ cmd: 'connect', id: b.dataset.id }); showPicker(null); } });
$('pickCancel').addEventListener('click', () => { post({ cmd: 'cancelScan' }); showPicker(null); });
function useStoreSource(kind) {
  if (kind === store.source) return;
  drives.finish();
  store.clearSource(store.source);
  store.source = kind;
}
async function setSource(kind) {
  if (native) { post({ cmd: 'source' }); return; }
  const request = ++sourceRequest;
  if (elm) { elm.stop(); elm = null; }
  if (sim) { sim.stop(); sim = null; }
  store.clearSource(store.source); store.adapter = null; store.paused = false; bleError = '';
  if (kind === 'sim') { drives.finish(); sim = new SimSource(store); sim.start(); return; }
  store.source = 'ble'; store.status = 'CONNECTING';
  try {
    const { WebBleTransport } = await import('./ble.js');
    if (request !== sourceRequest) return;
    elm = new Elm327(new WebBleTransport(), store);
    await elm.start();
  } catch (e) {
    if (request !== sourceRequest) return;
    elm?.stop(); elm = null;
    useStoreSource('none');
    bleError = e.message; store.status = 'ADAPTER FAILED';
  }
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

// Smoothing. Every value is drawn through a critically damped spring (smooth start and stop, no
// overshoot) whose speed follows how often that value actually arrives: ~20 samples/s from a fast
// adapter or CAN glides over ~30 ms, a value refreshed 4 times a second over ~150 ms, so slow adapters
// look fluid instead of stepping. States (doors, lights...) and big jumps snap.
const shown = {}, vel = {};
let lastNow = performance.now();
function easeAll(dt) {
  const out = {};
  for (const key in SIGNALS) {
    const v = store.get(key), s = SIGNALS[key];
    if (v === null) { delete shown[key]; delete vel[key]; out[key] = null; continue; }
    if (s.step || shown[key] == null || Math.abs(v - shown[key]) > (s.hi - s.lo) * 0.5) { shown[key] = v; vel[key] = 0; out[key] = v; continue; }
    const tau = Math.max(25, Math.min(160, (store.iv[key] || 50) * 0.6)), w = 2 / tau;   // ms
    // exact critically damped step (stable at any frame time)
    const d0 = shown[key] - v, u0 = vel[key] || 0, c = u0 + w * d0, e = Math.exp(-w * dt);
    shown[key] = v + (d0 + c * dt) * e; vel[key] = (u0 - w * c * dt) * e; out[key] = shown[key];
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
  if (store.source === 'sim') canSim.frame(now, store, sensors);
  { const ci = clutchIn(); if (ci === false && clutchStats.wasIn) clutchStats.count++; if (ci != null) clutchStats.wasIn = ci;
    const L = perf.launch, e = store.get('rpm'), ir = inputRpm();
    if (L.state === 'running' && clutchStats._lt !== L.t0 && e && ir != null && Math.abs(e - ir) / e < 0.03) { clutchStats._lt = L.t0; clutchStats.launchSlip = (now - L.t0) / 1000; } }
  const canLive = canSrc.msgRate > 0;
  perf.update(now);
  const pw = power.read();
  if (!LITE) { fx.color = ACCENTS[pref.accent]; fx.frame(now, (store.get('throttle') || 0) / 100); }
  wire.speed = store.get('speed') ?? 0;
  trace.push({ t: now, rpm: E.rpm ?? 0, gear: derived.gear }); while (trace.length && now - trace[0].t > 8600) trace.shift();
  recordSeries(now);
  const imu = sensors.motionLive ? sensors.imu : null, gps = sensors.gpsLive ? sensors.gps : null;
  const wsF = avg2('ws_fl', 'ws_fr'), wsR = avg2('ws_rl', 'ws_rr');
  wheelSlip = wsF != null && wsR != null && wsF > 3 ? (wsR - wsF) / wsF * 100 : 0;
  if (store.source !== 'sim') drives.update({ mph: store.get('speed') ?? gps?.mph, rpm: store.get('rpm'), boost: store.get('boost'), gear: derived.gear, lat: gps?.lat, lon: gps?.lon, g: imu ? Math.hypot(imu.lat, imu.lon) : null });

  featurePages.update(screen, now);
  updateControl();

  // header
  const obdSignals = store.count('ble'), canSignals = store.count('can');
  const obdLive = store.source === 'ble' && store.status === 'OBD' && !store.paused && obdSignals > 0;
  const linkHz = derived.rate && performance.now() - derived._lastSampleT < 3000 ? Math.round(derived.rate) : null;
  const obdStatus = store.paused ? 'PAUSED' : obdLive ? `LIVE · ${obdSignals} SIG${linkHz ? ` · ${linkHz}/S${linkHz < 3 ? ' WEAK' : ''}` : ''}` : store.status === 'OBD' ? 'NO DATA' : store.status;
  const simulated = store.source === 'sim';
  const hub = simulated ? `SIM · ${store.count('sim')} SIG` : canSignals ? `OBD · ${obdStatus} / CAN · ${canSignals} SIG` : `OBD · ${obdStatus}`;
  const srcChip = simulated ? 'SIM' : obdLive ? 'LIVE' : store.paused ? 'PAUSED' : obdStatus === 'ADAPTER FAILED' ? 'OBD FAILED'
    : OBD_LINKING.has(obdStatus) ? 'LINKING' : ['NO DATA', 'NO LIVE DATA'].includes(obdStatus) ? 'NO DATA'
    : obdStatus === 'DISCONNECTED' ? 'LINK LOST' : 'OFF';
  $('hub').classList.toggle('live', obdLive || canSignals > 0);
  setText('hubText', hub);
  setText('srcChip', srcChip); setChip($('srcChip'), obdLive || simulated ? 'on' : obdStatus === 'ADAPTER FAILED' ? 'crit' : '');
  setChip($('imuChip'), imu ? 'on' : ''); setChip($('gpsChip'), gps ? 'on' : '');
  const lk = store.get('locked'), bt = store.get('belt');
  $('lockChip').hidden = lk == null; setText('lockChip', lk ? 'LOCKED' : 'UNLOCKED'); setChip($('lockChip'), lk ? 'on' : '');
  $('beltChip').hidden = bt == null; setText('beltChip', bt ? 'BELT ON' : 'BELT OFF'); setChip($('beltChip'), bt ? '' : 'crit');
  $('turnL').hidden = !(store.get('turn_l') || store.get('hazard')); $('turnR').hidden = !(store.get('turn_r') || store.get('hazard'));
  $('flashChip').hidden = !store.paused; $('recChip').hidden = !rec.on;
  setText('clock', new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false }));

  // driver column
  const mph = g('speed') ?? gps?.mph ?? null, rpm = g('rpm'), boost = g('boost'), afr = g('afr'), thr = g('throttle'), knock = g('knock');
  setText('mph', mph == null ? '--' : String(Math.round(mph))); setText('gear', derived.gear);
  if (VIEW) {   // clean cockpit
    const C = 405.3, spd = mph == null ? 0 : Math.min(1, mph / 160), rr = (rpm || 0) / SIGNALS.rpm.hi;
    $('spdArc').style.strokeDasharray = `${C * spd} 541`; $('rpmArc').style.strokeDasharray = `${C * Math.min(1, rr)} 541`;
    $('rpmArc').classList.toggle('hot', (rpm || 0) >= 6800);
    setText_($('dvSpeed'), mph == null ? '--' : String(Math.round(mph))); setText_($('dvRpm'), rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US')); setText_($('dvGear'), derived.gear);
    for (const [k, name] of DRIVE_ITEMS) { const row = driveRows[k], v = g(k); row.hidden = v == null; if (v != null) { setText_(row.b, fmt(k, v) + ' ' + SIGNALS[k].unit); const lv = level(k, v); row.b.className = lv === 'crit' ? 'crit' : lv === 'warn' ? 'warn' : ''; } }
    setText_($('dvStat'), store.paused ? 'PAUSED' : store.status === 'OBD' ? '' : String(store.status || '').toUpperCase());
  }
  setText('rpmv', rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US'));
  lit(rpmSeg, (rpm || 0) / SIGNALS.rpm.hi, 6800 / SIGNALS.rpm.hi);
  const rm = perf.rev.last, recentRm = rm && now - rm.t < 3000;
  const lean = (afr || 0) > 13.2 && (boost ?? -99) > 5;
  setChip(CHIPS[0], (boost ?? -99) > 1 ? 'accent' : ''); setChip(CHIPS[1], (thr || 0) > 90 ? 'on' : '');
  setChip(CHIPS[2], (knock || 0) >= SIGNALS.knock.warn || lean ? 'crit' : ''); setText_(CHIPS[2], lean ? 'LEAN' : 'KNOCK');
  setChip(CHIPS[3], recentRm ? (rm.score >= 75 ? 'accent' : 'warn') : ''); setText_(CHIPS[3], recentRm ? `REV ${rm.score}` : 'REV MATCH');
  setChip(CHIPS[4], store.get('vdc_off') ? 'warn' : ''); setChip(CHIPS[5], store.get('tcs') || wheelSlip > 4 ? 'crit' : '');
  setChip(CHIPS[6], store.get('pbrake') ? 'warn' : ''); setChip(CHIPS[7], store.get('abs') ? 'crit' : '');
  setChip(CHIPS[8], perf.drift.active ? 'accent' : '');
  ROWS.forEach(({ k, b, bar }) => {
    const v = g(k); let t = fmt(k, v);
    if (k === 'steer' && v != null) t = Math.abs(Math.round(v)) + (v < -0.5 ? ' L' : v > 0.5 ? ' R' : '');
    if (b.textContent !== t) b.textContent = t; b.style.color = col(k, v);
    if (bar && k === 'steer') { const f = Math.min(1, Math.abs(v || 0) / 540); bar.style.transformOrigin = (v || 0) < 0 ? 'right' : 'left'; bar.style.marginLeft = (v || 0) < 0 ? '0' : '50%'; bar.style.transform = `scaleX(${f.toFixed(4)})`; }
    else if (bar) bar.style.transform = `scaleX(${frac(k, v).toFixed(4)})`;
  });
  const cl = clutchIn(), cr = store.get('cruise');
  const cb = CROW.querySelectorAll('b'); setText_(cb[0], cl == null ? '--' : cl ? 'IN' : 'OUT'); setText_(cb[1], cr == null ? '--' : cr ? 'ON' : 'OFF');
  // shift animation: the gear box pulses on every change; downshifts get their rev-match banner, upshifts the rpm drop
  if (derived.gear !== lastGear) { for (const gb of [$('gearBox'), $('ovGearBox')]) { gb.classList.remove('pulse'); void gb.offsetWidth; gb.classList.add('pulse'); } lastGear = derived.gear; }
  if (rm && rm.t !== lastRevT) { lastRevT = rm.t; for (const el of [shiftPop, $('ovPop')]) showShift(el, `<small>${rm.from}&rarr;${rm.to}</small><b>${rm.verdict}</b><em>${rm.score}</em>`, rm.score >= 75 ? 'good' : rm.score >= 55 ? 'ok' : 'bad'); }
  const ls = derived.shifts[derived.shifts.length - 1];
  if (ls && ls.t !== lastShiftT) { lastShiftT = ls.t; if (+ls.to > +ls.from) for (const el of [shiftPop, $('ovPop')]) showShift(el, `<small>${ls.from}&rarr;${ls.to}</small><b>SHIFT</b><em>-${Math.round((ls.before - ls.after) / 100) / 10}K</em>`, 'up'); }
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
  } else if (screen === 'overview') {
    const acc = ACCENTS[pref.accent], k = 1 - Math.exp(-dt / 120);
    ovShown.hp = pw.hp == null ? null : (ovShown.hp ?? pw.hp) + (pw.hp - (ovShown.hp ?? pw.hp)) * k;
    ovShown.tq = pw.tq == null ? null : (ovShown.tq ?? pw.tq) + (pw.tq - (ovShown.tq ?? pw.tq)) * k;
    drawSportGauge($('ovHp'), ovShown.hp, power.maxHp, power.peakHp || null, 'POWER', 'HP', acc);
    drawSportGauge($('ovTq'), ovShown.tq, power.maxTq, power.peakTq || null, 'TORQUE', 'LB-FT', acc);
    setText('ovGear', derived.gear); setText('ovMph', mph == null ? '--' : String(Math.round(mph))); setText('ovRpm', rpm == null ? '--' : Math.round(rpm).toLocaleString('en-US'));
    const rf = Math.min(1, (rpm || 0) / SIGNALS.rpm.hi); $('ovBar').style.transform = `scaleX(${rf.toFixed(4)})`; $('ovBar').classList.toggle('hot', (rpm || 0) >= 6800);
    drawShift($('ovShiftCv'), trace, now, acc);
    setText('ovRm', rm ? `${rm.from}→${rm.to} ${rm.verdict} ${rm.score}` : `${derived.shifts.length} SHIFTS · REV MATCH --`);
    const D = perf.dyno, live = D.cur ? Object.keys(D.cur.pts).map(Number).sort((a, b) => a - b).map((r) => ({ rpm: r, ...D.cur.pts[r] })) : null;
    drawDyno($('ovDynoCv'), D.runs, live, acc);
    setText('ovPk', D.peakHp ? `${Math.round(D.peakHp.hp)} WHP @ ${D.peakHp.rpm} · ${Math.round(D.peakTq.tq)} LB-FT` : D.cur ? `PULL IN ${D.cur.gear} · RECORDING` : 'FULL THROTTLE IN ONE GEAR TO RECORD');
  } else if (screen === 'power') {
    // each gauge glides like the rest of the dash (~120 ms) and holds its own peak
    const k = 1 - Math.exp(-dt / 120);
    gaugeSlots.forEach((s, i) => {
      if (i >= pref.gaugeCount) return;
      const def = GAUGE_DEFS[pref.gauges[i]], v = def.get(pw);
      gaugeShown[i] = v == null ? null : (gaugeShown[i] ?? v) + (v - (gaugeShown[i] ?? v)) * k;
      if (v != null && (gaugePeaks[i] == null || v > gaugePeaks[i])) gaugePeaks[i] = v;
      drawSportGauge(s.cv, gaugeShown[i], def.max(), gaugePeaks[i], def.label, def.unit, ACCENTS[pref.accent], { min: def.min, dec: def.dec, step: def.step });
      setText_(s.name, def.label + ' ▸');
    });
    setText('powerSrc', pw.src ? (pw.src === 'ECU' ? 'ECU TORQUE (PID 62)' : pw.src) : 'NO DATA'); setChip($('powerSrc'), pw.src === 'ECU' ? 'on' : pw.src ? 'warn' : '');
    setText('powerPeaks', power.peakHp ? `PEAK ${Math.round(power.peakHp)} HP · ${Math.round(power.peakTq)} LB-FT · TAP A GAUGE TO CHANGE IT` : 'TAP A GAUGE TO CHANGE IT');
    setText('powersub', pw.src === 'ECU' ? 'FROM THE ECU · AT THE CRANK' : pw.src ? 'ESTIMATED · AT THE CRANK' : 'WAITING FOR RPM');
  } else if (screen === 'body') {
    BODY.forEach((x) => { const v = x.get(); setText_(x.b, v == null ? '--' : x.text(v)); x.t.classList.toggle('alert', v != null && !!x.alert(v)); });
    TIRES.forEach((x) => { const v = store.get(x.k); setText_(x.b, v == null ? '--' : v.toFixed(1)); x.t.classList.toggle('alert', v != null && (v < 28 || v > 42)); });
    setText('tpmsNote', TIRES.some(({ k }) => store.get(k) != null) ? '' : 'TIRE PRESSURE NEEDS NISSAN TPMS DATA VIA CAN BUS.');
    const nodes = Object.entries(canSrc.nodeRates).sort((a, b) => b[1] - a[1]);
    const health = [['MESSAGES / S', Math.round(canSrc.msgRate).toLocaleString('en-US')], ['IDS SEEN', String(Object.keys(canSrc.rates).length)],
      ['CRC / BUS ERRORS', `${canSrc.transport?.stats.bad || 0} / ${canSrc.transport?.stats.errors || 0}`], ...nodes.slice(0, 6).map(([n, r]) => [n, Math.round(r) + ' /S'])];
    const html = health.map(([l, v]) => `<div class="mon"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('');
    if ($('bushealth').innerHTML !== html) $('bushealth').innerHTML = html;
    setText('bodysub', canLive ? `${store.source === 'sim' ? 'SIMULATED BUS' : 'CANSUB'} · DBC ${dbcName}` : 'NEEDS CAN (SETTINGS > CAN BUS)');
  } else if (screen === 'diff') {
    const ws = { fl: g('ws_fl'), fr: g('ws_fr'), rl: g('ws_rl'), rr: g('ws_rr') };
    drawWheels($('wheelcv'), ws, g('steer'), ACCENTS[pref.accent]);
    const has = ws.rl != null && ws.fl != null, m = store.get('speed') ?? 0;
    setText('d-slip', has ? wheelSlip.toFixed(1) : '--');
    setText('d-lr', has ? ((ws.rr - ws.rl)).toFixed(1) : '--');
    setText('d-state', !has ? '--' : m < 0.5 ? 'STOPPED' : wheelSlip > 4 ? 'REAR SPIN' : wheelSlip < -4 ? 'LOCKING' : Math.abs(ws.rr - ws.rl) > 1.5 ? (ws.rr > ws.rl ? 'RIGHT BIAS' : 'LEFT BIAS') : 'GRIP');
    setText('d-steer', g('steer') == null ? '--' : Math.round(g('steer')).toString());
    setText('diffsub', has ? 'FROM THE ABS WHEEL SENSORS' : 'NEEDS CAN (SETTINGS > CAN BUS)');
  } else if (screen === 'clutch') {
    const eng = g('rpm'), inp = inputRpm(), pedal = clutchIn();
    const slip = eng && inp != null && eng > 500 ? (eng - inp) / eng * 100 : null;
    clutchStats.engAng += (eng || 0) / 60 * 2 * Math.PI * dt / 1000 * 0.02;    // shown at 1/50 speed so the motion reads
    clutchStats.inAng += (inp || 0) / 60 * 2 * Math.PI * dt / 1000 * 0.02;
    drawDisc($('disccv'), clutchStats.engAng, clutchStats.inAng, slip, pedal, ACCENTS[pref.accent]);
    setText('c-pedal', pedal == null ? '--' : pedal ? 'IN' : 'OUT'); setText('c-slip', slip == null || pedal ? '--' : slip.toFixed(1));
    setText('c-eng', eng == null ? '--' : Math.round(eng).toLocaleString('en-US')); setText('c-in', inp == null ? '--' : Math.round(inp).toLocaleString('en-US'));
    setText('c-launch', clutchStats.launchSlip == null ? '--' : clutchStats.launchSlip.toFixed(2)); setText('c-count', String(clutchStats.count));
    setText('clutchsub', store.get('clutch') != null ? 'PEDAL FROM CAN · SLIP FROM ENGINE VS WHEELS' : 'PEDAL INFERRED · SLIP FROM ENGINE VS WHEELS');
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
    const lines = store.busLog.filter(([, , source]) => (source === 'sim') === simulated).slice(-26);
    setText('bussub', `${lines.length} RECENT LINES`);
    const notes = [simulated ? 'SIMULATED TRAFFIC' : `OBD · ${obdStatus}`, bleError, store.adapter?.fast ? 'FAST MODE: ' + store.adapter.fast : ''];
    setText('busfast', notes.filter(Boolean).join(' · '));
    if (canLive && (simulated || !lines.length)) {
      const ids = [...canSrc.last.keys()].sort((a, b) => a - b).slice(0, 26);
      setText('bussub', `CAN · ${Math.round(canSrc.msgRate).toLocaleString('en-US')} MSG/S · ${ids.length} IDS`);
      $('buslog').innerHTML = ids.map((id) => { const m = canSrc.db.byId.get(id), d = canSrc.last.get(id);
        return `<div class="l"><span>0x${id.toString(16).toUpperCase().padStart(3, '0')} ${String(Math.round(canSrc.rates[id] || 0)).padStart(3)}/s</span>  ${[...d].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')}  <span>${m ? esc(m.name) : ''}</span></div>`; }).join('');
    } else $('buslog').innerHTML = lines.map(([t, l]) => `<div class="l"><span>${(t / 1000 % 1000).toFixed(3).padStart(7)}</span>  ${esc(l)}</div>`).join('');
  } else if (screen === 'settings') {
    B.src.set(simulated ? 'SIMULATOR' : store.source === 'ble' ? 'ADAPTER' : 'START SIM', false);
    B.pause.set(store.paused ? 'PAUSED · SILENT' : 'OFF', store.paused);
    B.log.set(rec.on ? (native ? 'RECORDING' : `RECORDING · ${rec.rows.length}`) : 'STOPPED', rec.on);
    B.sensors.set(imu || gps ? `${imu ? 'MOTION' : ''}${imu && gps ? ' + ' : ''}${gps ? 'GPS' : ''}` : 'TAP TO ENABLE', false);
    B.accent.set(pref.accent, false); B.night.set(pref.night.toUpperCase(), false);
    B.link.b.hidden = !ONSITE && !IN_APP;
    B.link.set(IN_APP ? (relayState === 'live' ? 'LIVE · TAP TO MANAGE' : 'PAIR WITH WEBSITE (CODE)') : RELAY_KEY ? 'CONNECTED · NEW CODE' : 'CONNECT CAR (CODE)', IN_APP && relayState === 'live');
    const fi = derived.fitInfo;
    B.trans.set(derived.transPref === 'auto' ? `AUTO · ${fi ? derived.trans : 'LEARNING'}` : derived.transPref, false);
    const T = perf.tripStats; B.trip.set(`RESET (${T.miles.toFixed(1)} MI)`, false);
    const vals = [T.miles.toFixed(1), hms(T.moving), hms(T.idle), T.avg == null ? '--' : T.avg.toFixed(0), T.top.toFixed(0), T.gallons == null ? '--' : T.gallons.toFixed(2), T.mpg == null ? '--' : T.mpg.toFixed(1), fmt('boost', derived.peaks.boost)];
    TRIP.forEach((b, i) => setText_(b, String(vals[i])));
    setText('dbcName', 'DBC: ' + dbcName);
    if (!$('canNote').textContent) setText('canNote', 'LISTEN-ONLY. A CANSUB ON THE SAME NETWORK STREAMS THE RAW BUS; THE DBC TURNS IT INTO SIGNALS. THE STARTER DBC IS A TEMPLATE: CONFIRM EACH SIGNAL WITH THE CANSUB-REVERSE-ENGINEERING SKILL.');
    const ad = store.adapter;
    B.adapter.set(ad?.name ? ad.name.toUpperCase() : 'CHOOSE…', false);
    const readings = OBD_CHECK_KEYS.filter((k) => store.get(k, 'ble') != null).map((k) => SIGNALS[k].label.toUpperCase());
    const note = [
      simulated ? 'SIMULATOR ACTIVE' : `OBD STATUS · ${esc(obdStatus)}`,
      bleError ? 'LAST ERROR: ' + esc(bleError) : '',
      store.source === 'ble' ? 'OBD CHANNELS RECEIVED: ' + (readings.join(', ') || 'WAITING FOR ECU') : '',
      'DATA SOURCE TOGGLES BETWEEN THE SIMULATOR AND YOUR BLUETOOTH OBD ADAPTER. OBD ADAPTER PICKS A DIFFERENT ONE.',
      ad ? `ADAPTER: ${esc(ad.name || '?')} · ${esc(ad.elm || 'NO ELM327 REPLY')}` : '',
      WEBSITE ? 'LIVE CAR DATA IN ANY BROWSER: OPEN THE CARBOX APP, CONNECT THE ADAPTER AND TURN ON LIVE RELAY (SETTINGS), THEN OPEN THIS SITE ONCE WITH ?LIVE=YOURKEY. IPHONE BROWSERS CANNOT USE BLUETOOTH, SO THE APP UPLOADS THE DATA.' : '',
      BRIDGE ? (RELAY_KEY ? 'LIVE VIA THE CARBOX RELAY: THE APP ON THE PHONE READS THE CAR AND UPLOADS IT.' : 'CONNECTED THROUGH THE CARBOX APP ON THIS IPHONE (LOCALHOST:8787).') : '',
      'PAUSE OBD STOPS ALL TRANSMISSION: TURN IT ON BEFORE FLASHING WITH ECUTEK.',
      'LAUNCH TIMES, DYNO NUMBERS AND DRIFT ANGLE ARE ESTIMATES FROM OBD SPEED AND THE PHONE’S SENSORS. CLOSED COURSE ONLY.',
    ].filter(Boolean).join('<br>');
    if ($('sysnote').innerHTML !== note) $('sysnote').innerHTML = note;
  }
  if (rec.on && !native) rec.rows.push([((now - rec.t0) / 1000).toFixed(3), ...Object.keys(SIGNALS).map((k) => snap[k] == null ? '' : snap[k].toFixed(3)),
    imu ? imu.lat.toFixed(3) : '', imu ? imu.lon.toFixed(3) : '', imu ? imu.yaw.toFixed(1) : '', gps ? gps.lat.toFixed(6) : '', gps ? gps.lon.toFixed(6) : '']);
}
function setText_(n, t) { if (n.textContent !== t) n.textContent = t; }
let wheelSlip = 0;
function avg2(a, b) { const x = store.get(a), y = store.get(b); return x == null || y == null ? null : (x + y) / 2; }
// Clutch pedal: from CAN when the DBC has it, else inferred (moving with revs that fit no gear).
function clutchIn() { const c = store.get('clutch'); if (c != null) return !!c; const m = store.get('speed'); return m == null ? null : derived.gear === 'N' && m > 2; }
// Gearbox input shaft speed from the driven (rear) wheels and the last gear the car was in.
function inputRpm() {
  const v = avg2('ws_rl', 'ws_rr') ?? store.get('speed'), g = +(derived._real || 0);
  return v == null || !g ? null : derived.rpmFor(v, g);
}

// ---- go
applyTheme(); setScreen(VIEW ? 'overview' : 'home'); store.status = native ? 'WAITING' : 'SELECT ADAPTER';
// The public website (carbox.nich.world) has no car: start the simulator so it shows something live.
if (WEBSITE) setSource('sim');
// Website, not connected yet: ask the relay for a pairing code and show it. When the app claims the code,
// the relay hands this browser the same key, it's remembered here, and the page reloads straight into live view.
// (A plain static host has no /pair endpoint: then this quietly stays the demo.)
// Works on the website whether or not it's already paired: a new code replaces the old link once the app
// enters it (until then the old link keeps working).
const ONSITE = !IN_APP && !LOCAL;
let pairGen = 0;
async function startPairing() {
  if (!ONSITE) return;
  const gen = ++pairGen;
  $('pairScreen').hidden = false; setText('pairCode', '--- ---'); setText('pairNote', 'GETTING A CODE…');
  $('pairKeep').hidden = !RELAY_KEY; setText('pairDemo', RELAY_KEY ? 'FORGET THIS CAR' : 'USE THE DEMO');
  let p;
  try { const r = await fetch('/pair/new', { method: 'POST' }); if (!r.ok) throw new Error(r.status); p = await r.json(); }
  catch { if (gen === pairGen) setText('pairNote', 'THE SERVER IS WAKING UP OR UNREACHABLE · TRYING AGAIN…'); setTimeout(() => { if (gen === pairGen && !$('pairScreen').hidden) startPairing(); }, 4000); return; }
  if (gen !== pairGen) return;
  setText('pairCode', p.code.slice(0, 3) + ' ' + p.code.slice(3)); setText('pairNote', 'WAITING FOR THE APP…');
  const until = performance.now() + p.expiresIn * 1000;
  const tick = async () => {
    if ($('pairScreen').hidden || gen !== pairGen) return;   // closed, or a newer code took over
    if (performance.now() > until) { startPairing(); return; }   // expired: a fresh code
    try {
      const w = await (await fetch('/pair/wait?poll=' + encodeURIComponent(p.poll))).json();
      if (w.paired && w.key) { setText('pairNote', 'PAIRED · CONNECTING…'); try { localStorage.setItem('carbox-live', w.key); } catch { /* private mode */ } location.reload(); return; }
      if (w.error) { startPairing(); return; }
      setText('pairNote', `WAITING FOR THE APP · CODE GOOD FOR ${Math.floor(w.expiresIn / 60)}:${String(w.expiresIn % 60).padStart(2, '0')}`);
    } catch { setText('pairNote', 'CHECKING THE CONNECTION…'); }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}
$('pairDemo').onclick = () => {
  pairGen++; $('pairScreen').hidden = true;
  if (RELAY_KEY) { try { localStorage.removeItem('carbox-live'); } catch { /* private mode */ } location.href = location.pathname + '?demo'; }   // forget this car
};
$('pairKeep').onclick = () => { pairGen++; $('pairScreen').hidden = true; };
$('offPair').onclick = () => startPairing();
if (WEBSITE && !RELAY_KEY && !new URLSearchParams(location.search).has('demo')) startPairing();
// Draw on the display's own refresh (60/120 Hz). requestAnimationFrame pauses in a background tab,
// so a slow timer keeps data, timers and the drive log going there.
let lastRaf = 0;
// Lite (CarPlay mirroring): 30 fps is all the mirrored stream shows, so don't spend the phone's power on 60/120.
let skip = false;
(function loop() { lastRaf = performance.now(); if (!LITE || (skip = !skip)) frame(); requestAnimationFrame(loop); })();
setInterval(() => { if (performance.now() - lastRaf > 200) frame(); }, 100);
setInterval(applyTheme, 60000);
setInterval(() => { if (derived.fitInfo) save(); }, 30000);   // keep what the gear detector learned
post({ cmd: 'trans', value: derived.transPref });
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
// Boot: list the modules heard on the CAN bus with their message rates (like a bus scan), then fade.
const bootT = setInterval(() => {
  const nodes = Object.entries(canSrc.nodeRates).filter(([n]) => n !== 'OTHER').sort((a, b) => b[1] - a[1]);
  $('bootNodes').innerHTML = nodes.map(([n, r]) => `<span><b>${esc(n)}</b>${Math.round(r)}/S</span>`).join('');
  if (nodes.length) setText('bootSub', `CAN BUS · ${nodes.length} MODULES · ${Math.round(canSrc.msgRate)} MSG/S`);
}, 250);
setTimeout(() => { $('boot').classList.add('done'); clearInterval(bootT); }, 2800);
window.carbox = { store, derived, wire, sensors, perf, drives, setScreen, setSource, pref, runDiag, canSrc }; // handy for debugging in the console
