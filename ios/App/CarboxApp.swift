import SwiftUI
import UIKit

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
        PhoneSensors.shared.start()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private var ticks = 0
    private func tick() {
        telemetry.tick()
        ticks += 1
        if ticks % 10 == 0 { live.update(from: telemetry) }   // Live Activity: once a second is plenty
        NotificationCenter.default.post(name: .telemetryTick, object: nil)
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
                adapterInfo = l.info.merging(["elm": e.identity, "fast": e.fastSummary]) { $1 }
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

    /// One raw OBD request for the Diagnostics tab (the page simulates answers in SIM mode).
    func rawOBD(_ req: String) async throws -> String {
        guard let elm else { throw BLELink.err("No adapter connected") }
        return try await elm.raw(req)
    }

    func forgetAdapter() { link?.forget(); adapterInfo = [:] }

    func toggleSource() { telemetry.source == .sim ? useAdapter() : useSimulator() }

    func toggleLog() {
        if telemetry.logging {
            telemetry.logging = false
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("carbox-\(Int(Date().timeIntervalSince1970)).csv")
            try? telemetry.csv().write(to: url, atomically: true, encoding: .utf8)   // visible in the Files app
        } else { telemetry.logging = true }
    }

    func endDrive() { telemetry.saveSummary(); live.end() }
}

extension Notification.Name {
    static let telemetryTick = Notification.Name("carbox.tick")
    /// Posted as soon as a fresh set of OBD / sim values lands, so the screen updates right away
    /// instead of waiting for the next 10 Hz tick.
    static let telemetrySample = Notification.Name("carbox.sample")
}
