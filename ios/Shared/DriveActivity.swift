import ActivityKit
import Foundation

/// The Live Activity shown on the Lock Screen, Dynamic Island and (iOS 26+) the CarPlay Dashboard.
struct DriveAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var gear: String
        var speedMph: Int
        var rpm: Int
        var boostPsi: Double?
        var afr: Double?
        var coolantF: Int?
        var peakBoostPsi: Double?
        var warning: String?      // "KNOCK", "LEAN", "HOT" or nil
        var paused: Bool
        var car: String?          // "Z", "INTEGRA"...
    }
    var startedAt: Date
}

/// Summary of the last drive, written by the app and read by the widget (App Group storage).
struct DriveSummary: Codable {
    var endedAt: Date
    var miles: Double
    var peakBoostPsi: Double?
    var peakRpm: Int?
    var best0to60: Double?
    var shifts: Int

    static let appGroup = "group.com.jhon.carbox"
    private static let key = "lastDrive"

    static func load() -> DriveSummary? {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(DriveSummary.self, from: data)
    }
    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults(suiteName: Self.appGroup)?.set(data, forKey: Self.key)
    }
}
