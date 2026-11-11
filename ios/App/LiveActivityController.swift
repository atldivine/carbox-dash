import ActivityKit
import Foundation

/// Starts, updates and ends the "Drive" Live Activity. On iOS 26+ it also appears on the CarPlay
/// Dashboard with no CarPlay entitlement needed. Updates are sent only when something changed.
@MainActor
final class LiveActivityController {
    private var activity: Activity<DriveAttributes>?
    private var last: DriveAttributes.ContentState?

    func start() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
        // Reuse one that survived an app relaunch instead of stacking a second card.
        if let existing = Activity<DriveAttributes>.activities.first { activity = existing; return }
        let state = DriveAttributes.ContentState(gear: "N", speedMph: 0, rpm: 0, boostPsi: nil, afr: nil, coolantF: nil,
                                                  peakBoostPsi: nil, warning: nil, paused: false)
        activity = try? Activity.request(attributes: DriveAttributes(startedAt: Date()), content: .init(state: state, staleDate: nil))
    }

    func update(from t: Telemetry) {
        guard let activity else { return }
        let s = DriveAttributes.ContentState(
            gear: t.gear,
            speedMph: Int((t.get("speed") ?? 0).rounded()),
            rpm: Int(((t.get("rpm") ?? 0) / 50).rounded() * 50),                // 50 rpm steps: fewer pointless updates
            boostPsi: t.get("boost").map { ($0 * 2).rounded() / 2 },
            afr: t.get("afr").map { ($0 * 10).rounded() / 10 },
            coolantF: t.get("coolant").map { Int($0.rounded()) },
            peakBoostPsi: t.peaks["boost"].map { ($0 * 10).rounded() / 10 },
            warning: t.warning,
            paused: t.paused)
        guard s != last else { return }
        last = s
        Task { await activity.update(.init(state: s, staleDate: Date().addingTimeInterval(30))) }
    }

    func end() {
        guard let activity else { return }
        let a = activity; self.activity = nil; last = nil
        Task { await a.end(nil, dismissalPolicy: .default) }
    }
}
