import Foundation
import UIKit

/// Test recording: everything needed to replay a drive and find what went wrong, in one text file.
/// One JSON object per line, `t` = seconds since the start, `y` = what the line is:
///   meta  car profile, adapter, app / iOS version (first line)
///   v     one reading as it arrived: k = signal, v = value
///   bus   one raw adapter line (requests and replies)
///   gear  gear shown by the native side (CarPlay / Live Activity): g, k = learned gearing correction
///   rev   reverse on / off;  acc  phone acceleration (m/s^2, 10 a second);  learn  reverse-sensor progress
///   ui    from the screen: gear shown, frame rate, slowest frame, tab, settings
///   mark  you tapped MARK (something felt wrong right then);  err  a page error;  end
/// Saved in Documents (Files app > On My iPhone > Carbox Dash) as carbox-test-<date>.txt.
@MainActor
final class Recorder {
    static let shared = Recorder()
    private(set) var on = false
    private(set) var url: URL?
    private(set) var lastURL: URL?
    private(set) var bytes = 0, marks = 0
    private var started = Date(), buf = "", stopping = false
    private var handle: FileHandle?
    private var flushTimer: Timer?
    /// Stops on its own at this size (~45 min of driving) so the file stays small enough to upload.
    static let maxBytes = 25_000_000

    var elapsed: Double { on ? Date().timeIntervalSince(started) : 0 }

    func start(meta: [String: Any]) {
        guard !on else { return }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let u = dir.appendingPathComponent("carbox-test-\(f.string(from: Date())).txt")
        FileManager.default.createFile(atPath: u.path, contents: nil)
        handle = try? FileHandle(forWritingTo: u)
        url = u; started = Date(); bytes = 0; marks = 0; buf = ""; stopping = false; on = true
        var m = meta; m["y"] = "meta"; m["started"] = ISO8601DateFormatter().string(from: started)
        write(m)
        flushTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.flush() } }
    }

    func write(_ obj: [String: Any]) {
        guard on else { return }
        var o = obj
        o["t"] = (Date().timeIntervalSince(started) * 1000).rounded() / 1000
        guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o),
              let s = String(data: d, encoding: .utf8) else { return }
        buf += s; buf += "\n"; bytes += d.count + 1
        if bytes > Self.maxBytes, !stopping { _ = stop() }
    }

    func mark(_ note: String?) { marks += 1; write(["y": "mark", "n": marks, "note": note ?? ""]) }

    private func flush() {
        guard let handle, !buf.isEmpty, let d = buf.data(using: .utf8) else { return }
        handle.write(d); buf = ""
    }

    /// Finishes the file and returns it.
    func stop() -> URL? {
        guard on else { return nil }
        stopping = true
        write(["y": "end", "bytes": bytes, "marks": marks])
        flush()
        on = false
        try? handle?.close(); handle = nil
        flushTimer?.invalidate(); flushTimer = nil
        lastURL = url
        return url
    }

    /// Opens the iOS share sheet for a recording (Save to Files, AirDrop, Messages, the Claude app...).
    static func share(_ url: URL) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.filter { $0.session.role == .windowApplication }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              var top = scene.keyWindow?.rootViewController ?? scene.windows.first?.rootViewController else { return }
        while let p = top.presentedViewController { top = p }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        vc.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 40, width: 1, height: 1)
        top.present(vc, animated: true)
    }
}

/// Rounds for the recording (keeps the file small; 3 decimals is plenty for every signal).
func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
