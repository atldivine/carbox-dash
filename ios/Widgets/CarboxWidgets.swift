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
                DynamicIslandExpandedRegion(.leading) { MiniTach(s: s, accent: Color(hex: s.accent) ?? red).frame(width: 64, height: 64) }
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

/// Lock Screen / CarPlay card. The CarPlay Dashboard tile uses the `.small` family: a mini tach with
/// gear and speed in the middle, boost / AFR / coolant beside it, in the app's accent colour.
struct DriveCard: View {
    let s: DriveAttributes.ContentState
    @Environment(\.activityFamily) private var family
    private var accent: Color { Color(hex: s.accent) ?? red }
    var body: some View {
        if family == .small {
            HStack(spacing: 8) {
                MiniTach(s: s, accent: accent).frame(minWidth: 70, maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 3) {
                    Row(k: "BOOST", v: s.boostPsi.map { String(format: "%.1f", $0) } ?? "--")
                    Row(k: "AFR", v: s.afr.map { String(format: "%.1f", $0) } ?? "--")
                    Row(k: "CLT", v: s.coolantF.map { "\($0)°" } ?? "--")
                    if s.paused { Text("PAUSED").font(.caption2.weight(.bold)).foregroundStyle(accent) }
                    else if let w = s.warning { Text(w).font(.caption2.weight(.bold)).foregroundStyle(accent) }
                }
            }
            .padding(8)
        } else {
            HStack(spacing: 14) {
                MiniTach(s: s, accent: accent).frame(width: 96, height: 96)
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("\(s.car ?? "Z")  CARBOX").font(.system(.caption, design: .monospaced).weight(.semibold)).foregroundStyle(accent)
                        Spacer()
                        if s.paused { Tag("PAUSED", accent) } else if let w = s.warning { Tag(w, accent) }
                    }
                    Big(label: "RPM", value: s.rpm.formatted())
                    Stats(s: s)
                }
            }.padding(14)
        }
    }
}

/// Small tach: an arc from 7:30 round to 4:30 like a real dial, red zone at the end, lit up to the
/// current rpm (red past the redline). Gear big in the middle, speed under it.
struct MiniTach: View {
    let s: DriveAttributes.ContentState
    let accent: Color
    var body: some View {
        let top = Double(max(1000, s.maxRpm ?? 8000)), redFrom = Double(s.redline ?? 7000)
        let f = min(1, max(0, Double(s.rpm) / top)), rf = min(1, redFrom / top)
        let over = Double(s.rpm) >= redFrom
        GeometryReader { geo in
            let d = min(geo.size.width, geo.size.height), w = max(4, d * 0.09)
            ZStack {
                arc(0, 1).stroke(Color.white.opacity(0.12), style: StrokeStyle(lineWidth: w, lineCap: .round))
                arc(rf, 1).stroke(red.opacity(0.75), style: StrokeStyle(lineWidth: w * 0.45, lineCap: .butt))
                arc(0, max(0.004, f)).stroke(over ? red : accent, style: StrokeStyle(lineWidth: w, lineCap: .round))
                    .shadow(color: (over ? red : accent).opacity(0.6), radius: w * 0.6)
                VStack(spacing: 0) {
                    Text(s.gear).font(.system(size: d * 0.36, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        .contentTransition(.numericText())
                    Text("\(s.speedMph)").font(.system(size: d * 0.15, weight: .semibold, design: .rounded)).monospacedDigit().foregroundStyle(.white.opacity(0.85))
                        .contentTransition(.numericText())
                    Text("MPH").font(.system(size: max(7, d * 0.07), design: .monospaced)).foregroundStyle(dim)
                }
                .offset(y: d * 0.03)
            }
            .frame(width: d, height: d)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
    }
    /// Portion of the 270-degree dial between fractions a and b.
    private func arc(_ a: Double, _ b: Double) -> some Shape {
        Circle().trim(from: 0.125 + 0.75 * a, to: 0.125 + 0.75 * b).rotation(.degrees(90))
    }
}

extension Color {
    /// "#rrggbb" -> Color; nil if missing or malformed.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let n = Int(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double(n >> 16 & 255) / 255, green: Double(n >> 8 & 255) / 255, blue: Double(n & 255) / 255)
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
    let text: String, color: Color
    init(_ t: String, _ c: Color = red) { text = t; color = c }
    var body: some View {
        Text(text).font(.system(size: 10, weight: .bold, design: .monospaced)).padding(.horizontal, 7).padding(.vertical, 2)
            .background(color, in: Capsule()).foregroundStyle(.white)
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
