import CoreBluetooth
import Foundation

/// A nearby Bluetooth LE device, shown in the adapter picker.
struct FoundDevice: Codable, Equatable {
    let id: String
    let name: String
    let rssi: Int
    let likelyOBD: Bool
}

/// Bluetooth LE link to an ELM327-style OBD-II adapter: Vgate, OBDLink CX, Veepeak, Konnwei, clones,
/// and FIXD (original and 2nd-gen sensors are BLE; FIXD's channel layout isn't published). The user
/// picks the adapter from a list, so its name doesn't matter. The data channel is found by looking at
/// every service (same rules as js/ble.js chooseChannel). Keeps working with the phone locked.
final class BLELink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let knownServices = ["FFF0", "FFE0", "FFE5", "18F0", "AE00", "AE30", "FEE7", "FFB0",
                                "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
                                "49535343-FE7D-4AE5-8FA9-9FAFD205E455", "FEFB"].map(CBUUID.init(string:))
    static let notData = ["1800", "1801", "180A", "180F", "1805", "FE59", "FD6F"].map(CBUUID.init(string:))
    private static let nameHint = try! NSRegularExpression(pattern: "obd|elm|vlink|v-link|vgate|veepeak|obdlink|fixd|icar|konnwei|scan", options: .caseInsensitive)
    static let savedKey = "carbox.adapter"

    var onData: ((String) -> Void)?
    var onState: ((String) -> Void)?
    var onDevices: (([FoundDevice]) -> Void)?
    private(set) var info: [String: String] = [:]

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var tx: CBCharacteristic?
    private var txType: CBCharacteristicWriteType = .withResponse
    private var pendingServices = 0
    private var found: [UUID: (CBPeripheral, FoundDevice)] = [:]
    private var ready: CheckedContinuation<Void, Error>?
    private var powered: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionRestoreIdentifierKey: "carbox-central"])
    }

    private func waitForPower() async {
        if central.state == .poweredOn { return }
        await withCheckedContinuation { powered = $0 }
    }

    /// Lists nearby BLE devices (likely OBD adapters first) until `stopScan()`.
    func startScan() async {
        await waitForPower()
        found = [:]
        onState?("SCANNING")
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }
    func stopScan() { central.stopScan() }

    /// The adapter used last time, if iOS still knows it.
    var savedAdapter: UUID? { UserDefaults.standard.string(forKey: Self.savedKey).flatMap(UUID.init(uuidString:)) }
    func forget() { UserDefaults.standard.removeObject(forKey: Self.savedKey) }

    /// Connects to one device and finds its serial data channel.
    func connect(_ id: UUID) async throws {
        await waitForPower()
        stopScan()
        guard let p = found[id]?.0 ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
            throw Self.err("That adapter isn't in range any more. Scan again.")
        }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            ready = c
            peripheral = p; tx = nil; p.delegate = self
            info = ["name": p.name ?? found[id]?.1.name ?? "(no name)"]
            onState?("CONNECTING")
            central.connect(p)
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.fail("The adapter didn't finish connecting. Unplug it, plug it back in and try again.") }
        }
    }
    func close() { if let p = peripheral { central.cancelPeripheralConnection(p) }; peripheral = nil }

    func write(_ s: String) {
        guard let p = peripheral, let tx else { return }
        let bytes = Array(s.utf8)
        let size = max(20, p.maximumWriteValueLength(for: txType))
        stride(from: 0, to: bytes.count, by: size).forEach { p.writeValue(Data(bytes[$0..<min($0 + size, bytes.count)]), for: tx, type: txType) }
    }

    static func err(_ msg: String) -> NSError { NSError(domain: "carbox", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]) }
    private func fail(_ msg: String) {
        guard let r = ready else { return }
        ready = nil; r.resume(throwing: Self.err(msg))
    }

    // MARK: central
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        if c.state == .poweredOn, let w = powered { powered = nil; w.resume() }
        if c.state == .unauthorized || c.state == .poweredOff { onState?("BLUETOOTH OFF"); fail("Bluetooth is off or not allowed for Carbox Dash") }
    }
    func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {}
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = p.name ?? (ad[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        let uuids = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let likely = Self.nameHint.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil || uuids.contains { Self.knownServices.contains($0) }
        guard !name.isEmpty || likely else { return }   // nameless, non-OBD devices are just noise in the list
        found[p.identifier] = (p, FoundDevice(id: p.identifier.uuidString, name: name.isEmpty ? "Unnamed device" : name, rssi: rssi.intValue, likelyOBD: likely))
        let list = found.values.map(\.1).sorted { ($0.likelyOBD ? 1 : 0, $0.rssi) > ($1.likelyOBD ? 1 : 0, $1.rssi) }
        onDevices?(Array(list.prefix(30)))
    }
    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices(nil) }
    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { fail(error?.localizedDescription ?? "Could not connect") }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        onState?("DISCONNECTED")
        if p == peripheral { c.connect(p) }   // reconnect automatically when the car comes back
    }

    // MARK: peripheral
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        let services = p.services ?? []
        info["services"] = services.map(\.uuid.uuidString).joined(separator: ", ")
        pendingServices = services.count
        if services.isEmpty { fail("\(info["name"] ?? "Adapter"): no Bluetooth services visible") }
        services.forEach { p.discoverCharacteristics(nil, for: $0) }
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        pendingServices -= 1
        guard pendingServices <= 0, ready != nil else { return }
        guard let ch = Self.chooseChannel(p.services ?? []) else {
            fail("\(info["name"] ?? "Adapter"): no serial data channel found (services: \(info["services"] ?? "none")). It may not be an OBD adapter.")
            return
        }
        let rx = ch.rx, txc = ch.tx
        tx = txc
        txType = txc.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        info["channel"] = "\(rx.service?.uuid.uuidString ?? "?") rx \(rx.uuid.uuidString) tx \(txc.uuid.uuidString)"
        p.setNotifyValue(true, for: rx)
        UserDefaults.standard.set(p.identifier.uuidString, forKey: Self.savedKey)
        let r = ready; ready = nil; r?.resume()
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        if let d = ch.value { onData?(String(decoding: d, as: UTF8.self)) }
    }

    /// Same rules as js/ble.js chooseChannel: one service with notify + write (known OBD services
    /// first), standard services skipped; else notify and write paired across two services.
    static func chooseChannel(_ services: [CBService]) -> (rx: CBCharacteristic, tx: CBCharacteristic)? {
        let usable = services.filter { !notData.contains($0.uuid) }
        var best: (score: Int, rx: CBCharacteristic, tx: CBCharacteristic)?
        for s in usable {
            let chars = s.characteristics ?? []
            guard let rx = chars.first(where: { $0.properties.contains(.notify) || $0.properties.contains(.indicate) }),
                  let tx = chars.first(where: { $0.properties.contains(.writeWithoutResponse) && $0 != rx })
                    ?? chars.first(where: { $0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse) }) else { continue }
            let score = (knownServices.contains(s.uuid) ? 10 : 0) + (rx != tx ? 2 : 1) + (tx.properties.contains(.writeWithoutResponse) ? 1 : 0)
            if best == nil || score > best!.score { best = (score, rx, tx) }
        }
        if let best { return (best.rx, best.tx) }
        let rxS = usable.first { ($0.characteristics ?? []).contains { $0.properties.contains(.notify) || $0.properties.contains(.indicate) } }
        let txS = usable.first { $0 != rxS && ($0.characteristics ?? []).contains { $0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse) } }
        guard let rxS, let txS,
              let rx = rxS.characteristics?.first(where: { $0.properties.contains(.notify) || $0.properties.contains(.indicate) }),
              let tx = txS.characteristics?.first(where: { $0.properties.contains(.writeWithoutResponse) || $0.properties.contains(.write) }) else { return nil }
        return (rx, tx)
    }
}

/// ELM327 protocol: reset, setup, then Mode 01 polling. Mirrors js/elm327.js, which is tested
/// against fake adapters with echo, spaces, headers, CR+LF, split packets, slow resets, '?' replies,
/// and sensors locked to their own app (tests/adapters.test.mjs).
@MainActor
final class ELM327 {
    private let link: BLELink
    private let t: Telemetry
    private var buffer = ""
    private var waiter: (cont: CheckedContinuation<String, Error>, cmd: String, id: Int)?
    private var reqId = 0
    /// What fast mode got (shown on the BUS tab), e.g. "engine ECU direct, reply count, 3 PIDs per request".
    private(set) var fastSummary = ""
    private var running = false
    private var baro = 101.3
    private var misses: [UInt8: Int] = [:]
    private var unsupported = Set<UInt8>()
    private var sfx = ""          // "1" once the adapter takes a reply count ("010C1"): no waiting for other ECUs
    private var multi = false     // several PIDs per request ("010C0D0B11")
    private var rxBytes = 0, rxSample = "", lastRx = Date.distantPast
    private(set) var identity = ""

    static let fast: [UInt8] = [0x0C, 0x0D, 0x0B, 0x11]
    static let slow: [UInt8] = [0x05, 0x0F, 0x42, 0x0E, 0x5C, 0x52]
    /// Data bytes per PID, so a reply to several PIDs at once can be split up.
    static let pidLen: [UInt8: Int] = [0x0C: 2, 0x0D: 1, 0x05: 1, 0x0F: 1, 0x0B: 1, 0x33: 1, 0x11: 1, 0x0E: 1, 0x42: 2, 0x5C: 1, 0x52: 1]
    private static func hex(_ pids: [UInt8]) -> String { pids.map { String(format: "%02X", $0) }.joined() }

    init(link: BLELink, telemetry: Telemetry) {
        self.link = link; self.t = telemetry
        link.onData = { [weak self] s in Task { @MainActor in self?.received(s) } }
    }

    private func received(_ s: String) {
        rxBytes += s.count; lastRx = Date(); if rxSample.count < 40 { rxSample += s }
        buffer += s
        guard let r = buffer.range(of: ">"), let w = waiter else { return }
        var text = String(buffer[..<r.lowerBound]); buffer = String(buffer[r.upperBound...]); waiter = nil
        let trimmed = text.drop { $0.isWhitespace }
        if trimmed.uppercased().hasPrefix(w.cmd) { text = String(trimmed.dropFirst(w.cmd.count)) }   // echoed command
        w.cont.resume(returning: text)
    }

    private func request(_ cmd: String, timeout: Double = 1.5) async throws -> String {
        buffer = ""
        reqId += 1
        let id = reqId
        return try await withCheckedThrowingContinuation { c in
            waiter = (c, cmd.uppercased(), id)
            link.write(cmd + "\r")
            // The timer is tied to THIS request's id. Matching on the command text alone let an old
            // request's timer cancel a newer request for the same command (the batched polls repeat
            // every ~0.6 s, the same as the timeout), which showed up as a timeout about every second.
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                Task { @MainActor in
                    guard let self, let w = self.waiter, w.id == id else { return }
                    self.waiter = nil
                    w.cont.resume(throwing: BLELink.err("timeout: \(cmd)"))
                }
            }
        }
    }

    /// After a timeout the late reply would be read as the answer to the next command; wait for quiet and drop it.
    private func resync() async {
        waiter = nil
        let t0 = Date()
        while Date().timeIntervalSince(t0) < 1.0, Date().timeIntervalSince(lastRx) < 0.15 { try? await Task.sleep(nanoseconds: 20_000_000) }
        try? await Task.sleep(nanoseconds: 150_000_000)
        buffer = ""
    }
    private func ask(_ cmd: String, timeout: Double = 1.5) async throws -> String {
        do {
            let r = try await request(cmd, timeout: timeout)
            t.log("> \(cmd)  < \(tidy(r))")
            return r
        } catch { t.log("! timeout \(cmd)"); await resync(); throw error }
    }
    private func tidy(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }

    /// Call after BLELink.connect succeeded.
    func start() async throws {
        t.status = "INIT"
        var reset: String?
        for _ in 0..<2 where reset == nil {
            do { reset = try await ask("ATZ", timeout: 4) } catch { link.write("\r"); await resync() }
        }
        guard let reset else {
            throw BLELink.err(rxBytes == 0
                ? "The adapter connected but never answered OBD commands. Some sensors (FIXD among them) only talk to their own app."
                : "The adapter answered, but not like an ELM327 (it sent \"\(tidy(rxSample).prefix(30))\"). It probably only works with its own app.")
        }
        // '?' from clones is fine. ATAT2: aggressive adaptive timing (stop waiting for extra ECUs sooner).
        for c in ["ATE0", "ATL0", "ATS0", "ATH0", "ATAT2", "ATSP0"] { _ = try? await ask(c) }
        identity = (try? await ask("ATI")).map(tidy) ?? tidy(reset)
        var first: String?
        for _ in 0..<2 where first == nil { first = try? await ask("0100", timeout: 10) }
        guard let first else { throw BLELink.err("The adapter stopped answering while searching for the car. Is the ignition on?") }
        let flat = first.uppercased().filter { !$0.isWhitespace }
        if (flat.contains("UNABLE") || flat.contains("ERROR") || flat.contains("NODATA")) && !flat.contains("4100") {
            throw BLELink.err("Adapter cannot reach the ECU. Is the ignition on?")
        }
        await tune(first)
        if let text = try? await ask("0133" + sfx), let b = Self.parse(text, pid: 0x33) { baro = Double(b[0]) }
        t.source = .obd; t.status = "OBD"; running = true
        Task { await loop() }
    }
    func stop() { running = false; link.close() }

    /// Makes polling fast; same steps as js/elm327.js _tune(). Each one is probed and skipped if the
    /// adapter can't do it, so old clones work as before:
    ///  1. On CAN, talk to the engine ECU directly (ATSH7E0) so the transmission doesn't answer too.
    ///  2. End requests with the expected reply count ("010C1"). Without it the ELM327 waits
    ///     50-200 ms after every answer in case another ECU speaks: the main cause of the lag.
    ///  3. Ask for up to 6 PIDs per request: one Bluetooth round trip instead of four.
    ///  4. Read the supported-PID bitmaps so nothing is wasted on PIDs the ECU never answers.
    private func tune(_ firstReply: String) async {
        var first = firstReply
        var note: [String] = []
        var can = false, direct = false
        if let p = try? await ask("ATDPN", timeout: 1) {
            var proto = tidy(p).uppercased()
            if proto.hasPrefix("A") { proto.removeFirst() }
            can = ["6", "8"].contains(proto)   // 11-bit CAN (29-bit needs a different header)
            note.append("protocol \(proto)")
        }
        if can, let r = try? await ask("ATSH7E0", timeout: 1), r.uppercased().contains("OK") {
            if let r0 = try? await ask("0100"), Self.parseSupport(r0, base: 0x00)?.contains(0x0C) == true {
                first = r0; direct = true; note.append("engine ECU direct")
            } else { _ = try? await ask("ATSH7DF", timeout: 1) }   // ECU didn't answer directly: broadcast again
        }
        if let r = try? await ask("010C1", timeout: 1), !r.contains("?"), (Self.parse(r, pid: 0x0C)?.count ?? 0) >= 2 {
            sfx = "1"; note.append("reply count")
        }
        if var all = Self.parseSupport(first, base: 0x00) {
            for base: UInt8 in [0x20, 0x40] where all.contains(base) {
                guard let r = try? await ask(String(format: "01%02X", base) + sfx, timeout: 1) else { break }
                if let s = Self.parseSupport(r, base: base) { all.formUnion(s) }
            }
            for pid in Self.fast + Self.slow where !all.contains(pid) && pid != 0x0C && pid != 0x0D && (pid < 0x40 || all.contains(0x40)) {
                unsupported.insert(pid)
            }
        }
        // Batching only when talking to the engine ECU alone: on a broadcast the transmission may answer
        // first with just its speed, and the other values would read as missing.
        if direct {
            let pids = Self.fast.filter { !unsupported.contains($0) }
            if let r = try? await ask("01" + Self.hex(pids) + sfx, timeout: 1) {
                let got = Self.parseMulti(r)
                if pids.allSatisfy({ got[$0] != nil }) { multi = true; note.append("\(pids.count) PIDs per request") }
            }
        }
        fastSummary = note.isEmpty ? "none (basic adapter)" : note.joined(separator: ", ")
        if !unsupported.isEmpty { fastSummary += "; not offered by the car: " + unsupported.sorted().map { String(format: "%02X", $0) }.joined(separator: " ") }
        t.log("fast mode: " + fastSummary)
    }

    private func loop() async {
        var n = 0, slowAt = 0, multiFails = 0
        func slowNext(_ k: Int) -> [UInt8] {   // the next k supported slow PIDs, in rotation
            let list = Self.slow.filter { !unsupported.contains($0) }
            guard !list.isEmpty, k > 0 else { return [] }
            let out = (0..<min(k, list.count)).map { list[(slowAt + $0) % list.count] }
            slowAt = (slowAt + out.count) % list.count
            return out
        }
        func miss(_ pid: UInt8) {
            misses[pid, default: 0] += 1
            if misses[pid]! > 3, pid != 0x0C, pid != 0x0D { unsupported.insert(pid) }   // never give up on rpm/speed
        }
        while running {
            if t.paused { t.status = "PAUSED"; try? await Task.sleep(nanoseconds: 300_000_000); continue }
            t.status = "OBD"
            let fast = Self.fast.filter { !unsupported.contains($0) }
            if multi {
                // one request: the fast PIDs, plus 2 slow ones every other cycle (6 is the OBD limit)
                let pids = n % 2 == 0 ? fast + slowNext(min(2, 6 - fast.count)) : fast
                n += 1
                do {
                    let text = try await ask("01" + Self.hex(pids) + sfx, timeout: 0.6)
                    let got = Self.parseMulti(text)
                    var any = false
                    for pid in pids {
                        if let d = got[pid] { apply(pid, d); misses[pid] = 0; any = true } else { miss(pid) }
                    }
                    multiFails = any ? 0 : multiFails + 1
                } catch { multiFails += 1 }
                if multiFails >= 4 { multi = false; t.log("! batched requests stopped working; asking one PID at a time") }
                NotificationCenter.default.post(name: .telemetrySample, object: nil)
                continue
            }
            let pids = n % 4 == 0 ? fast + slowNext(1) : fast
            n += 1
            var asked = 0
            for pid in pids where running && !t.paused && !unsupported.contains(pid) {
                asked += 1
                do {
                    let text = try await ask(String(format: "01%02X", pid) + sfx, timeout: 0.6)
                    if let bytes = Self.parse(text, pid: pid) { apply(pid, bytes) } else { miss(pid) }
                } catch { /* timeouts are normal now and then; resync already ran */ }
            }
            NotificationCenter.default.post(name: .telemetrySample, object: nil)
            if asked == 0 { t.status = "NO DATA"; try? await Task.sleep(nanoseconds: 1_000_000_000) }   // never spin
        }
    }

    /// Splits a reply to a multi-PID request into [pid: bytes]. Handles the ELM327's multi-frame layout
    /// (a length line, then "0:", "1:", ... lines) and single-frame replies; only the first ECU's answer
    /// is used. Same rules as js/elm327.js parseMulti (unit-tested in tests/elm.test.mjs).
    static func parseMulti(_ text: String) -> [UInt8: [UInt8]] {
        let up = text.uppercased()
        let flat = up.filter { !$0.isWhitespace }
        if ["NODATA", "UNABLE", "ERROR", "STOPPED", "?"].contains(where: { flat.contains($0) }) { return [:] }
        let lines = up.split(whereSeparator: { $0 == "\r" || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("SEARCHING") }
        func hexOnly(_ s: Substring) -> String { String(s.filter(\.isHexDigit)) }
        let lenLine = lines.first { $0.count == 3 && $0.allSatisfy(\.isHexDigit) }
        let frames = lines.filter { l in
            guard let c = l.firstIndex(of: ":") else { return false }
            let pre = l[..<c].trimmingCharacters(in: .whitespaces)
            return pre.count == 1 && pre.first!.isHexDigit
        }
        var hex = ""
        if let lenLine, !frames.isEmpty, let len = Int(lenLine, radix: 16) {
            for f in frames {
                if f.hasPrefix("0") && !hex.isEmpty { break }   // a 2nd "0:" is another ECU
                hex += hexOnly(f[f.index(after: f.firstIndex(of: ":")!)...])
            }
            hex = String(hex.prefix(len * 2))
        } else if let l = lines.first { hex = hexOnly(Substring(l)) }
        var bytes: [UInt8] = [], i = hex.startIndex
        while let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) { if let b = UInt8(hex[i..<j], radix: 16) { bytes.append(b) }; i = j }
        guard bytes.first == 0x41 else { return [:] }
        var out: [UInt8: [UInt8]] = [:], k = 1
        while k < bytes.count, let n = pidLen[bytes[k]], k + 1 + n <= bytes.count {
            if out[bytes[k]] == nil { out[bytes[k]] = Array(bytes[(k + 1)..<(k + 1 + n)]) }
            k += 1 + n
        }
        return out
    }

    /// Supported-PID bitmap from a 0100 / 0120 / 0140 reply, or nil if unreadable.
    static func parseSupport(_ text: String, base: UInt8) -> Set<UInt8>? {
        guard let b = parse(text, pid: base), b.count >= 4 else { return nil }
        var s = Set<UInt8>()
        for i in 0..<32 where b[i >> 3] & (UInt8(0x80) >> UInt8(i & 7)) != 0 { s.insert(base + 1 + UInt8(i)) }
        return s
    }

    static func parse(_ text: String, pid: UInt8) -> [UInt8]? {
        let up = text.uppercased()
        if up.contains("NO DATA") || up.contains("UNABLE") || up.contains("ERROR") || up.contains("STOPPED") { return nil }
        let hex = up.filter { $0.isHexDigit }
        guard let r = hex.range(of: String(format: "41%02X", pid)) else { return nil }
        var out: [UInt8] = [], i = r.upperBound
        while let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) { if let b = UInt8(hex[i..<j], radix: 16) { out.append(b) }; i = j }
        return out.isEmpty ? nil : out
    }

    private func apply(_ pid: UInt8, _ d: [UInt8]) {
        func f(_ c: Double) -> Double { c * 9 / 5 + 32 }
        switch pid {
        case 0x0C where d.count >= 2: t.set("rpm", Double(Int(d[0]) * 256 + Int(d[1])) / 4)
        case 0x0D: t.set("speed", Double(d[0]) * 0.621371)
        case 0x05: t.set("coolant", f(Double(d[0]) - 40))
        case 0x0F: t.set("iat", f(Double(d[0]) - 40))
        case 0x0B: t.set("boost", (Double(d[0]) - baro) / 6.89476)
        case 0x11: t.set("throttle", Double(d[0]) * 100 / 255)
        case 0x0E: t.set("timing", Double(d[0]) / 2 - 64)
        case 0x42 where d.count >= 2: t.set("battery", Double(Int(d[0]) * 256 + Int(d[1])) / 1000)
        case 0x5C: t.set("oil_temp", f(Double(d[0]) - 40))
        case 0x52: t.set("ethanol", Double(d[0]) * 100 / 255)
        default: break
        }
    }
}
