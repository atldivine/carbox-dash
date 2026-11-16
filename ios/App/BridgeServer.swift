import Foundation
import Network

/// Local web server for browsers on this iPhone (CarTV on CarPlay, Safari). iPhone browsers can't use
/// Bluetooth, so the app reads the OBD adapter and hands the data over here:
///   http://localhost:8787/        the dash (same files as the in-app page)
///   GET  /live                    live data as Server-Sent Events, the same payload the in-app page gets
///   POST /cmd  (X-Carbox: 1)      the page's button commands (pick adapter, pause OBD, read codes...)
/// Loopback only: nothing on Wi-Fi can reach it. The custom header on /cmd stops other websites open in
/// a browser from sending commands (it forces a CORS preflight this server never approves).
final class BridgeServer {
    static let shared = BridgeServer()
    static let port: UInt16 = 8787
    private var listener: NWListener?
    private var streams: [ObjectIdentifier: NWConnection] = [:]
    private var timer: Timer?
    private var busSent = 0
    private var lastSent = Date.distantPast
    private var pendingEvents: [String] = []

    func start() {
        guard listener == nil, let port = NWEndpoint.Port(rawValue: Self.port) else { return }
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        do {
            let l = try NWListener(using: params, on: port)
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.stateUpdateHandler = { state in NSLog("CARBOX bridge %@", "\(state)") }
            l.start(queue: .main)
            listener = l
        } catch { NSLog("CARBOX bridge could not listen: %@", error.localizedDescription) }
        // ~20 updates a second to any connected browser (only while one is connected)
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.broadcast() }
    }

    // MARK: HTTP
    private func accept(_ c: NWConnection) {
        c.start(queue: .main)
        read(c, Data())
    }
    private func read(_ c: NWConnection, _ buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            var b = buffer
            if let data { b.append(data) }
            guard let end = b.range(of: Data("\r\n\r\n".utf8)) else {
                if !done, error == nil, b.count < 65_536 { self.read(c, b) } else { c.cancel() }
                return
            }
            let head = String(decoding: b[..<end.lowerBound], as: UTF8.self)
            let lines = head.components(separatedBy: "\r\n")
            let first = lines.first?.split(separator: " ") ?? []
            let method = first.count > 0 ? String(first[0]) : "", path = first.count > 1 ? String(first[1]) : "/"
            var headers: [String: String] = [:]
            for l in lines.dropFirst() {
                let p = l.split(separator: ":", maxSplits: 1)
                if p.count == 2 { headers[p[0].trimmingCharacters(in: .whitespaces).lowercased()] = p[1].trimmingCharacters(in: .whitespaces) }
            }
            let length = Int(headers["content-length"] ?? "0") ?? 0
            let body = b[end.upperBound...]
            if body.count < length, !done, error == nil, length < 1_000_000 { self.read(c, b); return }
            self.handle(c, method, path, headers, Data(body.prefix(length)))
        }
    }

    private func respond(_ c: NWConnection, _ status: String, _ type: String, _ body: Data) {
        var head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        if body.isEmpty { head = head.replacingOccurrences(of: "Content-Type: \(type)\r\n", with: "") }
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }

    private func handle(_ c: NWConnection, _ method: String, _ rawPath: String, _ headers: [String: String], _ body: Data) {
        let path = rawPath.split(separator: "?").first.map(String.init) ?? "/"
        switch (method, path) {
        case ("GET", "/live"):
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: carbox\n\n"
            c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            let key = ObjectIdentifier(c)
            streams[key] = c
            busSent = 0
            c.stateUpdateHandler = { [weak self] state in
                switch state { case .failed, .cancelled: self?.streams[key] = nil; default: break }
            }
        case ("POST", "/cmd"):
            let origin = headers["origin"] ?? "", okOrigin = origin.isEmpty || origin.hasPrefix("http://localhost:\(Self.port)") || origin.hasPrefix("http://127.0.0.1:\(Self.port)")
            guard headers["x-carbox"] == "1", okOrigin,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                respond(c, "403 Forbidden", "text/plain", Data("forbidden".utf8)); return
            }
            Task { @MainActor in self.dispatch(json) }
            respond(c, "204 No Content", "text/plain", Data())
        case ("GET", _), ("HEAD", _):
            serveFile(c, path == "/" ? "/index.html" : path)
        default:
            respond(c, "405 Method Not Allowed", "text/plain", Data("method not allowed".utf8))
        }
    }

    private func serveFile(_ c: NWConnection, _ path: String) {
        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else { respond(c, "404 Not Found", "text/plain", Data()); return }
        let clean = (path.removingPercentEncoding ?? path).replacingOccurrences(of: "..", with: "")
        let file = root.appendingPathComponent(String(clean.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            respond(c, "404 Not Found", "text/plain", Data("not found".utf8)); return
        }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css", "json": "application/json",
                     "png": "image/png", "svg": "image/svg+xml", "ttf": "font/ttf", "dbc": "text/plain", "txt": "text/plain"]
        respond(c, "200 OK", types[file.pathExtension.lowercased()] ?? "application/octet-stream", data)
    }

    // MARK: live data
    private func send(_ json: String) {
        let chunk = Data("data: \(json)\n\n".utf8)
        for c in streams.values { c.send(content: chunk, completion: .contentProcessed { _ in }) }
    }
    func sendEvent(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        send(json)
    }
    private func broadcast() {
        guard !streams.isEmpty else { return }
        Task { @MainActor in
            var sent = self.busSent
            let payload = Self.makePayload(busSent: &sent)
            self.busSent = sent
            self.sendEvent(["push": payload])
        }
    }

    /// The live-data frame the page expects (shared by the localhost bridge and the online relay).
    /// `busSent` is the caller's own bus-log cursor, so each consumer gets every new adapter-traffic line once.
    @MainActor static func makePayload(busSent: inout Int) -> [String: Any] {
        let model = AppModel.shared, t = model.telemetry
        var v: [String: Double] = [:]
        for k in Telemetry.keys { if let x = t.get(k) { v[k] = x } }
        var payload: [String: Any] = ["v": v, "source": t.source.rawValue, "status": t.status, "paused": t.paused,
                                      "error": model.lastError ?? "", "adapter": model.adapterInfo, "scanning": model.scanning,
                                      "relay": RelayUplink.shared.state.rawValue]
        for (k, x) in PhoneSensors.shared.payload { payload[k] = x }
        let fresh = t.busCount - busSent
        if fresh > 0 { payload["bus"] = Array(t.busLog.suffix(min(fresh, t.busLog.count))); busSent = t.busCount }
        if model.scanning {
            payload["devices"] = model.devices.map { ["id": $0.id, "name": $0.name, "rssi": $0.rssi, "likely": $0.likelyOBD, "ecutek": $0.ecutek] }
        }
        return payload
    }

    // MARK: commands from the browser (same set as the in-app page)
    @MainActor func dispatch(_ body: [String: Any]) {
        let model = AppModel.shared
        switch body["cmd"] as? String ?? "" {
        case "source": model.toggleSource()
        case "pause": model.telemetry.paused.toggle()
        case "log": model.toggleLog()
        case "resetTrip": model.telemetry.resetTrip()
        case "resetPeaks": model.telemetry.resetPeaks()
        case "scan": model.openPicker()
        case "cancelScan": model.cancelPicker()
        case "connect": if let id = body["id"] as? String { model.connect(id) }
        case "forget": model.forgetAdapter()
        case "relay":   // start / stop uploading to the online dash (only from the in-app page, never from the relay)
            RelayUplink.shared.configure(on: body["on"] as? Bool ?? false, host: body["host"] as? String, key: body["key"] as? String)
        case "sim": model.useSimulator()
        case "trans":
            if let v = body["value"] as? String, ["auto", "6MT", "9AT"].contains(v) { model.telemetry.trans = v; UserDefaults.standard.set(v, forKey: "carbox.trans") }
        case "obd":
            guard let id = body["id"] as? Int, let req = body["req"] as? String else { return }
            Task { @MainActor in
                var text = "", err = ""
                do { text = try await model.rawOBD(req) } catch { err = error.localizedDescription }
                self.sendEvent(["reply": ["id": id, "text": text, "error": err]])
            }
        default: break
        }
    }
}
