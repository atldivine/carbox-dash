import ActivityKit
import SwiftUI
import WidgetKit

// Widget extension: the "Drive" Live Activity and a "Last drive" widget. On iOS 26+ both can show on
// the CarPlay Dashboard (no CarPlay entitlement needed). Colours follow the app: graphite + red.

private let red = Color(red: 1, green: 38 / 255, blue: 62 / 255)
private let dim = Color(white: 0.55)

@main
struct CarboxWidgetBundle: WidgetBundle {
    var body: some Widget {
        DriveLiveActivity()
        LastDriveWidget()
    }
}

// MARK: Live Activity

struct DriveLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DriveAttributes.self) { context in
            DriveCard(s: context.state)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Big(label: "GEAR", value: s.gear) }
                DynamicIslandExpandedRegion(.trailing) { Big(label: "MPH", value: "\(s.speedMph)") }
                DynamicIslandExpandedRegion(.bottom) { Stats(s: s) }
            } compactLeading: {
                Text(s.gear).font(.system(.body, design: .monospaced).weight(.bold)).foregroundStyle(red)
            } compactTrailing: {
                Text(s.boostPsi.map { String(format: "%.0f", $0) } ?? "--").font(.system(.body, design: .monospaced))
            } minimal: {
                Text(s.gear).foregroundStyle(red)
            }
        }
        .supplementalActivityFamilies([.small])   // the compact card used by Apple Watch and CarPlay
    }
}

/// Lock Screen / CarPlay card.
struct DriveCard: View {
    let s: DriveAttributes.ContentState
    @Environment(\.activityFamily) private var family
    var body: some View {
        if family == .small {
            HStack(spacing: 10) {
                Big(label: "GEAR", value: s.gear)
                VStack(alignment: .leading, spacing: 2) {
                    Row(k: "BOOST", v: s.boostPsi.map { String(format: "%.1f", $0) } ?? "--")
                    Row(k: "AFR", v: s.afr.map { String(format: "%.1f", $0) } ?? "--")
                    if let w = s.warning { Text(w).font(.caption2.weight(.bold)).foregroundStyle(red) }
                }
            }.padding(8)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Z  CARBOX").font(.system(.caption, design: .monospaced).weight(.semibold)).foregroundStyle(red)
                    Spacer()
                    if s.paused { Tag("PAUSED") } else if let w = s.warning { Tag(w) }
                }
                HStack(alignment: .bottom, spacing: 18) {
                    Big(label: "GEAR", value: s.gear)
                    Big(label: "MPH", value: "\(s.speedMph)")
                    Big(label: "RPM", value: s.rpm.formatted())
                }
                Stats(s: s)
            }.padding(14)
        }
    }
}

private struct Stats: View {
    let s: DriveAttributes.ContentState
    var body: some View {
        HStack(spacing: 14) {
            Row(k: "BOOST", v: s.boostPsi.map { String(format: "%.1f", $0) } ?? "--")
            Row(k: "AFR", v: s.afr.map { String(format: "%.1f", $0) } ?? "--")
            Row(k: "CLT", v: s.coolantF.map { "\($0)°" } ?? "--")
            Row(k: "PK", v: s.peakBoostPsi.map { String(format: "%.1f", $0) } ?? "--")
        }
    }
}

private struct Big: View {
    let label: String, value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.system(size: 9, design: .monospaced)).foregroundStyle(dim)
            Text(value).font(.system(size: 30, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(.white)
        }
    }
}

private struct Row: View {
    let k: String, v: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(k).font(.system(size: 9, design: .monospaced)).foregroundStyle(dim)
            Text(v).font(.system(.callout, design: .monospaced)).monospacedDigit().foregroundStyle(.white)
        }
    }
}

private struct Tag: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text).font(.system(size: 10, weight: .bold, design: .monospaced)).padding(.horizontal, 6).padding(.vertical, 2)
            .background(red).foregroundStyle(.white)
    }
}

// MARK: Last drive widget

struct LastDriveEntry: TimelineEntry { let date: Date; let summary: DriveSummary? }

struct LastDriveProvider: TimelineProvider {
    func placeholder(in context: Context) -> LastDriveEntry {
        LastDriveEntry(date: .now, summary: DriveSummary(endedAt: .now, miles: 12.4, peakBoostPsi: 19.2, peakRpm: 6800, best0to60: 4.6, shifts: 14))
    }
    func getSnapshot(in context: Context, completion: @escaping (LastDriveEntry) -> Void) {
        completion(LastDriveEntry(date: .now, summary: DriveSummary.load() ?? placeholder(in: context).summary))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LastDriveEntry>) -> Void) {
        completion(Timeline(entries: [LastDriveEntry(date: .now, summary: DriveSummary.load())], policy: .after(.now.addingTimeInterval(1800))))
    }
}

struct LastDriveWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LastDrive", provider: LastDriveProvider()) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Text("LAST DRIVE").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(red)
                if let s = entry.summary {
                    Row(k: "PEAK BOOST", v: s.peakBoostPsi.map { String(format: "%.1f psi", $0) } ?? "--")
                    Row(k: "BEST 0-60", v: s.best0to60.map { String(format: "%.2f s", $0) } ?? "--")
                    Row(k: "TRIP", v: String(format: "%.1f mi", s.miles))
                } else {
                    Text("No drives yet").font(.caption).foregroundStyle(dim)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .containerBackground(Color.black, for: .widget)
        }
        .configurationDisplayName("Last drive")
        .description("Peak boost, best 0-60 and trip from your last drive.")
        .supportedFamilies([.systemSmall])
    }
}
