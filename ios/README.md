# Carbox Dash for iPhone + CarPlay

Written on Windows and **never compiled yet**: expect a few small fixes the first time Xcode builds it.

## What's in it
| Part | Where it shows | Needs Apple approval? |
|---|---|---|
| Phone app: the full web dash (wireframe Z, 6 tabs) in a web view | iPhone | No |
| Native Bluetooth + ELM327 OBD driver, gear/peaks/0-60 in Swift | runs in the background, phone locked | No |
| **Drive Live Activity**: gear, mph, rpm, boost, AFR, coolant, peak boost, KNOCK/LEAN/HOT warnings | Lock Screen, Dynamic Island, **CarPlay Dashboard (iOS 26+)** | No |
| **Last drive widget**: peak boost, best 0-60, trip | Home Screen, **CarPlay Dashboard (iOS 26+)** | No |
| **CarPlay app**: Live / Session / Controls screens | CarPlay home screen | **Yes**: Driving Task entitlement |

CarPlay only allows Apple's own screen templates (lists, grids, label/value screens). Custom drawing
such as the wireframe car or gauges is only allowed for navigation apps, so it can't be on CarPlay.

## Build on the Mac
1. Install Xcode from the App Store, open it once, and sign in with your Apple ID (Settings > Accounts).
2. In Terminal, from the `carbox-app` folder:
   ```bash
   brew install xcodegen
   ```
   ```bash
   cd ios && bash sync-web.sh && xcodegen
   ```
   ```bash
   open CarboxDash.xcodeproj
   ```
3. In Xcode, select each target (CarboxDash, CarboxWidgets) > Signing & Capabilities > pick your Team.
   If the bundle ID `com.jhon.carbox.CarboxDash` is taken, change the prefix in `project.yml` and run
   `xcodegen` again. The App Group (`group.com.jhon.carbox`) must match on both targets.
4. Run on your iPhone (plug it in, pick it as the destination, press Run). The first time, approve
   the developer on the phone: Settings > General > VPN & Device Management.
   - Free Apple ID: the app expires after 7 days; Live Activities and widgets still work. If signing
     refuses the App Group with a free account, remove it from both targets: everything works except
     the Last drive widget, which then always says "No drives yet".
   - The CarPlay entitlement line in `project.yml` will make signing fail until Apple approves it.
     **Comment it out** to build without CarPlay; the Live Activity still shows on CarPlay.

## Try it without the car
The app starts on the built-in simulator. Lock the phone: the Drive Live Activity is on the Lock
Screen. Plug into CarPlay (or use Xcode's CarPlay Simulator) and the Live Activity is on the Dashboard.
Systems tab > Data source switches to the Bluetooth adapter (FIXD, if it turns out to be a standard
ELM327; see the FIXD test in the main README).

## CarPlay app (after approval)
Request the entitlement at https://developer.apple.com/contact/carplay/ (category **Driving Task**;
needs a paid developer account). Apple decides whether a performance dash qualifies.
Once approved, uncomment the entitlement and the CarPlay screens appear:
- **Live**: gear, speed, rpm, boost, AFR, coolant, intake, battery (+ warning / paused rows), every second
- **Session**: peak boost / rpm / intake, best 0-60, trip, shifts, source
- **Controls**: pause/resume OBD (flash safe), adapter/simulator, start/stop datalog, reset peaks
Datalogs are saved as CSV in the Files app (On My iPhone > Carbox Dash).

## Files
`project.yml` XcodeGen spec · `sync-web.sh` copies the web dash in · `App/` phone app, OBD, CarPlay ·
`Widgets/` Live Activity + widget · `Shared/` types used by both.
