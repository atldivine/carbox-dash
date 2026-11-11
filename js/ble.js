// Bluetooth LE transport for ELM327 adapters (Vgate iCar Pro BLE, OBDLink CX, Veepeak BLE+, etc.).
// Uses Web Bluetooth: works in Chrome on Android and desktop. iOS Safari has no Web Bluetooth, so the
// iPhone build (Capacitor) must swap this for a native BLE plugin with the same four methods.
// UNTESTED against real hardware.
const SERVICES = ['0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '18f0',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e']; // Nordic UART, used by some branded sensors (FIXD's UUID is unconfirmed)

export class WebBleTransport {
  constructor() { this.cb = () => {}; this.dev = null; this.tx = null; }
  onData(cb) { this.cb = cb; }
  async open() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser');
    this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    const server = await this.dev.gatt.connect();
    for (const s of await server.getPrimaryServices()) {
      for (const c of await s.getCharacteristics()) {
        if (c.properties.notify || c.properties.indicate) {
          await c.startNotifications();
          c.addEventListener('characteristicvaluechanged', (e) => this.cb(new TextDecoder().decode(e.target.value)));
        }
        if ((c.properties.write || c.properties.writeWithoutResponse) && !this.tx) this.tx = c;
      }
    }
    if (!this.tx) throw new Error('No writable characteristic found on ' + (this.dev.name || 'adapter'));
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
