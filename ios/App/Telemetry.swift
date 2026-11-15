import Foundation
import Combine

/// One live value per signal, plus everything worked out from them (gear, trip, peaks, shifts,
/// 0-60). Swift twin of js/store.js + js/derive.js, so CarPlay and the Live Activity keep working
/// while the phone is locked and the web view is paused.
@MainActor
final class Telemetry: ObservableObject {
    static let shared = Telemetry()

    enum Source: String { case none, sim, obd }

    @Published private(set) var values: [String: Double] = [:]
    @Published private(set) var gear = "N"
    @Published var paused = false            // "flash safe": the OBD driver stops transmitting
    @Published var source: Source = .none
    @Published var status = "NO SOURCE"
    @Published private(set) var peaks: [String: Double] = [:]
    @Published private(set) var trip = 0.0
    @Published private(set) var shifts = 0
    @Published private(set) var best0to60: Double?
    @Published var logging = false

    /// Recent raw adapter lines for the BUS tab (plain var: changes too often to publish).
    private(set) var busLog: [String] = []
    private(set) var busCount = 0
    func log(_ line: String) { busLog.append(line); busCount += 1; if busLog.count > 60 { busLog.removeFirst(busLog.count - 60) } }

    private var stamps: [String: Date] = [:]
    private var lastTick: Date?
    private var rawGear = "N", rawSince = Date(), realGear: String?
    private var perfState = "wait", perfStart = Date(), got60 = false
    private(set) var logRows: [[String]] = []

    // 2023+ Z 6-speed manual; the 9-speed automatic needs its own ratios.
    let ratios = [3.794, 2.324, 1.624, 1.271, 1.000, 0.794]
    let finalDrive = 3.692, tireCircM = 2.121
    static let fastKeys: Set<String> = ["rpm", "speed", "boost", "throttle", "afr", "knock"]
    static let keys = ["rpm", "speed", "boost", "afr", "iat", "coolant", "oil_temp", "ethanol", "timing", "knock", "throttle", "fuel_pressure", "battery",
                       "stft", "ltft", "maf", "lambda", "lambda_cmd"]

    func set(_ key: String, _ value: Double) { values[key] = value; stamps[key] = Date() }
    func get(_ key: String) -> Double? {
        // Live for 2 s; slow-changing values for 12 s (single-PID adapters reach them every few seconds).
        guard let v = values[key], let t = stamps[key], Date().timeIntervalSince(t) < (Self.fastKeys.contains(key) ? 2 : 12) else { return nil }
        return v
    }
    func clear() { values = [:]; stamps = [:] }
    var liveCount: Int { Self.keys.filter { get($0) != nil }.count }

    /// Call ~10 times a second.
    func tick() {
        let now = Date()
        let rpm = get("rpm"), mph = get("speed")
        if let last = lastTick, let mph { trip += mph * now.timeIntervalSince(last) / 3600 }
        lastTick = now
        let g = calcGear(rpm: rpm, mph: mph)
        if g != rawGear { rawGear = g; rawSince = now }
        else if g != gear, now.timeIntervalSince(rawSince) > 0.15 {
            if g != "N", let real = realGear, g != real { shifts += 1 }
            if g != "N" { realGear = g }
            gear = g
        }
        for k in Self.keys { if let v = get(k), v > (peaks[k] ?? -.infinity) { peaks[k] = v } }
        if let mph { perf(mph: mph, now: now) }
        if logging {
            logRows.append([String(format: "%.3f", now.timeIntervalSince1970)] + Self.keys.map { get($0).map { String(format: "%.3f", $0) } ?? "" })
        }
    }

    func calcGear(rpm: Double?, mph: Double?) -> String {
        guard let rpm, let mph, mph >= 3, rpm >= 600 else { return "N" }
        let wheelRpm = mph / 2.23694 / tireCircM * 60
        let ratio = rpm / (wheelRpm * finalDrive)
        guard let best = ratios.indices.min(by: { abs(ratios[$0] - ratio) < abs(ratios[$1] - ratio) }) else { return "N" }
        return abs(ratios[best] - ratio) / ratios[best] > 0.08 ? "N" : String(best + 1)
    }

    private func perf(mph: Double, now: Date) {
        switch perfState {
        case "wait": if mph < 0.5 { perfState = "armed" }
        case "armed": if mph > 1 { perfState = "running"; perfStart = now; got60 = false }
        case "running":
            if !got60, mph >= 60 { got60 = true; let t = now.timeIntervalSince(perfStart); best0to60 = min(best0to60 ?? .infinity, t); perfState = "done" }
            else if mph < 0.5 { perfState = "armed" }
        default: if mph < 0.5 { perfState = "armed" }
        }
    }

    func resetPeaks() { peaks = [:]; best0to60 = nil }
    func resetTrip() { trip = 0 }

    /// Snapshot for the Live Activity / CarPlay.
    var warning: String? {
        if (get("knock") ?? 0) >= 2 { return "KNOCK" }
        if let afr = get("afr"), let b = get("boost"), afr > 13.2, b > 5 { return "LEAN" }
        if (get("coolant") ?? 0) >= 225 || (get("oil_temp") ?? 0) >= 260 { return "HOT" }
        return nil
    }

    func saveSummary() {
        DriveSummary(endedAt: Date(), miles: trip, peakBoostPsi: peaks["boost"], peakRpm: peaks["rpm"].map { Int($0) },
                     best0to60: best0to60, shifts: shifts).save()
    }

    func csv() -> String {
        (["unix_time"] + Self.keys).joined(separator: ",") + "\n" + logRows.map { $0.joined(separator: ",") }.joined(separator: "\n")
    }
}

/// Fake drive for testing in the CarPlay Simulator without a car (same loop as js/sim.js).
@MainActor
final class SimSource {
    private var timer: Timer?
    private var mph = 0.0, gear = 1, rpm = 780.0, phase = "idle", phaseStart = Date(), clutchUntil = Date.distantPast, last = Date()
    private let t: Telemetry
    init(_ t: Telemetry) { self.t = t }

    func start() {
        t.source = .sim; t.status = "SIM"
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in Task { @MainActor in self?.step() } }
    }
    func stop() { timer?.invalidate(); timer = nil }

    private func rpmFor(_ mph: Double, _ g: Int) -> Double { mph / 2.23694 / t.tireCircM * 60 * t.ratios[g - 1] * t.finalDrive }

    private func step() {
        guard !t.paused else { return }
        let now = Date(), dt = now.timeIntervalSince(last); last = now
        var pull = 0.0
        switch phase {
        case "idle":
            mph = 0; rpm = 780 + .random(in: -15...15)
            if now.timeIntervalSince(phaseStart) > 4 { phase = "pull"; phaseStart = now; gear = 1 }
        case "pull":
            pull = 1
            if now < clutchUntil { rpm = max(rpm - 9000 * dt, rpmFor(mph, gear)); pull = 0 }
            else {
                mph += dt * (9.5 - Double(gear) * 1.6); rpm = max(1500, rpmFor(mph, gear))
                if rpm > 6600, gear < 4 { gear += 1; clutchUntil = now.addingTimeInterval(0.35) }
                else if gear == 4, rpm > 6400 { phase = "coast"; phaseStart = now }
            }
        default:
            mph = max(0, mph - dt * 6)
            if mph > 18 { rpm = rpmFor(mph, gear); if rpm < 1800, gear > 2 { gear -= 1 } } else { rpm = 800 }
            if mph == 0 { phase = "idle"; phaseStart = now }
        }
        let spool = min(1, max(0, (rpm - 2200) / 1800)) * pull
        t.set("rpm", rpm); t.set("speed", mph)
        t.set("boost", (pull > 0 ? -11 + spool * 30 : -11.5) + .random(in: -0.2...0.2))
        t.set("afr", (pull > 0 ? 14.7 - spool * 3.3 : 14.7) + .random(in: -0.08...0.08))
        t.set("iat", 92 + spool * 24); t.set("coolant", 192); t.set("oil_temp", 214 + spool * 16)
        t.set("ethanol", 38); t.set("timing", 22 - spool * 12); t.set("knock", 0)
        t.set("throttle", pull > 0 && now >= clutchUntil ? 100 : 0); t.set("battery", 14.1)
        let afr = t.values["afr"] ?? 14.7
        t.set("lambda", afr / 14.7); t.set("lambda_cmd", pull > 0 ? 1 - spool * 0.22 : 1)
        t.set("maf", 3.5 + rpm / 7000 * (pull > 0 ? 180 * (0.3 + spool) : 12)); t.set("stft", .random(in: -2.5...2.5)); t.set("ltft", 2.3)
        NotificationCenter.default.post(name: .telemetrySample, object: nil)
        for _ in 0..<3 {   // plausible-looking bus traffic for the BUS tab
            let id = [0x160, 0x180, 0x1F9, 0x215, 0x245, 0x284, 0x351, 0x421, 0x551, 0x6A0].randomElement()!
            t.log(String(format: "0x%03X  ", id) + (0..<8).map { _ in String(format: "%02X", Int.random(in: 0...255)) }.joined(separator: " "))
        }
    }
}
