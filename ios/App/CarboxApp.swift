import SwiftUI
import UIKit
import WidgetKit

@main
struct CarboxDashApp: App {
    @StateObject private var model = AppModel.shared
    var body: some Scene {
        WindowGroup {
            DashWebView(model: model)
                .ignoresSafeArea()
                .background(Color(red: 7 / 255, green: 7 / 255, blue: 9 / 255))
                .preferredColorScheme(.dark)
                .onAppear { model.boot() }
                .statusBarHidden(true)
        }
    }
}

/// Owns the data source, the 10 Hz tick, the Live Activity and the datalog. Shared by the phone UI
/// and the CarPlay scene, which can run while the phone is locked.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    let telemetry = Telemetry.shared
    let live = LiveActivityController()
    private var sim: SimSource?
    private var elm: ELM327?
    private var tickTimer: Timer?
    @Published var lastError: String?
    private var booted = false

    func boot() {
        guard !booted else { return }
        booted = true
        useSimulator()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // With the phone locked (the usual case in CarPlay) timers stop firing; the app only runs when
        // Bluetooth data arrives. So every fresh OBD sample also drives the tick, and with it the Live
        // Activity on the CarPlay Dashboard. Before, the widget froze as soon as the phone locked.
        NotificationCenter.default.addObserver(forName: .telemetrySample, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // Reverse from the phone's motion sensor (learns which way the mount faces while you drive).
        telemetry.reverseSensor.start { [weak self] in
            guard let t = self?.telemetry else { return (nil, false) }
            return (t.get("speed"), ["2", "3", "4", "5", "6", "7", "8", "9"].contains(t.gear))
        }
        // A Live Activity can only be started while the app is on screen: retry each time it comes up.
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.live.start() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.saveSummary() }
        }
    }

    private var lastTick = Date.distantPast, lastLive = Date.distantPast, lastSummary = Date()
    private func tick() {
        let now = Date()
        guard now.timeIntervalSince(lastTick) >= 0.09 else { return }   // timer and samples both call this
        lastTick = now
        telemetry.tick()
        if now.timeIntervalSince(lastLive) >= 1 { lastLive = now; live.update(from: telemetry) }   // Live Activity: once a second
        // Keep the "Last drive" widget current during a drive, not only when CarPlay disconnects.
        if telemetry.source == .obd, now.timeIntervalSince(lastSummary) >= 300 { saveSummary() }
        NotificationCenter.default.post(name: .telemetryTick, object: nil)
    }

    private func saveSummary() {
        guard telemetry.source == .obd else { return }
        lastSummary = Date()
        telemetry.saveSummary()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func useSimulator() {
        elm?.stop(); elm = nil
        link?.stopScan(); scanning = false
        telemetry.clear(); telemetry.paused = false
        sim = SimSource(telemetry); sim?.start()
        live.start()
    }

    // MARK: adapter picker (any BLE OBD adapter, FIXD included: you pick it from a list)
    private var link: BLELink?
    @Published var scanning = false
    @Published var devices: [FoundDevice] = []
    @Published var adapterInfo: [String: String] = [:]

    private func ensureLink() -> BLELink {
        if let link { return link }
        let l = BLELink()   // creating this shows the iOS Bluetooth permission prompt the first time
        l.onState = { [weak self] s in Task { @MainActor in self?.telemetry.status = s } }
        l.onDevices = { [weak self] d in Task { @MainActor in self?.devices = d } }
        link = l
        return l
    }

    /// Reconnects to the adapter used last time, or opens the picker.
    func useAdapter() {
        let l = ensureLink()
        if let saved = l.savedAdapter { connect(saved.uuidString) } else { openPicker() }
    }

    func openPicker() {
        let l = ensureLink()
        devices = []; scanning = true; lastError = nil
        Task { await l.startScan() }
    }

    func cancelPicker() { link?.stopScan(); scanning = false }

    func connect(_ id: String) {
        guard let uuid = UUID(uuidString: id) else { return }
        let l = ensureLink()
        scanning = false
        sim?.stop(); sim = nil
        elm?.stop(); elm = nil
        telemetry.clear(); telemetry.source = .obd; telemetry.paused = false; telemetry.status = "CONNECTING"
        Task {
            do {
                try await l.connect(uuid)
                let e = ELM327(link: l, telemetry: telemetry)
                elm = e
                try await e.start()
                adapterInfo = l.info.merging(["elm": e.identity, "fast": e.fastSummary, "pids": e.offered]) { $1 }
                lastError = nil
                live.start()
            } catch {
                lastError = error.localizedDescription
                adapterInfo = l.info
                useSimulator()
                telemetry.status = "ADAPTER FAILED"
            }
        }
    }

    func forgetAdapter() { link?.forget(); adapterInfo = [:] }

    func toggleSource() { telemetry.source == .sim ? useAdapter() : useSimulator() }

    /// Starts / stops a test recording (Recorder.swift). Stopping opens the share sheet with the file.
    func toggleLog() {
        let rec = Recorder.shared
        if rec.on {
            telemetry.logging = false
            if let url = rec.stop() { Recorder.share(url) }
        } else {
            rec.start(meta: recordingMeta())
            telemetry.logging = true
            // what the adapter told us at connect, so the file explains itself
            for line in telemetry.busLog.suffix(60) { rec.write(["y": "bus", "l": line, "before": true]) }
        }
    }

    private func recordingMeta() -> [String: Any] {
        let c = telemetry.car, b = Bundle.main.infoDictionary ?? [:]
        var sys = utsname(); uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return ["car": c.id, "ratios": c.ratios, "final": c.finalDrive, "tire": c.tireCircM, "gearK": r3(telemetry.gearK),
                "source": telemetry.source.rawValue, "status": telemetry.status, "adapter": adapterInfo,
                "app": "\(b["CFBundleShortVersionString"] ?? "?") (\(b["CFBundleVersion"] ?? "?"))",
                "ios": UIDevice.current.systemVersion, "device": model,
                "reverseReady": telemetry.reverseSensor.learned]
    }

    func endDrive() { telemetry.saveSummary(); WidgetCenter.shared.reloadAllTimelines(); live.end() }
}

extension Notification.Name {
    static let telemetryTick = Notification.Name("carbox.tick")
    /// Posted as soon as a fresh set of OBD / sim values lands, so the screen updates right away
    /// instead of waiting for the next 10 Hz tick.
    static let telemetrySample = Notification.Name("carbox.sample")
}
