import Foundation
import CoreMotion
import CoreLocation

/// The phone's own motion sensor and GPS, for the HANDLING tab (G-forces, yaw, level, drift angle),
/// launch timing without OBD speed, and the route map on the DRIVES tab. Raw device-frame values go
/// to the web page, which turns them into the car's frame (js/sensors.js).
@MainActor
final class PhoneSensors: NSObject, CLLocationManagerDelegate {
    static let shared = PhoneSensors()
    private let motion = CMMotionManager()
    private let location = CLLocationManager()
    private(set) var imu: [String: [Double]]?          // a: user accel (g), g: gravity (g), r: rotation (rad/s)
    private(set) var gps: [String: Double]?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        if motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 1.0 / 30
            motion.startDeviceMotionUpdates(to: .main) { [weak self] m, _ in
                guard let m else { return }
                let a = m.userAcceleration, g = m.gravity, r = m.rotationRate
                let sample = ["a": [a.x, a.y, a.z], "g": [g.x, g.y, g.z], "r": [r.x, r.y, r.z]]
                Task { @MainActor in self?.imu = sample }
            }
        }
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.activityType = .automotiveNavigation
        location.requestWhenInUseAuthorization()   // shows the iOS location prompt the first time
        location.startUpdatingLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        let fix: [String: Double] = ["lat": l.coordinate.latitude, "lon": l.coordinate.longitude, "mps": l.speed,
                                     "hdg": l.course, "acc": l.horizontalAccuracy]
        Task { @MainActor in self.gps = fix }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) { manager.startUpdatingLocation() }
        }
    }

    /// Payload pieces for the page (nil when there's nothing fresh).
    var payload: [String: Any] {
        var p: [String: Any] = [:]
        if let imu { p["imu"] = imu }
        if let gps { p["gps"] = gps }
        return p
    }
}
