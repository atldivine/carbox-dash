// Simulated CAN bus for the SIM source: turns the fake drive (and simulated motion) into raw frames
// with the same DBC the real bus would use, and feeds them through the real decoder. So everything
// downstream (BODY, DIFF, CLUTCH, chips, boot screen) is exercised exactly as with a CANsub.
import { encodeMessage } from './dbc.js';

export class CanSim {
  constructor(src) { this.src = src; this._t = 0; this.state = { locked: 0, belt: 1, lights: 2, ignition: 2, turn: 0, turnUntil: 0 }; }
  frame(now, store, sensors) {
    if (now - this._t < 50) return;   // 20 Hz
    this._t = now;
    const db = this.src.db, mph = store.get('speed') ?? 0, rpm = store.get('rpm') ?? 0, thr = store.get('throttle') ?? 0;
    const imu = sensors?.motionLive ? sensors.imu : null, S = this.state;
    const lat = imu?.lat ?? 0, lon = imu?.lon ?? 0;
    // turn signal now and then, before the simulated corners
    if (now > S.turnUntil && Math.random() < 0.004) { S.turn = Math.random() < 0.5 ? 1 : 2; S.turnUntil = now + 3000; }
    if (now > S.turnUntil) S.turn = 0;
    const blink = S.turn && Math.floor(now / 380) % 2 === 0;
    const slip = thr > 90 && mph < 40 ? 0.06 : 0.005;   // rear wheels spin a little on a hard launch
    const steer = Math.max(-540, Math.min(540, lat * 160 + (sensors?.beta || 0) * -3));
    const v = {
      2: { steer },
      384: { rpm, throttle: thr },
      644: { ws_fl: mph * (1 - lat * 0.02), ws_fr: mph * (1 + lat * 0.02) },
      645: { ws_rl: mph * (1 + slip) * (1 - lat * 0.02), ws_rr: mph * (1 + slip) * (1 + lat * 0.02) },
      852: { brake: lon < -0.1 ? Math.min(100, -lon * 120) : 0, vdc_off: 1, abs: lon < -0.9 ? 1 : 0, tcs: slip > 0.05 ? 1 : 0 },
      856: { turn_l: blink && S.turn === 1 ? 1 : 0, turn_r: blink && S.turn === 2 ? 1 : 0, hazard: 0, pbrake: mph < 0.5 ? 1 : 0, lights: S.lights, wiper: 0 },
      1549: { door_fl: 0, door_fr: 0, hatch: 0, locked: mph > 5 ? 1 : S.locked, belt: S.belt, ignition: S.ignition },
      1361: { coolant: store.get('coolant') ?? 190, cruise: 0, clutch: thr < 5 && mph > 2 && rpm > 1500 ? 1 : 0 },
      1477: { odo: 12480 + (store.tripMiles || 0), fuel_level: 72 },
      901: { tpms_fl: 35.25, tpms_fr: 35.5, tpms_rl: 36, tpms_rr: 35.75 },
    };
    const frames = [];
    for (const id in v) { const m = db.byId.get(+id); if (m) frames.push({ id: +id, data: encodeMessage(m, v[id]) }); }
    // a few unknown IDs, as on a real bus
    for (const id of [0x1F9, 0x215, 0x6A0]) frames.push({ id, data: Uint8Array.from({ length: 8 }, () => (Math.random() * 256) | 0) });
    this.src.ingest(frames);
  }
}
