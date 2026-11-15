import { DriftView } from './drift-view.js';
import { drawRoute } from './drives.js';
import { SIGNALS, fmt } from './store.js';
import { drawGMeter, drawImuTrace } from './charts.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const number = (v, digits = 1) => Number.isFinite(v) ? v.toFixed(digits) : '--';
const definitions = [
  ['drift', 'DRIFT', 'Estimated from phone motion and vehicle speed. Closed course.', [
    ['speed','SPEED'], ['rpm','RPM'], ['throttle','THROTTLE'], ['score','SCORE'], ['combo','COMBO'], ['mult','MULTIPLIER'], ['angle','ESTIMATED SLIP ANGLE'], ['yaw','YAW RATE'], ['driftState','STATE']]],
  ['throttle', 'THROTTLE', 'Standard OBD readings. Pedal and throttle sensors use separate scales.', [
    ['pedal','PEDAL D'], ['pedal_e','PEDAL E'], ['pedal_f','PEDAL F'], ['throttle','ABSOLUTE THROTTLE'], ['relative_throttle','RELATIVE THROTTLE'], ['commanded_throttle','COMMANDED THROTTLE']]],
  ['vdc', 'VDC', 'Requires verified Nissan CAN signals for stability control, traction and ABS.', [
    ['vdc_off','VDC OFF'], ['tcs','TRACTION ACTIVE'], ['abs','ABS ACTIVE'], ['steer','STEERING'], ['brake','BRAKE'], ['clutch','CLUTCH SWITCH']]],
  ['imu', 'IMU', 'Phone motion and GPS. Calibrate with the phone mounted and the car stationary.', [
    ['lateral','LATERAL G'], ['longitudinal','LONGITUDINAL G'], ['yaw','YAW °/S'], ['pitch','PITCH °'], ['roll','ROLL °'], ['accuracy','GPS ACCURACY M']]],
];

export class FeaturePages {
  constructor(context) {
    Object.assign(this, context);
    try { this.preferences = JSON.parse(localStorage.getItem('carbox-pages') || '{}') || {}; } catch { this.preferences = {}; }
    this.lastUpdate = 0;
    this.throttlePoints = [];
    this.lastThrottleSample = 0;
    for (const [id, title, note, fields] of definitions) {
      const section = document.createElement('section');
      section.id = 's-' + id;
      section.className = 'screen feature-page';
      section.innerHTML = '<h2>' + title + '</h2><p class="note">' + note + '</p><div class="feature-grid">' +
        fields.map(([key,label]) => '<div class="panel stat"><label>' + label + '</label><b id="feature-' + id + '-' + key + '">--</b></div>').join('') +
        '</div><p class="dim" id="feature-state-' + id + '"></p>';
      if (id === 'imu' || id === 'drift') section.innerHTML += '<canvas class="feature-chart" id="feature-chart-' + id + '"></canvas>';
      if (id === 'throttle') section.innerHTML += '<canvas class="feature-chart" id="feature-throttle-curve" aria-label="Measured pedal D versus absolute throttle"></canvas>';
      if (id === 'imu') section.innerHTML += '<button class="chip" id="feature-calibrate">CALIBRATE</button>';
      $('s-settings').before(section);
    }
    const scene = document.createElement('div');
    scene.className = 'drift-scene panel';
    scene.innerHTML = '<canvas id="drift-car" aria-label="Z orientation from estimated slip angle"></canvas><span id="drift-live-note"></span>';
    $('s-drift').querySelector('.feature-grid').before(scene);
    this.driftView = new DriftView($('drift-car'));
    const map = document.createElement('section');
    map.id = 's-map'; map.className = 'screen feature-page';
    map.innerHTML = '<h2>MAP</h2><p class="note">Live GPS and current drive. Street maps use Apple Maps in the iPhone app and require network access.</p><button class="chip" id="open-live-map">OPEN LIVE STREET MAP</button><p id="map-status" class="dim"></p><canvas id="map-route" class="feature-chart" aria-label="Current drive trace"></canvas>';
    $('s-settings').before(map);
    $('open-live-map').onclick = () => this.openMap(false);
    const mapButton = document.createElement('button');
    mapButton.className = 'chip'; mapButton.textContent = 'MAP';
    mapButton.onclick = () => this.openMap(false); scene.append(mapButton);
    const routeButton = document.createElement('button');
    routeButton.className = 'chip'; routeButton.id = 'open-drive-map'; routeButton.textContent = 'STREET MAP';
    routeButton.onclick = () => this.openMap(true); $('s-drives').append(routeButton);
    $('feature-calibrate').onclick = () => {
      $('feature-state-imu').textContent = this.sensors.calibrate() ? 'Calibration saved' : 'Waiting for motion sensor';
    };
    const systems = document.createElement('section');
    systems.id = 's-systems'; systems.className = 'screen feature-page';
    systems.innerHTML = '<h2>SYSTEMS</h2><p class="note">Fresh readings and their sources. Unavailable values remain blank.</p><div id="feature-systems" class="feature-grid"></div>';
    $('s-settings').before(systems);
    for (const [key, signal] of Object.entries(SIGNALS)) {
      const tile = document.createElement('div');
      tile.className = 'panel stat';
      tile.innerHTML = '<label>' + escape(signal.label.replaceAll('_',' ')) + '</label><b id="system-value-' + key + '">--</b><small id="system-source-' + key + '"></small>';
      $('feature-systems').append(tile);
    }
    const exports = document.createElement('div');
    exports.className = 'feature-export';
    exports.innerHTML = '<button class="chip" id="export-drive-csv">EXPORT CSV</button><button class="chip" id="export-drive-json">EXPORT JSON</button><span class="dim" id="export-status"></span>';
    $('s-drives').append(exports);
    $('export-drive-csv').onclick = () => this.exportDrive('csv');
    $('export-drive-json').onclick = () => this.exportDrive('json');
    window.addEventListener('carbox-export', e => {
      $('export-status').textContent = e.detail ? 'Saved in Files → On My iPhone → Carbox Dash' : 'Export failed. Check available storage.';
    });
    this.applyAppearance();
  }

  persist() { try { localStorage.setItem('carbox-pages', JSON.stringify(this.preferences)); } catch {} }

  configureTabs() {
    const panel = document.createElement('div');
    panel.className = 'panel feature-settings';
    panel.innerHTML = '<label>DISPLAY</label><div class="feature-options"><label>Theme <select id="feature-theme"><option value="original">Original</option><option value="clean">Clean</option><option value="amber">Amber</option></select></label><label>Font <select id="feature-font"><option value="default">Default</option><option value="mono">Mono</option><option value="system">System</option></select></label><label>Accent <input id="feature-color" type="color"></label></div><label>PAGES · ORDER AND VISIBILITY</label><div id="feature-page-order"></div>';
    $('s-settings').append(panel);
    $('feature-theme').value = this.preferences.theme || 'original';
    $('feature-font').value = this.preferences.font || 'default';
    $('feature-color').value = this.preferences.color || '#ff263e';
    for (const key of ['theme','font','color']) $('feature-' + key).onchange = e => {
      this.preferences[key] = e.target.value; this.persist(); this.applyAppearance();
    };
    this.renderTabSettings();
  }

  renderTabSettings() {
    const ids = this.tabs.map(([id]) => id);
    const saved = Array.isArray(this.preferences.order) ? this.preferences.order : [];
    const order = [...new Set([...saved.filter(id => ids.includes(id)), ...ids])];
    const hidden = Array.isArray(this.preferences.hidden) ? this.preferences.hidden : [];
    $('feature-page-order').replaceChildren();
    order.forEach((id, index) => {
      const button = document.querySelector('#tabs button[data-t="' + id + '"]');
      button.hidden = id !== 'settings' && hidden.includes(id);
      $('tabs').append(button);
      const row = document.createElement('div');
      row.className = 'feature-order-row';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = !button.hidden; check.disabled = id === 'settings';
      check.setAttribute('aria-label', 'Show ' + id);
      check.onchange = () => {
        this.preferences.hidden = check.checked ? hidden.filter(x => x !== id) : [...hidden, id];
        this.persist(); this.renderTabSettings();
      };
      const title = document.createElement('span'); title.textContent = id.toUpperCase();
      const up = document.createElement('button'); up.textContent = '↑'; up.disabled = index === 0; up.setAttribute('aria-label', 'Move ' + id + ' earlier');
      up.onclick = () => {
        [order[index-1],order[index]] = [order[index],order[index-1]];
        this.preferences.order = order; this.persist(); this.renderTabSettings();
      };
      row.append(check, title, up); $('feature-page-order').append(row);
    });
  }

  applyAppearance() {
    document.documentElement.dataset.theme = this.preferences.theme || 'original';
    document.documentElement.dataset.font = this.preferences.font || 'default';
    if (/^#[0-9a-f]{6}$/i.test(this.preferences.color || '')) document.documentElement.style.setProperty('--feature-accent', this.preferences.color);
  }

  openMap(recorded) {
    const drive = recorded ? this.selectedDrive?.() : this.drives.cur;
    const points = (drive?.pts || []).filter(p => Number.isFinite(p[1]) && Number.isFinite(p[2]) && Math.abs(p[1]) <= 90 && Math.abs(p[2]) <= 180).map(p => [p[1], p[2]]);
    if (recorded && !points.length) { $('export-status').textContent = 'Select a drive with GPS positions first'; return; }
    if (!this.native) { $('map-status').textContent = 'Street map is available in the iPhone app. This browser shows the local route trace.'; return; }
    this.post({cmd: 'map', live: !recorded, points});
  }

  update(screen, now) {
    if (screen === 'drift') {
      this.driftView.update(this.sensors, this.store, now);
      $('drift-live-note').textContent = this.store.source === 'sim' ? 'SIMULATED · ESTIMATED SLIP' : this.driftView.canvas.dataset.live === 'true' ? 'LIVE MOTION · ESTIMATED SLIP' : 'WAITING FOR MOTION + SPEED';
    } else this.driftView.pause();
    if (screen === 'map' && now - this.lastUpdate >= 100) {
      const gps = this.sensors.gpsLive ? this.sensors.gps : null;
      $('map-status').textContent = gps ? 'GPS ±' + Math.round(gps.acc) + ' m · ' + number(gps.mph) + ' mph' : 'Waiting for GPS. Enable location access in iPhone Settings.';
      drawRoute($('map-route'), this.drives.cur, 1, '#46c8ff');
    }
    if (now - this.lastUpdate < 100) return;
    this.lastUpdate = now;
    const imu = this.sensors.motionLive ? this.sensors.imu : null;
    const get = key => this.store.get(key);
    const drift = this.perf.drift;
    const pedal = get('pedal'), throttle = get('throttle');
    if (pedal != null && throttle != null && now - this.lastThrottleSample >= 250) {
      this.throttlePoints.push([pedal, throttle]);
      if (this.throttlePoints.length > 500) this.throttlePoints.shift();
      this.lastThrottleSample = now;
    }
    const values = {
      score: Math.round(drift.score), combo: Math.round(drift.combo), mult: '×' + drift.mult,
      angle: imu ? number(this.sensors.beta) + '°' : '--',
      driftState: imu ? (drift.active ? 'SLIDING' : 'WAITING') : 'NO MOTION',
      lateral: number(imu?.lat, 2), longitudinal: number(imu?.lon, 2), yaw: number(imu?.yaw),
      pitch: imu ? number(this.sensors.level?.pitch) : '--', roll: imu ? number(this.sensors.level?.roll) : '--',
      accuracy: this.sensors.gpsLive ? number(this.sensors.gps.acc) : '--',
    };
    const definition = definitions.find(([id]) => id === screen);
    if (definition) {
      for (const [key] of definition[3]) {
        let value = values[key];
        if (value == null) {
          const sample = get(key);
          value = sample == null ? '--' : fmt(key, sample) + ' ' + SIGNALS[key].unit;
        }
        $('feature-' + screen + '-' + key).textContent = value;
      }
      if (screen === 'drift') drawGMeter($('feature-chart-drift'), imu, this.sensors.trace, this.sensors.peakG, '#ff263e');
      if (screen === 'imu') drawImuTrace($('feature-chart-imu'), this.sensors.trace, this.sensors.level, '#46c8ff');
      if (screen === 'throttle') {
        $('feature-state-throttle').textContent = get('pedal') == null ? 'Waiting for standard pedal PID 0149. Availability depends on the ECU.' : 'Observed pedal versus throttle positions. Sequential OBD samples can have timing offsets.';
        this.drawThrottle();
      }
    }
    if (screen === 'systems') for (const [key, signal] of Object.entries(SIGNALS)) {
      $('system-value-' + key).textContent = fmt(key, get(key)) + (get(key) == null ? '' : ' ' + signal.unit);
      const sources = ['ble','can','sim'].filter(source => this.store.get(key, source) != null);
      $('system-source-' + key).textContent = sources.join(' + ').toUpperCase() || 'NO LIVE INPUT';
    }
  }

  drawThrottle() {
    const canvas = $('feature-throttle-curve');
    const bounds = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(bounds.width * 2)); canvas.height = 320;
    const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height, pad = 45;
    c.strokeStyle = '#555'; c.strokeRect(pad, 10, w - pad - 10, h - pad - 10);
    c.fillStyle = '#aaa'; c.font = '18px monospace';
    c.fillText('Throttle %', pad, 28); c.fillText('Pedal D %', Math.max(pad, w - 160), h - 12);
    c.fillStyle = '#46c8ff';
    for (const [pedal, throttle] of this.throttlePoints) {
      c.beginPath(); c.arc(pad + pedal / 100 * (w - pad - 10), h - pad - throttle / 100 * (h - pad - 10), 3, 0, Math.PI * 2); c.fill();
    }
  }

  exportDrive(format) {
    const drive = this.selectedDrive?.();
    if (!drive) { $('export-status').textContent = 'Select a recorded drive first'; return; }
    const name = 'carbox-drive-' + drive.id + '.' + format;
    const text = format === 'json' ? JSON.stringify({schema: 1, columns: ['unix_ms','latitude','longitude','mph','rpm','boost_psi','gear','g'], drive}, null, 2)
      : ['unix_ms,latitude,longitude,mph,rpm,boost_psi,gear,g', ...drive.pts.map(row => row.map(value => value == null ? '' : '"' + String(value).replaceAll('"','""') + '"').join(','))].join('\n');
    if (this.native) {
      this.post({cmd:'export', name, text});
      $('export-status').textContent = 'Saving…';
    } else {
      const url = URL.createObjectURL(new Blob([text], {type: format === 'json' ? 'application/json' : 'text/csv'}));
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('export-status').textContent = 'Export downloaded';
    }
  }
}
