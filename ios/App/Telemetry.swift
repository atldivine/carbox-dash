import Foundation
import Combine

/// Gearing per car for the gear display. Same table as js/cars.js: keep the two in step.
struct CarProfile {
    let id: String, short: String, ratios: [Double], finalDrive: Double, tireCircM: Double, shiftRpm: Double
    static let all: [String: CarProfile] = [
        // 2023+ Nissan Z (RZ34): spec sheet final drive 3.538 manual / 3.133 automatic
        "z-6mt": CarProfile(id: "z-6mt", short: "Z", ratios: [3.794, 2.324, 1.624, 1.271, 1.000, 0.794], finalDrive: 3.538, tireCircM: 2.121, shiftRpm: 6800),
        "z-9at": CarProfile(id: "z-9at", short: "Z AUTO", ratios: [5.425, 3.263, 2.249, 1.649, 1.221, 1.000, 0.862, 0.713, 0.597], finalDrive: 3.133, tireCircM: 2.121, shiftRpm: 6800),
        // Acura Integra A-Spec Technology 6MT, 1.5T, 235/40R18
        "integra-6mt": CarProfile(id: "integra-6mt", short: "INTEGRA", ratios: [3.643, 2.080, 1.361, 1.024, 0.830, 0.686], finalDrive: 4.353, tireCircM: 2.027, shiftRpm: 6400),
    ]
    static func get(_ id: String?) -> CarProfile { all[id ?? ""] ?? all["z-6mt"]! }
}

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
    private var realGear: String?
    // gear detection state (same rules as js/derive.js; tested in tests/shift.test.mjs)
    private var ratioHist: [(t: Date, r: Double, rpm: Double, mph: Double)] = []
    private var rpmHist: [(t: Date, v: Double)] = []
    private var cand: String?, candSince = Date(), lostSince: Date?
    /// Car moving backwards (phone motion sensor, see Motion.swift).
    let reverseSensor = ReverseSensor()
    private var perfState = "wait", perfStart = Date(), got60 = false
    private(set) var logRows: [[String]] = []

    /// The car picked on the page (Systems > Car). Saved, so CarPlay knows it with the phone locked.
    @Published private(set) var car = CarProfile.get(UserDefaults.standard.string(forKey: "carbox.car"))
    var ratios: [Double] { car.ratios }
    var finalDrive: Double { car.finalDrive }
    var tireCircM: Double { car.tireCircM }
    /// Learned gearing correction (tyre size, speedometer error); same rule as js/derive.js.
    private(set) var gearK = 1.0
    func setCar(_ id: String) {
        guard CarProfile.all[id] != nil, id != car.id else { return }
        car = CarProfile.get(id); UserDefaults.standard.set(car.id, forKey: "carbox.car")
        gearK = 1; gear = "N"; realGear = nil; cand = nil; lostSince = nil; ratioHist = []
    }
    static let keys = ["rpm", "speed", "boost", "afr", "iat", "coolant", "oil_temp", "ethanol", "timing", "knock", "throttle", "fuel_pressure", "battery", "load"]

    func set(_ key: String, _ value: Double) { values[key] = value; stamps[key] = Date() }
    func get(_ key: String) -> Double? {
        guard let v = values[key], let t = stamps[key], Date().timeIntervalSince(t) < 2 else { return nil }
        return v
    }
    func clear() { values = [:]; stamps = [:] }
    var liveCount: Int { Self.keys.filter { get($0) != nil }.count }

    /// Allowed ratio error: OBD speed comes in whole km/h, so low speeds get more room.
    static func gearTol(_ mph: Double) -> Double { min(0.12, 0.035 + 0.6 / max(1, mph / 0.621371)) }

    /// RPM as it was when speed was read (one-value-at-a-time adapters read them up to ~150 ms apart).
    private func rpmAt(_ t: Date) -> Double? {
        guard let last = rpmHist.last else { return nil }
        if t >= last.t { return last.v }
        for i in stride(from: rpmHist.count - 1, to: 0, by: -1) {
            let a = rpmHist[i - 1], b = rpmHist[i]
            if t >= a.t { return a.v + (b.v - a.v) * t.timeIntervalSince(a.t) / max(0.001, b.t.timeIntervalSince(a.t)) }
        }
        return rpmHist.first?.v
    }

    /// The gear the ratio has steadily matched for the last 100 ms, or nil while the clutch is in /
    /// revs are sweeping. Learns the tyre/speedo correction while steady.
    private func engaged(_ rpm: Double?, _ mph: Double?, _ now: Date, _ dt: Double) -> Int? {
        guard let rpm, let mph, mph >= 2, rpm >= 600 else { ratioHist = []; return nil }
        let r = rawRatio(rpm, mph) / gearK
        if ratioHist.last.map({ $0.rpm != rpm || $0.mph != mph }) ?? true { ratioHist.append((now, r, rpm, mph)) }
        while ratioHist.count > 2, now.timeIntervalSince(ratioHist[1].t) > 0.1 { ratioHist.removeFirst() }
        if now.timeIntervalSince(ratioHist[0].t) < 0.06, ratioHist.count < 3 { return nil }
        let tol = Self.gearTol(mph)
        let lo = ratioHist.map(\.r).min()!, hi = ratioHist.map(\.r).max()!
        if (hi - lo) / ((hi + lo) / 2) > tol { return nil }
        guard let i = ratios.indices.min(by: { abs(ratios[$0] - r) < abs(ratios[$1] - r) }) else { return nil }
        let err = abs(ratios[i] - r) / ratios[i]
        if err <= 0.09, mph >= 15, rpm >= 1500 {
            let obs = rawRatio(rpm, mph) / ratios[i]
            gearK = min(1.08, max(0.92, gearK + (obs - gearK) * min(1, dt / 3)))
        }
        return err <= tol ? i + 1 : nil
    }

    private func show(_ g: String) {
        guard g != gear else { return }
        if Int(g) != nil, let real = realGear, g != real { shifts += 1 }
        if Int(g) != nil { realGear = g }
        gear = g
    }

    /// Call on every new sample and ~10 times a second.
    func tick() {
        let now = Date()
        let rpm = get("rpm"), mph = get("speed")
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? 0
        if let mph { trip += mph * dt / 3600 }
        lastTick = now
        if let r = values["rpm"], let t = stamps["rpm"], rpmHist.last?.t != t { rpmHist.append((t, r)); if rpmHist.count > 40 { rpmHist.removeFirst() } }
        let rpmSync = (rpm != nil && mph != nil) ? (stamps["speed"].flatMap { rpmAt($0) } ?? rpm) : rpm
        let g = engaged(rpmSync, mph, now, dt)
        if reverseSensor.reverse, let mph, mph >= 0.5 { show("R"); cand = nil; lostSince = nil }
        else if let g {
            lostSince = nil
            let cur = String(g)
            if cur == gear { cand = nil }
            else if cand != cur { cand = cur; candSince = now }
            else if now.timeIntervalSince(candSince) >= 0.04 { show(cur); cand = nil }
        } else {
            cand = nil
            if mph == nil || mph! < 2 { if !reverseSensor.reverse { show("N") } }
            else if lostSince == nil { lostSince = now }
            else if now.timeIntervalSince(lostSince!) > 1.2 { show("N") }   // coasting with the clutch in
        }
        for k in Self.keys { if let v = get(k), v > (peaks[k] ?? -.infinity) { peaks[k] = v } }
        if let mph { perf(mph: mph, now: now) }
        if logging {
            logRows.append([String(format: "%.3f", now.timeIntervalSince1970)] + Self.keys.map { get($0).map { String(format: "%.3f", $0) } ?? "" })
        }
    }

    /// Seconds since each value was read, so the page can line RPM up with speed too.
    func ages() -> [String: Double] {
        let now = Date(); var out: [String: Double] = [:]
        for (k, t) in stamps { out[k] = max(0, now.timeIntervalSince(t)) }
        return out
    }

    private func rawRatio(_ rpm: Double, _ mph: Double) -> Double { rpm / (mph / 2.23694 / tireCircM * 60 * finalDrive) }

    func calcGear(rpm: Double?, mph: Double?) -> String {
        guard let rpm, let mph, mph >= 3, rpm >= 600 else { return "N" }
        let ratio = rawRatio(rpm, mph) / gearK
        guard let best = ratios.indices.min(by: { abs(ratios[$0] - ratio) < abs(ratios[$1] - ratio) }) else { return "N" }
        return abs(ratios[best] - ratio) / ratios[best] > Self.gearTol(mph) ? "N" : String(best + 1)
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
                let shiftAt = t.car.shiftRpm - 200, top = min(4, t.ratios.count)
                if rpm > shiftAt, gear < top { gear += 1; clutchUntil = now.addingTimeInterval(0.35) }
                else if gear == top, rpm > shiftAt - 200 { phase = "coast"; phaseStart = now }
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
        t.set("load", pull > 0 ? 55 + spool * 45 : 22)
        NotificationCenter.default.post(name: .telemetrySample, object: nil)
        for _ in 0..<3 {   // plausible-looking bus traffic for the BUS tab
            let id = [0x160, 0x180, 0x1F9, 0x215, 0x245, 0x284, 0x351, 0x421, 0x551, 0x6A0].randomElement()!
            t.log(String(format: "0x%03X  ", id) + (0..<8).map { _ in String(format: "%02X", Int.random(in: 0...255)) }.joined(separator: " "))
        }
    }
}
