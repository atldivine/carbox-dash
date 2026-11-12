import CoreMotion
import Foundation

/// Reverse from the phone's motion sensor. Same logic as js/reverse.js (tested in tests/reverse.test.mjs):
/// OBD speed has no direction and on the Integra reverse reads the same as 1st, but the phone feels which
/// way the car pulls away. It learns "forward" for the phone's mount while you drive in 2nd and up, then
/// checks each pull-away from a stop. No permission prompt needed for raw device motion.
@MainActor
final class ReverseSensor {
    private let manager = CMMotionManager()
    private(set) var reverse = false
    private var fwd = [0.0, 0.0, 0.0], n = 0
    private var a = [0.0, 0.0, 0.0]
    private var speeds: [(t: Double, mph: Double)] = []
    private var lastT: Double?
    private var stoppedSince: Double?, vel = 0.0, decided = false
    private var lastSave = 0.0
    private static let key = "carbox.reverseAxis"
    var learned: Bool { n >= 60 }

    init() {
        if let s = UserDefaults.standard.array(forKey: Self.key) as? [Double], s.count == 4 { fwd = Array(s[0..<3]); n = Int(s[3]) }
    }

    /// `latest` supplies (mph, forward gear 2+ engaged) each time a motion sample arrives.
    func start(_ latest: @escaping @MainActor () -> (Double?, Bool)) {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 0.05
        manager.startDeviceMotionUpdates(to: .main) { [weak self] m, _ in
            guard let m else { return }
            let u = m.userAcceleration, t = m.timestamp * 1000   // in g, gravity removed
            Task { @MainActor in
                guard let self else { return }
                let (mph, fwdGear) = latest()
                self.update(t: t, mph: mph, acc: [u.x * 9.81, u.y * 9.81, u.z * 9.81], forwardGear: fwdGear)
            }
        }
    }
    func stop() { manager.stopDeviceMotionUpdates() }

    @discardableResult
    func update(t: Double, mph: Double?, acc: [Double], forwardGear: Bool) -> Bool {
        let dt = lastT.map { min(0.2, (t - $0) / 1000) } ?? 0
        lastT = t
        let k = 1 - exp(-dt / 0.25)
        for i in 0..<3 { a[i] += (acc[i] - a[i]) * k }
        guard let mph else { return reverse }

        speeds.append((t, mph))
        while speeds.count > 2, t - speeds[0].t > 600 { speeds.removeFirst() }
        let span = (t - speeds[0].t) / 1000
        let dvdt = span > 0.3 ? (mph - speeds[0].mph) * 0.44704 / span : 0

        if forwardGear, mph > 8, abs(dvdt) > 0.6 {
            let len = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).squareRoot()
            if len > 0.3 {
                let w: Double = dvdt > 0 ? 1 : -1
                for i in 0..<3 { fwd[i] = fwd[i] * 0.995 + w * a[i] / len }
                n = min(10000, n + 1)
                if t - lastSave > 30_000 { lastSave = t; UserDefaults.standard.set(fwd + [Double(n)], forKey: Self.key) }
            }
        }

        if mph < 0.5 {
            if stoppedSince == nil { stoppedSince = t }
            if let s = stoppedSince, t - s > 400 { reverse = false; vel = 0; decided = false }
            return reverse
        }
        stoppedSince = nil
        let l = (fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]).squareRoot()
        if !decided, learned, l > 1 {
            vel += (a[0] * fwd[0] + a[1] * fwd[1] + a[2] * fwd[2]) / l * dt
            let real = mph * 0.44704
            if real >= 0.7 {
                if vel < -0.35 { reverse = true; decided = true }
                else if vel > 0.35 || real > 4 { reverse = false; decided = true }
            }
        }
        if reverse, forwardGear, mph > 6 { reverse = false }
        return reverse
    }
}
