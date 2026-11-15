import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// The phone UI is the web dash (index.html + js/ + fonts/ + data/), bundled in the app as "web".
/// It's served through a custom carbox:// scheme because ES modules don't load from file:// URLs.
/// Native code pushes telemetry in with `carboxNative.push(...)`; the page sends commands back
/// through the `carbox` message handler.
struct DashWebView: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "carbox")
        cfg.userContentController.add(context.coordinator, name: "carbox")
        // Report page errors to the native log (read by the simulator test in CI and by Xcode).
        cfg.userContentController.addUserScript(WKUserScript(source: """
            addEventListener('error', (e) => webkit.messageHandlers.carbox.postMessage({ cmd: 'jsError', msg: e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno }));
            addEventListener('unhandledrejection', (e) => webkit.messageHandlers.carbox.postMessage({ cmd: 'jsError', msg: 'promise: ' + (e.reason && e.reason.message || e.reason) }));
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: URL(string: "carbox://app/index.html")!))
        return web
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let model: AppModel
        weak var web: WKWebView?
        private var observers: [NSObjectProtocol] = []
        private var busSent = 0
        private var lastPush = Date.distantPast

        init(model: AppModel) {
            self.model = model
            super.init()
            // New OBD values go to the page the moment they arrive (~20 a second with a fast adapter).
            // The 10 Hz tick still pushes when nothing new came in (status changes, adapter picker).
            observers.append(NotificationCenter.default.addObserver(forName: .telemetrySample, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.push() }
            })
            observers.append(NotificationCenter.default.addObserver(forName: .telemetryTick, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in if let self, Date().timeIntervalSince(self.lastPush) > 0.08 { self.push() } }
            })
        }

        /// Launch arguments for testing: `-carboxScreen tach -carboxLook RACEDASH` opens that tab / look.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("CARBOX page loaded")
            let d = UserDefaults.standard
            var js = ""
            if let look = d.string(forKey: "carboxLook") { js += "carbox.pref.gauge.look = '\(look)';" }
            if let view = d.string(forKey: "carboxView") { js += "carbox.wire.setView('\(view)');" }
            if let screen = d.string(forKey: "carboxScreen") { js += "carbox.setScreen('\(screen)');" }
            if !js.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { webView.evaluateJavaScript(js) { _, err in if let err { NSLog("CARBOX JSERROR launch-args: %@", err.localizedDescription) } } }
            }
        }

        /// Sends the latest values to the page (on every new sample; the page eases between them).
        private func push() {
            guard let web else { return }
            lastPush = Date()
            let t = model.telemetry
            var v: [String: Double] = [:]
            for k in Telemetry.keys { if let x = t.get(k) { v[k] = x } }
            let rec = Recorder.shared
            var payload: [String: Any] = ["rec": ["on": rec.on, "secs": rec.elapsed, "bytes": rec.bytes, "marks": rec.marks,
                                                  "last": rec.lastURL?.lastPathComponent ?? ""],
                                          "v": v, "age": t.ages(), "pidState": model.pidState, "rev": t.reverseSensor.reverse, "revReady": t.reverseSensor.learned, "source": t.source.rawValue, "status": t.status, "paused": t.paused,
                                          "error": model.lastError ?? "", "adapter": model.adapterInfo, "scanning": model.scanning]
            let fresh = t.busCount - busSent
            if fresh > 0 { payload["bus"] = Array(t.busLog.suffix(min(fresh, t.busLog.count))); busSent = t.busCount }
            if model.scanning {
                payload["devices"] = model.devices.map { ["id": $0.id, "name": $0.name, "rssi": $0.rssi, "likely": $0.likelyOBD, "note": $0.note ?? "", "ecutek": $0.ecutek] }
            }
            guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
            web.evaluateJavaScript("window.carboxNative && window.carboxNative.push(\(json))")
        }

        func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
            switch cmd {
            case "source": model.toggleSource()
            case "pause": model.telemetry.paused.toggle()
            case "log", "rec": model.toggleLog()
            case "theme": if let a = body["accent"] as? String { UserDefaults.standard.set(a, forKey: "carbox.accent") }
            case "mark": Recorder.shared.mark(body["note"] as? String)
            case "recUI": if Recorder.shared.on { var o = body; o["cmd"] = nil; o["y"] = "ui"; Recorder.shared.write(o) }
            case "shareRec": if let u = Recorder.shared.lastURL { Recorder.share(u) }
            case "resetTrip": model.telemetry.resetTrip()
            case "resetPeaks": model.telemetry.resetPeaks()
            case "jsError":
                NSLog("CARBOX JSERROR %@", (body["msg"] as? String) ?? "?")
                Recorder.shared.write(["y": "err", "m": (body["msg"] as? String) ?? "?"])
            case "ready": NSLog("CARBOX ready %@", (body["info"] as? String) ?? "")
            case "scan": model.openPicker()
            case "cancelScan": model.cancelPicker()
            case "connect": if let id = body["id"] as? String { model.connect(id) }
            case "forget": model.forgetAdapter()
            case "sim": model.useSimulator()
            case "car": if let id = body["car"] as? String ?? body["id"] as? String { model.telemetry.setCar(id) }
            default: break
            }
        }
    }
}

/// Serves files from the app bundle's "web" folder for carbox://app/<path>.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        var path = url.path; if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let type = file.pathExtension == "js" ? "text/javascript" : mime
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type, "Cache-Control": "no-store"])!)
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
