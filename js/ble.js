// Bluetooth LE transport for ELM327-style OBD adapters: Vgate, OBDLink CX, Veepeak, Konnwei, generic
// clones, and FIXD (original and 2nd-generation sensors are BLE; FIXD's channel layout isn't published).
// Uses Web Bluetooth: Chrome on Android and desktop. iOS Safari has no Web Bluetooth; the iPhone app
// does Bluetooth natively in Swift (ios/App/OBD.swift) with the same channel-picking rules.
// UNTESTED against real hardware.

// Web Bluetooth only exposes services listed up front, so list every serial-over-BLE layout we know.
// Short IDs must be numbers, not strings.
export const SERVICES = [
  0xfff0, 0xffe0, 0xffe5, 0x18f0, 0xae00, 0xae30, 0xfee7, 0xffb0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',     // Vgate / Konnwei
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',     // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',     // Microchip transparent UART
  '0000fefb-0000-1000-8000-00805f9b34fb',     // Stollmann / Telit
];

// Standard services that are never the data channel (device info, battery, generic access, OTA).
const NOT_DATA = new Set(['1800', '1801', '180a', '180f', '1805', 'fe59', 'fd6f']);
const short = (uuid) => { const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid); return (m ? m[1] : uuid).toLowerCase(); };

/** Picks the data channel from a GATT layout.
 *  services: [{ uuid, chars: [{ uuid, read, write, writeNoResp, notify, indicate }] }]
 *  Returns { service, tx, rx } (uuids) or null. Prefers one service that has both a notify and a
 *  write characteristic, known OBD services first, and skips standard services. */
export function chooseChannel(services) {
  const known = SERVICES.map((s) => (typeof s === 'number' ? s.toString(16).padStart(4, '0') : short(s)));
  let best = null;
  for (const s of services) {
    const id = short(s.uuid);
    if (NOT_DATA.has(id)) continue;
    const rx = s.chars.find((c) => c.notify || c.indicate);
    const tx = s.chars.find((c) => c.writeNoResp && c.uuid !== rx?.uuid) || s.chars.find((c) => c.write || c.writeNoResp);
    if (!rx || !tx) continue;
    const score = (known.includes(id) ? 10 : 0) + (rx.uuid !== tx.uuid ? 2 : 1) + (tx.writeNoResp ? 1 : 0);
    if (!best || score > best.score) best = { score, service: s.uuid, tx: tx.uuid, rx: rx.uuid };
  }
  if (best) return { service: best.service, tx: best.tx, rx: best.rx };
  // Some adapters split it: notify in one service, write in another. Pair them across services.
  const usable = services.filter((s) => !NOT_DATA.has(short(s.uuid)));
  const rxS = usable.find((s) => s.chars.some((c) => c.notify || c.indicate));
  const txS = usable.find((s) => s !== rxS && s.chars.some((c) => c.write || c.writeNoResp));
  if (rxS && txS) {
    return { service: rxS.uuid, rx: rxS.chars.find((c) => c.notify || c.indicate).uuid,
      txService: txS.uuid, tx: txS.chars.find((c) => c.writeNoResp || c.write).uuid };
  }
  return null;
}

export class WebBleTransport {
  constructor() { this.cb = () => {}; this.dev = null; this.tx = null; this.info = {}; }
  onData(cb) { this.cb = cb; }
  async open() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser');
    // The browser's own chooser lists every nearby device, so any adapter name works (FIXD included).
    this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    const server = await this.dev.gatt.connect();
    const layout = [], byUuid = {};
    for (const s of await server.getPrimaryServices()) {
      const chars = [];
      for (const c of await s.getCharacteristics().catch(() => [])) {
        const p = c.properties;
        chars.push({ uuid: c.uuid, read: p.read, write: p.write, writeNoResp: p.writeWithoutResponse, notify: p.notify, indicate: p.indicate });
        byUuid[s.uuid + '|' + c.uuid] = c;
      }
      layout.push({ uuid: s.uuid, chars });
    }
    const ch = chooseChannel(layout);
    this.info = { name: this.dev.name || '(no name)', services: layout.map((s) => short(s.uuid)), channel: ch && { service: short(ch.service), tx: short(ch.tx), rx: short(ch.rx) } };
    if (!ch) throw new Error(`${this.info.name}: no serial data channel found (services: ${this.info.services.join(', ') || 'none visible'})`);
    const rx = byUuid[ch.service + '|' + ch.rx];
    this.tx = byUuid[(ch.txService || ch.service) + '|' + ch.tx];
    await rx.startNotifications();
    rx.addEventListener('characteristicvaluechanged', (e) => this.cb(new TextDecoder().decode(e.target.value)));
  }
  async write(s) {
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < bytes.length; i += 20) {   // BLE packets are small
      const chunk = bytes.slice(i, i + 20);
      if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
  }
  close() { if (this.dev?.gatt?.connected) this.dev.gatt.disconnect(); }
}
