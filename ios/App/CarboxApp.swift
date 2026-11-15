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
        if ProcessInfo.processInfo.arguments.contains("-carboxDemo") {
            useSimulator()
        } else {
            telemetry.source = .none
            telemetry.status = "SELECT ADAPTER"
        }
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
        stopAdapter()
        cancelPicker()
        sim?.stop()
        lastError = nil
        adapterInfo = [:]
        telemetry.clear(); telemetry.paused = false
        sim = SimSource(telemetry); sim?.start()
        live.start()
    }

    // MARK: adapter picker
    private var link: BLELink?
    private var adapterTask: Task<Void, Never>?
    private var scanTask: Task<Void, Never>?
    @Published var scanning = false
    @Published var devices: [FoundDevice] = []
    @Published var adapterInfo: [String: String] = [:]

    private func ensureLink() -> BLELink {
        if let link { return link }
        let l = BLELink()   // creating this shows the iOS Bluetooth permission prompt the first time
        l.onDevices = { [weak self] devices in self?.devices = devices }
        l.onDiagnostic = { [weak self] line in self?.telemetry.log(line) }
        l.onDisconnect = { [weak self] in
            guard let self, self.telemetry.source == .obd else { return }
            self.stopAdapter()
            self.telemetry.clear()
            self.telemetry.source = .none
            self.telemetry.status = "DISCONNECTED"
            self.lastError = "Bluetooth disconnected. Reselect the adapter in Settings."
        }
        link = l
        return l
    }

    private func stopAdapter() {
        adapterTask?.cancel()
        adapterTask = nil
        if let elm { elm.stop() } else { link?.close() }
        elm = nil
    }

    /// Reconnects to the adapter used last time, or opens the picker.
    func useAdapter() {
        let l = ensureLink()
        if let saved = l.savedAdapter { connect(saved.uuidString) } else { openPicker() }
    }

    func openPicker() {
        let l = ensureLink()
        cancelPicker()
        devices = []; scanning = true
        scanTask = Task {
            do { try await l.startScan() }
            catch {
                guard !Task.isCancelled else { return }
                scanning = false
                lastError = error.localizedDescription
                telemetry.log("! " + error.localizedDescription)
            }
        }
    }

    func cancelPicker() {
        scanTask?.cancel()
        scanTask = nil
        link?.stopScan()
        scanning = false
    }

    func connect(_ id: String) {
        guard let uuid = UUID(uuidString: id) else { return }
        let l = ensureLink()
        cancelPicker()
        sim?.stop(); sim = nil
        stopAdapter()
        adapterInfo = [:]
        lastError = nil
        telemetry.clear(); telemetry.source = .obd; telemetry.paused = false; telemetry.status = "CONNECTING"
        adapterTask = Task {
            do {
                try await l.connect(uuid)
                try Task.checkCancellation()
                adapterInfo = l.info
                let e = ELM327(link: l, telemetry: telemetry)
                elm = e
                try await e.start()
                try Task.checkCancellation()
                adapterInfo = l.info.merging(["elm": e.identity, "fast": e.fastSummary]) { $1 }
                live.start()
            } catch {
                guard !Task.isCancelled else { return }
                lastError = error.localizedDescription
                adapterInfo = l.info
                if let elm { elm.stop() } else { l.close() }
                elm = nil
                telemetry.clear()
                telemetry.source = .none
                telemetry.status = "ADAPTER FAILED"
                telemetry.log("! " + error.localizedDescription)
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
