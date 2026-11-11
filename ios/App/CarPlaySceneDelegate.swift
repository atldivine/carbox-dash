import CarPlay
import UIKit

/// CarPlay screens for a Driving Task app. Apple only allows its own templates here (no custom
/// drawing), so the dash becomes:
///   LIVE     — information template: gear, speed, rpm, boost, AFR, temps, refreshed every second
///   SESSION  — list: peaks, best 0-60, trip, shifts
///   CONTROLS — grid: pause OBD (flash safe), data source, datalog, reset peaks
/// Needs the com.apple.developer.carplay-driving-task entitlement approved by Apple.
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interface: CPInterfaceController?
    private var timer: Timer?
    private let live = CPInformationTemplate(title: "Live", layout: .twoColumn, items: [], actions: [])
    private let session = CPListTemplate(title: "Session", sections: [])
    private var controls: CPGridTemplate!
    private var model: AppModel { AppModel.shared }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        interface = interfaceController
        model.boot()   // CarPlay can launch the app with no phone UI open
        controls = makeControls()
        // Root is a plain list (allowed in every CarPlay category); each row opens one screen.
        func row(_ title: String, _ detail: String, _ symbol: String, _ screen: CPTemplate) -> CPListItem {
            let item = CPListItem(text: title, detailText: detail, image: UIImage(systemName: symbol))
            item.accessoryType = .disclosureIndicator
            item.handler = { [weak self] _, done in
                Task { @MainActor in self?.refresh(); self?.interface?.pushTemplate(screen, animated: true, completion: nil); done() }
            }
            return item
        }
        let root = CPListTemplate(title: "Carbox Dash", sections: [CPListSection(items: [
            row("Live", "Gear, speed, boost, AFR, temps", "gauge.with.dots.needle.67percent", live),
            row("Session", "Peaks, best 0-60, trip", "flag.checkered", session),
            row("Controls", "Pause OBD, source, datalog", "slider.horizontal.3", controls),
        ])])
        interfaceController.setRootTemplate(root, animated: false, completion: nil)
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        timer?.invalidate(); timer = nil; interface = nil
        model.endDrive()   // car off: save the "last drive" summary for the widget
    }

    private func fmt(_ v: Double?, _ dec: Int = 0, _ unit: String = "") -> String {
        guard let v else { return "--" }
        return String(format: "%.\(dec)f", v) + unit
    }

    private func refresh() {
        let t = model.telemetry
        var items = [
            CPInformationItem(title: "Gear", detail: t.gear),
            CPInformationItem(title: "Speed", detail: fmt(t.get("speed"), 0, " mph")),
            CPInformationItem(title: "RPM", detail: fmt(t.get("rpm"))),
            CPInformationItem(title: "Boost", detail: fmt(t.get("boost"), 1, " psi")),
            CPInformationItem(title: "AFR", detail: fmt(t.get("afr"), 1)),
            CPInformationItem(title: "Coolant", detail: fmt(t.get("coolant"), 0, "°F")),
            CPInformationItem(title: "Intake", detail: fmt(t.get("iat"), 0, "°F")),
            CPInformationItem(title: "Battery", detail: fmt(t.get("battery"), 1, " V")),
        ]
        if let w = t.warning { items.insert(CPInformationItem(title: "Warning", detail: w), at: 0) }
        if t.paused { items.insert(CPInformationItem(title: "OBD", detail: "Paused (flash safe)"), at: 0) }
        live.items = items

        let p = t.peaks
        let rows = [
            ("Peak boost", fmt(p["boost"], 1, " psi")), ("Peak RPM", fmt(p["rpm"])), ("Peak intake", fmt(p["iat"], 0, "°F")),
            ("Best 0-60", t.best0to60.map { String(format: "%.2f s", $0) } ?? "--"),
            ("Trip", String(format: "%.1f mi", t.trip)), ("Shifts", "\(t.shifts)"),
            ("Source", "\(t.source.rawValue.uppercased()) · \(t.status)"),
        ].map { CPListItem(text: $0.0, detailText: $0.1) }
        session.updateSections([CPListSection(items: rows)])

        // Keep the control labels in sync with state.
        if let c = controls { c.updateGridButtons(gridButtons()) }
    }

    private func makeControls() -> CPGridTemplate { CPGridTemplate(title: "Controls", gridButtons: gridButtons()) }

    private func gridButtons() -> [CPGridButton] {
        let t = model.telemetry
        func button(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> CPGridButton {
            CPGridButton(titleVariants: [title], image: UIImage(systemName: symbol) ?? UIImage()) { _ in
                Task { @MainActor in action(); self.refresh() }
            }
        }
        return [
            button(t.paused ? "Resume OBD" : "Pause OBD", t.paused ? "play.circle" : "pause.circle") { self.model.telemetry.paused.toggle() },
            button(t.source == .sim ? "Use adapter" : "Use simulator", "antenna.radiowaves.left.and.right") { self.model.toggleSource() },
            button(t.logging ? "Stop log" : "Start log", t.logging ? "stop.circle" : "record.circle") { self.model.toggleLog() },
            button("Reset peaks", "arrow.counterclockwise") { self.model.telemetry.resetPeaks() },
        ]
    }
}
