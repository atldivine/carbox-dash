import Foundation

/// Uploads the live car data to the online dash (relay.cjs, e.g. wss://carbox.nich.world/ingest) so any browser
/// with the key can show it, including CarTV on CarPlay (iPhone browsers can't use Bluetooth themselves).
/// The same frame the localhost bridge sends goes out about 20 times a second over one WebSocket. Button presses
/// made on the website come back down the same socket and run through BridgeServer.dispatch.
@MainActor
final class RelayUplink {
    static let shared = RelayUplink()

    enum State: String { case off, connecting, live, retry, denied }
    private(set) var state: State = .off

    private var task: URLSessionWebSocketTask?
    private var timer: Timer?
    private var wanted = false
    private var host = "carbox.nich.world"
    private var key = ""
    private var busSent = 0
    private var inflight = 0
    private var backoff = 1.0
    private let defaults = UserDefaults.standard

    /// Called when the in-app page's START / STOP button is pressed.
    func configure(on: Bool, host: String?, key: String?) {
        if let k = key?.trimmingCharacters(in: .whitespacesAndNewlines), !k.isEmpty { self.key = k }
        if let h = host?.trimmingCharacters(in: .whitespacesAndNewlines), Self.validHost(h) { self.host = h }
        defaults.set(self.key, forKey: "carbox.relayKey")
        defaults.set(self.host, forKey: "carbox.relayHost")
        defaults.set(on, forKey: "carbox.relayOn")
        if on { start() } else { stop() }
    }

    /// At launch: carry on sharing if it was on when the app last closed.
    func resume() {
        key = defaults.string(forKey: "carbox.relayKey") ?? ""
        if let h = defaults.string(forKey: "carbox.relayHost"), Self.validHost(h) { host = h }
        if defaults.bool(forKey: "carbox.relayOn"), !key.isEmpty { start() }
    }

    private static func validHost(_ h: String) -> Bool {
        !h.isEmpty && h.count < 100 && h.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
    }

    // MARK: connection
    private func start() {
        guard !key.isEmpty else { state = .off; return }
        wanted = true
        backoff = 1
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        }
        connect()
    }

    private func stop() {
        wanted = false
        timer?.invalidate(); timer = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        state = .off
    }

    private func connect() {
        guard wanted, task == nil else { return }
        let q = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
        guard let url = URL(string: "wss://\(host)/ingest?key=\(q)") else { state = .off; return }
        state = .connecting
        busSent = 0; inflight = 0
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        listen(t)
        t.sendPing { [weak self] error in          // a good pong means the handshake went through
            Task { @MainActor in
                guard let self, self.task === t else { return }
                if error == nil { self.state = .live; self.backoff = 1 }
            }
        }
    }

    private func listen(_ t: URLSessionWebSocketTask) {   // commands coming back from the website
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(let message):
                    if case .string(let s) = message,
                       let json = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any],
                       (json["cmd"] as? String) != "relay" {          // the website may not re-point the uplink
                        BridgeServer.shared.dispatch(json)
                    }
                    self.listen(t)
                case .failure:
                    self.dropped(t)
                }
            }
        }
    }

    private func dropped(_ t: URLSessionWebSocketTask) {
        guard task === t else { return }
        task = nil
        if (t.response as? HTTPURLResponse)?.statusCode == 403 { wanted = false; timer?.invalidate(); timer = nil; state = .denied; return }
        state = wanted ? .retry : .off
        guard wanted else { return }
        let wait = backoff
        backoff = min(backoff * 2, 8)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            Task { @MainActor in self?.connect() }
        }
    }

    // MARK: upload
    private func tick() {
        guard state == .live, let t = task, inflight < 4 else { return }   // never queue stale frames: skip instead
        let payload = BridgeServer.makePayload(busSent: &busSent)
        guard let data = try? JSONSerialization.data(withJSONObject: ["push": payload]),
              let text = String(data: data, encoding: .utf8) else { return }
        inflight += 1
        t.send(.string(text)) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                self.inflight = max(0, self.inflight - 1)
                if error != nil { self.dropped(t) }
            }
        }
    }
}
