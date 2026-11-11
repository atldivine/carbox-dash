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
        telemetry.clear(); telemetry.paused = false
        sim = SimSource(telemetry); sim?.start()
        live.start()
    }

    func useAdapter() {
        sim?.stop(); sim = nil
        telemetry.clear(); telemetry.source = .obd; telemetry.paused = false
        let e = ELM327(link: BLELink(), telemetry: telemetry)
        elm = e
        Task {
            do { try await e.start(); lastError = nil; live.start() }
            catch { lastError = error.localizedDescription; telemetry.status = "NO ADAPTER"; useSimulator() }
        }
    }

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

extension Notification.Name { static let telemetryTick = Notification.Name("carbox.tick") }
