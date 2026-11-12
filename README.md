# Carbox Dash (phone app)

The carbox dashboard as a phone app for the 2025 Nissan Z. Same graphite HUD, red CAD wireframe of the Z
and six tabs as the Raspberry Pi version, but it runs on the phone and reads the car through a
**Bluetooth LE OBD-II (ELM327) adapter**. No Pi, no Android Auto certificates.

## Run it
```bash
node serve.cjs 5560
```
Open http://127.0.0.1:5560. It starts on the built-in simulator. In the Claude app's browser pane it is the
`carbox-app` entry in `Study\.claude\launch.json`.

Test the OBD driver and gear detection (no hardware needed, uses a fake adapter):
```bash
node tests/elm.test.mjs
node tests/adapters.test.mjs
node tests/latency.test.mjs     # how fast a change at the engine reaches the app
```

## Layout
| File | What it does |
|---|---|
| `index.html`, `style.css` | All six screens. Portrait phone layout; landscape / wide gets the car-screen layout with the driver column |
| `js/main.js` | Builds the UI, display-rate update loop with eased values, callout placement, settings (saved in localStorage), CSV datalog download |
| `js/store.js` | Signal definitions, units, warning levels |
| `js/derive.js` | Gear from RPM vs speed (Z 6-speed ratios), trip, peaks, shifts, 0–60 / 0–100 timer |
| `js/sim.js` | Fake drive for the UI |
| `js/elm327.js` | ELM327 driver (init, Mode 01 polling, parsing, pause) + `FakeElmTransport` for tests |
| `js/ble.js` | Web Bluetooth transport for BLE ELM327 adapters (**untested on hardware**) |
| `js/wire.js` | Red wireframe Z, drawn with WebGL (2D canvas fallback); camera glides between views, AUTO orbits continuously |
| `data/z-model.json` | Wireframe from `carbox/carbox/ui/z_model.npz`; CAD model "2023 Nissan Z Proto" by tonielpro520 (Sketchfab), **CC BY 4.0, keep the on-screen credit** |

## What data you get
Standard OBD-II through the adapter: RPM, speed, boost (manifold pressure minus barometric), throttle,
coolant, intake temp, timing, battery, and oil temp / ethanol only if the ECU answers those PIDs.
Gear, trip, peaks, shifts and the timers are calculated in the app.
**Knock, and usually ethanol and oil temp on the VR30, are EcuTek RaceROM values that OBD-II does not
give.** Getting them needs the tuner to set up RaceROM CAN output and a CAN-capable adapter; not built yet.
Pause OBD (Systems tab) stops all transmission; turn it on before flashing with EcuTek.

## Cars
Systems > **Car** picks the car: **Nissan Z 6MT**, **Nissan Z 9AT** or **Acura Integra A-Spec 6MT** (1.5T).
Each profile (`js/cars.js`, mirrored in `ios/App/Telemetry.swift`) sets the gear ratios, final drive and tyre
size used for the gear display, the rev and boost limits, and which gauges are shown. Gear is worked out
from RPM vs speed, and the app learns a correction of up to ±8 % while you drive (tyre size, speedo error).
On the Z automatic, choose the 9AT profile or the gear will read N.

The Integra profile swaps the gauges OBD-II can't give on that car (knock, oil temp, ethanol) for engine
load and direct-injection fuel-rail pressure. Air/fuel comes from the wide-band O2 sensor (PID 34 or 24).
Boost is manifold pressure (PID 0B) minus barometric; when a car doesn't offer 0B the driver tries PIDs
87 and 70. The BUS tab shows where boost and air/fuel are read from and every PID the car offers.

### Gear and reverse
Gear only changes once the RPM/speed ratio has held steady for ~0.1 s (clutch out), and the shown gear
is held through the shift itself, so a 2-3 change goes straight from 2 to 3 with no stray gears or N in
between. RPM is lined up with the moment speed was read, which matters on adapters that read one value
at a time. `tests/shift.test.mjs` drives an Integra through a full pull and rev-matched downshifts.

OBD-II can't show reverse: speed has no direction, and the Integra's reverse ratio is within 1 % of 1st.
In the iPhone app, R comes from the phone's motion sensor (`js/reverse.js`, `ios/App/Motion.swift`). It
learns which way the phone faces in its mount while you drive in 2nd and up (a few minutes, once), then
on each pull-away from a stop checks which way the car moved. Moving the phone to a different mount
angle re-learns over a few minutes. `tests/reverse.test.mjs` covers 40 mounting angles.

## Look
Systems > **Background**: PEARL (live neon pearl wallpaper, panels turn to frosted glass) or BLACK (pure
black for the OLED screen). The default gauge look is REAL (metal bezel, printed dial, shadowed needle,
glass reflection); STYLE on the TACH tab has the others. On-screen text was edited with the humanizer
rules (github.com/blader/humanizer).

## How it stays quick
After connecting, the driver probes the adapter and turns on whatever speed-ups it supports (the
BUS tab shows a `fast mode:` line with what it got):
- **Talks to the engine ECU directly** (`ATSH7E0`) on CAN, so the transmission doesn't answer too.
- **Reply count** (`010C1`): without it the ELM327 waits 50–200 ms after every answer in case another
  ECU speaks. That wait was most of the lag when accelerating.
- **Several PIDs per request** (`010C0D0B11`): RPM, speed, boost and throttle in one Bluetooth round trip,
  with two slow values (temps, battery, timing) added every other request.
- **Supported-PID bitmaps** (`0100/0120/0140`), so nothing is spent on PIDs the ECU never answers.
- `ATAT2` timing, 0.6 s request timeout and a shorter resync after a dropped reply.

On the fake CAN car (`tests/latency.test.mjs`, realistic BLE timing) a change in RPM reaches the app in
~75 ms on average (it was ~400 ms) and RPM/boost/throttle refresh ~20×/s (was ~1.5×/s). Older clones
that can't do these fall back step by step and are still faster than before. In the iPhone app new
values go to the screen as soon as they arrive instead of on a 10 Hz timer. Real-adapter numbers
depend on the adapter; OBDLink CX and Vgate iCar Pro class adapters support all of it.

## Getting it onto the iPhone (not done yet)
iOS Safari has no Web Bluetooth, so the iPhone version has to be wrapped as a native app:
1. On the Mac: `npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor-community/bluetooth-le`,
   `npx cap init "Carbox Dash" com.jhon.carbox --web-dir .` then `npx cap add ios`.
2. Replace `WebBleTransport` with a small class using `@capacitor-community/bluetooth-le` (same four methods:
   `open`, `write`, `onData`, `close`).
3. Open in Xcode, sign with your Apple ID, run on the iPhone. A free Apple ID works for your own phone
   (the app expires after 7 days); a paid developer account ($99/yr) lasts a year.

Android: Chrome supports Web Bluetooth, so the web version can talk to an adapter as is (untested).

## Layout and motion checks
`tests/overlap.js` finds overlapping, clipped or off-screen text. In the browser console:
`eval(await (await fetch('/tests/overlap.js')).text()); __overlap()` on any screen. Checked clean on
2026-11-11 at 320x568, 375x667, 375x812, 667x375, 812x375 and 1024x600, every tab and camera view.
Motion: one requestAnimationFrame loop (60/120 Hz), values ease over ~35 ms between OBD samples,
car drawn in WebGL (~0.04 ms CPU per frame vs ~14 ms with 2D canvas). Reduced-motion turns off the
tab fade and colour transitions.

## iPhone app + CarPlay
See `ios/README.md`. Native Swift app (built on the Mac with Xcode + XcodeGen) that shows this web dash,
runs Bluetooth/OBD natively so it keeps going with the phone locked, and adds a Drive Live Activity
and a Last-drive widget (both appear on the CarPlay Dashboard on iOS 26+, no approval needed) plus
CarPlay Live/Session/Controls screens that need Apple's Driving Task entitlement. Not compiled yet.
`tests/native.html` checks the page's native bridge in a normal browser.
