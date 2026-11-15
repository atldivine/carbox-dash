// Diagnostics over plain OBD-II: stored / pending / permanent trouble codes (modes 03 / 07 / 0A),
// readiness monitors (PID 01) and the "since codes cleared" counters. Every function takes
// `ask(cmd) -> Promise<replyText>`, so the same code runs on the web adapter, the iPhone's native
// adapter and the simulator.

const LETTER = ['P', 'C', 'B', 'U'];
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** Two DTC bytes -> "P0301". */
export function decodeDtc(a, b) {
  return LETTER[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() + hex2(b);
}

/** Hex bytes of every answer in a reply, one array per ECU message (multi-frame messages joined). */
export function replyMessages(text) {
  const lines = String(text).toUpperCase().split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^SEARCHING|^BUS INIT/.test(l));
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^[0-9A-F]{3}$/.test(l)) { cur = []; cur.len = parseInt(l, 16); out.push(cur); continue; }   // multi-frame length line
    const m = /^([0-9A-F])\s*:(.*)$/.exec(l);
    const hex = (m ? m[2] : l).replace(/[^0-9A-F]/g, '');
    const bytes = []; for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    if (m && cur) cur.push(...bytes); else { cur = null; out.push(bytes); }
  }
  return out.map((b) => (b.len ? b.slice(0, b.len) : b)).filter((b) => b.length);
}

/** Reply to 03 / 07 / 0A -> unique codes. Handles CAN (count byte first) and older buses (pairs). */
export function parseDtcs(text, mode = 0x03) {
  if (/NODATA|UNABLE|ERROR|STOPPED/.test(String(text).replace(/\s/g, '').toUpperCase())) return [];
  const want = 0x40 + mode, codes = new Set();
  for (const msg of replyMessages(text)) {
    const at = msg.indexOf(want);
    if (at < 0) continue;
    let rest = msg.slice(at + 1);
    // CAN: the first byte is the number of codes, and the rest is exactly that many pairs.
    if (rest.length % 2 === 1 && rest[0] * 2 <= rest.length - 1) rest = rest.slice(1, 1 + rest[0] * 2);
    for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] || rest[i + 1]) codes.add(decodeDtc(rest[i], rest[i + 1]));
  }
  return [...codes];
}

/** PID 01 bytes -> { mil, count, monitors: [{ name, ready }] } (only monitors the car supports). */
export function parseMonitors(d) {
  if (!d || d.length < 4) return null;
  const [A, B, C, D] = d, out = { mil: !!(A & 0x80), count: A & 0x7F, monitors: [] };
  const add = (name, sup, inc) => { if (sup) out.monitors.push({ name, ready: !inc }); };
  add('MISFIRE', B & 1, B & 16); add('FUEL SYSTEM', B & 2, B & 32); add('COMPONENTS', B & 4, B & 64);
  const names = B & 8
    ? ['NMHC CATALYST', 'NOX / SCR', null, 'BOOST PRESSURE', null, 'EXHAUST SENSOR', 'PM FILTER', 'EGR / VVT']
    : ['CATALYST', 'HEATED CATALYST', 'EVAP SYSTEM', 'SECONDARY AIR', null, 'O2 SENSOR', 'O2 HEATER', 'EGR / VVT'];
  names.forEach((n, i) => n && add(n, C & (1 << i), D & (1 << i)));
  return out;
}

// [pid, label, decode(bytes) -> text]
const KM_MI = 0.621371;
export const COUNTERS = [
  [0x21, 'DISTANCE WITH CHECK-ENGINE ON', (d) => `${Math.round((d[0] * 256 + d[1]) * KM_MI).toLocaleString('en-US')} MI`],
  [0x4D, 'TIME WITH CHECK-ENGINE ON', (d) => `${(d[0] * 256 + d[1]).toLocaleString('en-US')} MIN`],
  [0x30, 'WARM-UPS SINCE CODES CLEARED', (d) => String(d[0])],
  [0x31, 'DISTANCE SINCE CODES CLEARED', (d) => `${Math.round((d[0] * 256 + d[1]) * KM_MI).toLocaleString('en-US')} MI`],
  [0x4E, 'TIME SINCE CODES CLEARED', (d) => `${(d[0] * 256 + d[1]).toLocaleString('en-US')} MIN`],
];

/** Data bytes of a mode-01 reply for one PID, or null. */
export function pidBytes(text, pid) {
  const tag = [0x41, pid];
  for (const msg of replyMessages(text)) for (let i = 0; i + 1 < msg.length; i++) if (msg[i] === tag[0] && msg[i + 1] === tag[1]) return msg.slice(i + 2);
  return null;
}

// Plain-English summaries of the common generic codes (our own wording).
const DESC = {
  P0010: 'Intake cam timing actuator circuit (bank 1)', P0011: 'Intake cam timing over-advanced (bank 1)', P0014: 'Exhaust cam timing over-advanced (bank 1)',
  P0020: 'Intake cam timing actuator circuit (bank 2)', P0021: 'Intake cam timing over-advanced (bank 2)',
  P0030: 'Front O2 sensor heater circuit (bank 1)', P0050: 'Front O2 sensor heater circuit (bank 2)',
  P0087: 'Fuel rail pressure too low', P0088: 'Fuel rail pressure too high', P0089: 'Fuel pressure regulator performance',
  P0101: 'Mass airflow sensor reading out of range', P0102: 'Mass airflow sensor signal low', P0103: 'Mass airflow sensor signal high',
  P0106: 'Manifold pressure sensor reading out of range', P0107: 'Manifold pressure sensor signal low', P0108: 'Manifold pressure sensor signal high',
  P0111: 'Intake air temperature sensor out of range', P0112: 'Intake air temperature sensor signal low', P0113: 'Intake air temperature sensor signal high',
  P0116: 'Coolant temperature sensor out of range', P0117: 'Coolant temperature sensor signal low', P0118: 'Coolant temperature sensor signal high',
  P0121: 'Throttle position sensor out of range', P0122: 'Throttle position sensor signal low', P0123: 'Throttle position sensor signal high',
  P0128: 'Engine taking too long to warm up (thermostat)', P0130: 'Front O2 sensor circuit (bank 1)', P0133: 'Front O2 sensor slow to respond (bank 1)',
  P0135: 'Front O2 sensor heater (bank 1)', P0137: 'Rear O2 sensor signal low (bank 1)', P0141: 'Rear O2 sensor heater (bank 1)',
  P0150: 'Front O2 sensor circuit (bank 2)', P0155: 'Front O2 sensor heater (bank 2)',
  P0171: 'Running lean (bank 1)', P0172: 'Running rich (bank 1)', P0174: 'Running lean (bank 2)', P0175: 'Running rich (bank 2)',
  P0191: 'Fuel rail pressure sensor out of range', P0217: 'Engine over-temperature',
  P0234: 'Turbo overboost', P0236: 'Boost pressure sensor out of range', P0237: 'Boost pressure sensor signal low', P0238: 'Boost pressure sensor signal high',
  P0299: 'Turbo underboost (boost lower than asked for)',
  P0300: 'Random or multiple misfires', P0301: 'Misfire, cylinder 1', P0302: 'Misfire, cylinder 2', P0303: 'Misfire, cylinder 3',
  P0304: 'Misfire, cylinder 4', P0305: 'Misfire, cylinder 5', P0306: 'Misfire, cylinder 6',
  P0325: 'Knock sensor circuit (bank 1)', P0330: 'Knock sensor circuit (bank 2)', P0335: 'Crankshaft position sensor circuit',
  P0340: 'Camshaft position sensor circuit (bank 1)', P0345: 'Camshaft position sensor circuit (bank 2)',
  P0420: 'Catalyst efficiency low (bank 1)', P0430: 'Catalyst efficiency low (bank 2)',
  P0440: 'Evap system fault', P0441: 'Evap purge flow incorrect', P0442: 'Small evap leak', P0455: 'Large evap leak (check the fuel cap)', P0456: 'Very small evap leak',
  P0500: 'Vehicle speed sensor', P0505: 'Idle control system', P0506: 'Idle speed lower than expected', P0507: 'Idle speed higher than expected',
  P0562: 'System voltage low', P0563: 'System voltage high', P0600: 'Engine computer communication fault', P0605: 'Engine computer memory fault',
  P0700: 'Transmission control fault (see transmission codes)', P0715: 'Transmission input speed sensor', P0720: 'Transmission output speed sensor',
  P0830: 'Clutch pedal switch circuit', P0833: 'Clutch pedal switch B circuit',
  P2101: 'Throttle motor control range', P2135: 'Throttle position sensors disagree', P2138: 'Accelerator pedal sensors disagree',
  P2261: 'Turbo bypass (blow-off) valve', P2263: 'Turbo boost system performance',
  U0100: 'Lost communication with the engine computer', U0101: 'Lost communication with the transmission computer',
  U0121: 'Lost communication with the ABS module', U0140: 'Lost communication with the body module', U0155: 'Lost communication with the instrument cluster',
};
const GROUP = {
  P00: 'Fuel, air or emissions control', P01: 'Fuel and air metering', P02: 'Fuel and air metering (injectors)', P03: 'Ignition or misfire',
  P04: 'Emissions controls', P05: 'Speed, idle or input signals', P06: 'Engine computer or its outputs', P07: 'Transmission', P08: 'Transmission',
  P0A: 'Hybrid system', P2: 'Powertrain (generic)', C: 'Chassis (brakes, steering, suspension)', B: 'Body (airbags, lights, comfort)', U: 'Network / module communication',
};
/** Description for a code: known text, else its system, flagged when it's manufacturer-specific. */
export function describe(code) {
  if (DESC[code]) return DESC[code];
  const maker = code[1] === '1' || (code[0] === 'P' && code[1] === '3');
  const grp = GROUP[code.slice(0, 3)] || GROUP[code.slice(0, 2)] || GROUP[code[0]] || 'Unknown system';
  return maker ? `${grp} · Nissan-specific code` : grp;
}

/** Reads everything the Diagnostics tab shows. Each part is optional: a car that refuses one still shows the rest. */
export async function readAll(ask) {
  const r = { stored: [], pending: [], permanent: [], status: null, counters: [], at: new Date() };
  const tryAsk = async (cmd) => { try { return await ask(cmd); } catch { return ''; } };
  r.status = parseMonitors(pidBytes(await tryAsk('0101'), 0x01));
  r.stored = parseDtcs(await tryAsk('03'), 0x03);
  r.pending = parseDtcs(await tryAsk('07'), 0x07);
  r.permanent = parseDtcs(await tryAsk('0A'), 0x0A);
  for (const [pid, label, dec] of COUNTERS) {
    const b = pidBytes(await tryAsk('01' + hex2(pid)), pid);
    if (b && b.length) { try { r.counters.push([label, dec(b)]); } catch { /* short reply */ } }
  }
  return r;
}

/** Clears codes and resets monitors (mode 04). Returns true when the ECU confirms. */
export async function clearCodes(ask) {
  const t = await ask('04');
  return /44/.test(String(t).replace(/\s/g, ''));
}

/** Simulator answers for the Diagnostics tab. */
export function simAnswer(cmd) {
  return {
    '0101': '41 01 82 07 E5 A1', '03': '43 02 01 71 03 02', '07': '47 01 04 20', '0A': '4A 00',
    '0121': '41 21 00 2A', '014D': '41 4D 00 3C', '0130': '41 30 12', '0131': '41 31 01 F4', '014E': '41 4E 02 1C', '04': '44',
  }[cmd] ?? 'NO DATA';
}
