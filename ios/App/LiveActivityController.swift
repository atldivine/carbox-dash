import ActivityKit
import Foundation

/// Starts, updates and ends the "Drive" Live Activity. On iOS 26+ it also appears on the CarPlay
/// Dashboard with no CarPlay entitlement needed. Updates are sent only when something changed.
///
/// iOS only lets an app START a Live Activity while it is on screen, and ends them on its own after
/// hours or when swiped away. So start() is retried every time the app comes to the front, and an
/// activity that is no longer active is dropped and replaced instead of being updated into the void.
@MainActor
final class LiveActivityController {
    private var activity: Activity<DriveAttributes>?
    private var last: DriveAttributes.ContentState?

    func start() {
        if let a = activity, a.activityState != .active { activity = nil; last = nil }
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
        // Reuse one that survived an app relaunch instead of stacking a second card; clear out dead ones.
        for a in Activity<DriveAttributes>.activities where a.activityState != .active { Task { await a.end(nil, dismissalPolicy: .immediate) } }
        if let existing = Activity<DriveAttributes>.activities.first(where: { $0.activityState == .active }) { activity = existing; return }
        let state = DriveAttributes.ContentState(gear: "N", speedMph: 0, rpm: 0, boostPsi: nil, afr: nil, coolantF: nil,
                                                  peakBoostPsi: nil, warning: nil, paused: false, car: nil)
        do { activity = try Activity.request(attributes: DriveAttributes(startedAt: Date()), content: .init(state: state, staleDate: nil)) }
        catch { NSLog("CARBOX live activity not started: %@", error.localizedDescription) }   // e.g. app not on screen yet
    }

    func update(from t: Telemetry) {
        guard let activity else { return }
        if activity.activityState != .active { self.activity = nil; last = nil; return }   // ended by iOS or swiped away
        let s = DriveAttributes.ContentState(
            gear: t.gear,
            speedMph: Int((t.get("speed") ?? 0).rounded()),
            rpm: Int(((t.get("rpm") ?? 0) / 50).rounded() * 50),                // 50 rpm steps: fewer pointless updates
            boostPsi: t.get("boost").map { ($0 * 2).rounded() / 2 },
            afr: t.get("afr").map { ($0 * 10).rounded() / 10 },
            coolantF: t.get("coolant").map { Int($0.rounded()) },
            peakBoostPsi: t.peaks["boost"].map { ($0 * 10).rounded() / 10 },
            warning: t.warning,
            paused: t.paused,
            car: t.car.short)
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
