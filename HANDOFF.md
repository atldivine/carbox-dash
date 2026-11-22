# Carbox Dash: handoff (2026-11-15)

Paste this into a new Claude session to continue.

## What it is
An iPhone dash app for the user's **2025 Nissan Z** (iPhone, MacBook Air, FIXD + a generic ELM327 BLE adapter, EcuTek EVI-BT).
The web dash (index.html, style.css, js/) runs inside a Swift app (WKWebView, `ios/`). Native Swift owns Bluetooth/OBD and pushes data to the page.
Repo: **github.com/atldivine/carbox-dash** (private), branch `main`, latest `5bc8506`.
Local folder (Windows PC): `C:\Users\jomel\Desktop\Study\carbox-app`. Notes: Obsidian vault `Study\brain\Projects\carbox-app.md`.

## Current state
- **Latest app build:** `CarboxDash-0.7.5-download.zip` (Desktop on the PC). It's the new web dash inside the last Mac-compiled app (0.7.1), so new Swift features are NOT in it.
- **GitHub Actions (the Mac build) is blocked:** "recent account payments have failed or your spending limit needs to be increased" on the atldivine account. Fix billing, then re-run the `ios` + `simulator` workflows. Or build on the MacBook Air: `cd ios && bash sync-web.sh && brew install xcodegen && xcodegen`, then build CarboxDash in Xcode.
- **Swift written but never compiled:** BridgeServer.swift (CarTV bridge), torque PIDs 61/62/63, IAT/MAF alternate PIDs 68/66, background location, haptic tick, the 9AT gear readout for CarPlay. Plus another tool's (ChatGPT) BLE/ELM327 rewrite in OBD.swift.
- **Website:** being set up as **carbox.nich.world**, a Render static site from `render.yaml`. One-tap link: https://render.com/deploy?repo=https://github.com/atldivine/carbox-dash . Then add an IONOS DNS CNAME `carbox` pointing to the `<name>.onrender.com` address and verify in Render. **Leave nich.world itself alone:** it's the separate "Nich" club app on Render. Its source isn't local and the GitHub repo is empty. A backup of its front end is in `Study\nich.world-backup-20261115-1852`.

## How live data reaches CarTV / Safari
iPhone browsers can't use Bluetooth. The Carbox app serves the dash at **http://localhost:8787** (loopback only): SSE `/live` for data, `POST /cmd` (header `X-Carbox: 1`) for commands. Open that URL in CarTV while the Carbox app is running. It switches to lite mode automatically. PC stand-in for testing: `node tests/bridge-mock.cjs`.

## Key facts and decisions
- **Z ratios (Nissan spec):** 6MT 3.794/2.324/1.624/1.271/1.000/0.794, final **3.538**. 9AT 5.425/3.263/2.249/1.649/1.221/1.000/0.862/0.713/0.597, final **3.133**. Tyre 275/35R19 = 2.121 m. Which gearbox the user's car has is unknown; the app auto-detects (Settings → Transmission).
- **Gear detection** (`js/derive.js`): runs per new reading. It allows the ECU speed to lag rpm by up to 0.5 s in the direction of acceleration, and learns the tyre/speedo scale. N shows instantly below 3 mph. `tests/gear.test.mjs`.
- **User's real OBD log:** CAN protocol 6, engine ECU direct (7E0), reply count, 4–6 PIDs per request, about 7 readings/s. The car didn't list 0F/10/34/52. Lambda comes on PID 24; ethanol needs EcuTek RaceROM CAN.
- **POWER page:** gauges use ECU torque (PID 62 × 63) when available, else load- or boost-based estimates (labelled).
- **EcuTek EVI-BT:** ECU Connect only, and it flashes the ECU. The app refuses to connect to it on purpose. EcuTek values come through RaceROM CAN output + a CANsub + DBC (`data/ecutek-racerom-example.dbc`).
- **CAN:** CANsub WebSocket reader (`js/can.js`, checked against the manual's test vectors). `data/z-can.dbc` is an unverified starter. The CSS Electronics CAN skills are installed in `~/.claude/skills`, with a Python 3.12 venv in `Study\can-bus-re`.
- **Rules:** never force-push; never enter the user's passwords; keep the CC BY 4.0 car-model credit on screen; no pixel copy of cntdrive's dash (match features, not his design).

## Tests (run from carbox-app)
`node tests/elm.test.mjs && node tests/adapters.test.mjs && node tests/perf.test.mjs && node tests/can.test.mjs && node tests/drift.test.mjs && node tests/gear.test.mjs`
`tests/latency.test.mjs` fails on the Windows PC only (timer granularity). Trust the Mac CI.

## Open items
1. User finishes the Render one-tap deploy + IONOS CNAME → verify carbox.nich.world.
2. Fix GitHub billing (or build on the Mac) → compile the Swift → real IPA with the CarTV bridge.
3. Test in the car: gears under throttle, readings/s in the header, whether the Z answers PID 62/63.

## MyNISSAN cloud integration (added 2026-11-22)
Separate from the Bluetooth/OBD data above: `nissanClient.cjs` talks to Nissan's own cloud (MyNISSAN app's
backend), reverse-engineered from the app's traffic (unofficial, not affiliated with Nissan; endpoints can
change without notice). Gives door lock/unlock + fuel/mileage/warning-light status for the user's Z, confirmed
working against the real car (lock command verified end-to-end).
- `relay.cjs` wires it in behind the same pairing-key auth as everything else: `GET /nissan/status?key=KEY`,
  `POST /nissan/cmd?key=KEY` with `{"cmd":"lock"|"unlock"|"flash-lights"}`.
- Needs `NISSAN_EMAIL` / `NISSAN_PASSWORD` env vars set on Render (Environment tab, not committed — see
  `render.yaml`). Entirely disabled (skips auth, returns 503) if those aren't set, so it's safe to deploy
  without them.
- Tokens persist to `nissan-tokens.json` next to the server (git-ignored) so it isn't re-authenticating on
  every request; cleared on redeploy since Render's free plan filesystem is ephemeral, but re-authenticates
  automatically from the env vars.
- Not yet wired into the iPhone app's UI (`ios/`) or the web dash (`index.html`/`js/`) — only the relay
  endpoints exist so far. Next step there: a lock/unlock tile and door/fuel readout somewhere in the dash.
- Standalone test scripts (pure Python, no deps) for poking at the MyNISSAN API directly, outside this repo:
  were handed to the user as `nissan_test.py` (status) and `nissan_commands.py` (lock/unlock/flash-lights with
  a confirmation prompt) — useful if the relay's integration ever needs debugging in isolation.
