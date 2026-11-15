import CoreBluetooth
import Foundation

/// A nearby Bluetooth LE device, shown in the adapter picker.
struct FoundDevice: Codable, Equatable {
    let id: String
    let name: String
    let rssi: Int
    let likelyOBD: Bool
    var ecutek: Bool = false
}

/// EcuTek's Bluetooth interface (EVI-BT): closed, ECU Connect only, and it flashes the ECU. Never connect to it.
enum EcuTek {
    static let pattern = try! NSRegularExpression(pattern: "ecu\\s*-?tek|ecu\\s*connect|\\bevi(?:[\\s_-]?bt)?\\b", options: .caseInsensitive)
    static func matches(_ name: String) -> Bool { pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil }
    static let message = "This is an EcuTek interface (EVI-BT). It only works with EcuTek's ECU Connect app and is used to flash your ECU, so Carbox will not connect to it. For EcuTek values ask your tuner to turn on RaceROM CAN output and read it with a CAN interface, or use any ELM327 OBD adapter for standard data."
}

/// Bluetooth LE link to an ELM327-style OBD-II adapter: Vgate, OBDLink CX, Veepeak, Konnwei, clones,
/// and FIXD (original and 2nd-gen sensors are BLE; FIXD's channel layout isn't published). The user
/// picks the adapter from a list, so its name doesn't matter. The data channel is found by looking at
/// every service (same rules as js/ble.js chooseChannel). Keeps working with the phone locked.
@MainActor
final class BLELink: NSObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    static let knownServices = ["FFF0", "FFE0", "FFE5", "18F0", "AE00", "AE30", "FEE7", "FFB0",
                                "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
                                "49535343-FE7D-4AE5-8FA9-9FAFD205E455", "FEFB"].map(CBUUID.init(string:))
    static let notData = ["1800", "1801", "180A", "180F", "1805", "FE59", "FD6F"].map(CBUUID.init(string:))
    private static let nameHint = try! NSRegularExpression(pattern: "obd|elm|vlink|v-link|vgate|veepeak|obdlink|fixd|appraisal[\\s_-]*pro|icar|konnwei|scan", options: .caseInsensitive)
    static let savedKey = "carbox.adapter"

    var onData: ((String) -> Void)?
    var onDevices: (([FoundDevice]) -> Void)?
    var onDiagnostic: ((String) -> Void)?
    var onDisconnect: (() -> Void)?
    var onWriteError: ((Error) -> Void)?
    private(set) var info: [String: String] = [:]

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var txType: CBCharacteristicWriteType = .withResponse
    private var pendingServices = 0
    private var found: [UUID: (CBPeripheral, FoundDevice)] = [:]
    private var ready: CheckedContinuation<Void, Error>?
    private var connectionAttempt: UUID?
    private var established = false

    static func prefersBasicOBD(_ name: String) -> Bool {
        let normalized = name.lowercased().filter(\.isLetter)
        return normalized.contains("fixd") || normalized.contains("appraisalpro")
    }

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionRestoreIdentifierKey: "carbox-central"])
    }

    private func waitForPower() async throws {
        let deadline = Date().addingTimeInterval(20)
        while central.state == .unknown || central.state == .resetting {
            guard Date() < deadline else { throw Self.err("Bluetooth is taking too long to start. Check Bluetooth permission and try again.") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try Task.checkCancellation()
        switch central.state {
        case .poweredOn: return
        case .poweredOff: throw Self.err("Bluetooth is off. Turn it on and scan again.")
        case .unauthorized: throw Self.err("Allow Bluetooth for Carbox Dash in iPhone Settings, then scan again.")
        case .unsupported: throw Self.err("This iPhone cannot use Bluetooth LE.")
        default: throw Self.err("Bluetooth is unavailable. Try again once Bluetooth is on.")
        }
    }

    /// Lists nearby BLE devices (likely OBD adapters first) until `stopScan()`.
    func startScan() async throws {
        try await waitForPower()
        found = [:]
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }
    func stopScan() { central.stopScan() }

    /// The adapter used last time, if iOS still knows it.
    var savedAdapter: UUID? { UserDefaults.standard.string(forKey: Self.savedKey).flatMap(UUID.init(uuidString:)) }
    func forget() { UserDefaults.standard.removeObject(forKey: Self.savedKey) }

    /// Connects to one device and finds its serial data channel.
    func connect(_ id: UUID) async throws {
        try Task.checkCancellation()
        close()
        let attempt = UUID()
        connectionAttempt = attempt
        info = [:]
        stopScan()
        do {
            try await waitForPower()
            guard let p = found[id]?.0 ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
                throw Self.err("That adapter isn't in range any more. Scan again.")
            }
            if EcuTek.matches(p.name ?? "") || found[id]?.1.ecutek == true {
                throw Self.err(EcuTek.message)
            }
            // A rapid reselect can reuse the same CBPeripheral while the prior cancel completes.
            let deadline = Date().addingTimeInterval(3)
            while p.state == .disconnecting && Date() < deadline {
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try Task.checkCancellation()
            guard connectionAttempt == attempt else { throw CancellationError() }
            guard p.state != .disconnecting else { throw Self.err("The previous Bluetooth connection is still closing. Try again.") }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                ready = continuation
                peripheral = p
                p.delegate = self
                info["name"] = found[id]?.1.name ?? p.name ?? "(no name)"
                onDiagnostic?("BLE: connecting to \(info["name"] ?? "adapter")")
                if p.state == .connected { p.discoverServices(nil) } else { central.connect(p) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                    guard let self, self.connectionAttempt == attempt, self.ready != nil else { return }
                    self.endConnection(Self.err("The adapter didn't finish Bluetooth setup. Close other scanner apps, then reconnect."))
                }
            }
        } catch {
            if connectionAttempt == attempt { endConnection(error) }
            throw error
        }
    }
    func close() { endConnection(CancellationError()) }

    func write(_ s: String) throws {
        guard established, let p = peripheral, p.state == .connected, let tx else {
            throw Self.err("Bluetooth data channel is disconnected")
        }
        let bytes = Array(s.utf8)
        let size = max(1, p.maximumWriteValueLength(for: txType))
        for offset in stride(from: 0, to: bytes.count, by: size) {
            guard txType == .withResponse || p.canSendWriteWithoutResponse else {
                throw Self.err("The adapter's Bluetooth write queue is busy")
            }
            p.writeValue(Data(bytes[offset..<min(offset + size, bytes.count)]), for: tx, type: txType)
        }
    }

    static func err(_ msg: String) -> NSError { NSError(domain: "carbox", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]) }
    private func endConnection(_ error: Error, reportDisconnect: Bool = false) {
        let oldPeripheral = peripheral
        let pending = ready
        let wasEstablished = established
        connectionAttempt = nil
        peripheral = nil
        rx = nil
        tx = nil
        ready = nil
        established = false
        pendingServices = 0
        if let oldPeripheral, oldPeripheral.state != .disconnected {
            central.cancelPeripheralConnection(oldPeripheral)
        }
        if !(error is CancellationError), pending != nil || wasEstablished {
            onDiagnostic?("BLE: \(error.localizedDescription)")
        }
        pending?.resume(throwing: error)
        if reportDisconnect && wasEstablished { onDisconnect?() }
    }

    // MARK: central
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        if c.state == .unauthorized || c.state == .poweredOff || c.state == .unsupported {
            let message = c.state == .unauthorized ? "Bluetooth is not allowed for Carbox Dash." : "Bluetooth is unavailable."
            endConnection(Self.err(message), reportDisconnect: true)
        }
    }
    func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {}
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = (ad[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        let uuids = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let likely = Self.nameHint.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil || uuids.contains { Self.knownServices.contains($0) }
        guard !name.isEmpty || likely else { return }   // nameless, non-OBD devices are just noise in the list
        found[p.identifier] = (p, FoundDevice(id: p.identifier.uuidString, name: name.isEmpty ? "Unnamed device" : name, rssi: rssi.intValue,
                                              likelyOBD: likely && !EcuTek.matches(name), ecutek: EcuTek.matches(name)))
        let list = found.values.map(\.1).sorted { ($0.likelyOBD ? 1 : 0, $0.rssi) > ($1.likelyOBD ? 1 : 0, $1.rssi) }
        onDevices?(Array(list.prefix(30)))
    }
    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral, ready != nil else { return }
        onDiagnostic?("BLE: connected; discovering services")
        p.discoverServices(nil)
    }
    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        endConnection(error ?? Self.err("Could not connect over Bluetooth. Close other scanner apps and try again."))
    }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        endConnection(error ?? Self.err("Adapter disconnected. Select it again to reconnect."), reportDisconnect: true)
    }

    // MARK: peripheral
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral, ready != nil else { return }
        if let error { endConnection(error); return }
        let services = p.services ?? []
        info["services"] = services.map(\.uuid.uuidString).joined(separator: ", ")
        pendingServices = services.count
        guard !services.isEmpty else {
            endConnection(Self.err("\(info["name"] ?? "Adapter"): no Bluetooth services visible"))
            return
        }
        onDiagnostic?("BLE: services \(info["services"] ?? "")")
        services.forEach { p.discoverCharacteristics(nil, for: $0) }
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard p === peripheral, ready != nil, pendingServices > 0 else { return }
        if let error { onDiagnostic?("BLE: service \(s.uuid.uuidString): \(error.localizedDescription)") }
        if let characteristics = s.characteristics, !characteristics.isEmpty {
            let ids = characteristics.map { $0.uuid.uuidString }.joined(separator: ", ")
            onDiagnostic?("BLE: \(s.uuid.uuidString) characteristics: \(ids)")
        }
        pendingServices -= 1
        guard pendingServices == 0 else { return }
        let prefersBasic = Self.prefersBasicOBD(info["name"] ?? "")
        guard let ch = Self.chooseChannel(p.services ?? [], preferFFFSerial: prefersBasic) else {
            endConnection(Self.err("\(info["name"] ?? "Adapter"): no writable Bluetooth data channel with notifications."))
            return
        }
        rx = ch.rx
        tx = ch.tx
        txType = ch.tx.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        info["channel"] = "\(ch.rx.service?.uuid.uuidString ?? "?") rx \(ch.rx.uuid.uuidString) tx \(ch.tx.uuid.uuidString)"
        onDiagnostic?("BLE: subscribing to \(info["channel"] ?? "")")
        p.setNotifyValue(true, for: ch.rx)
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral, ch === rx else { return }
        if let error {
            endConnection(Self.err("Could not subscribe to adapter replies: \(error.localizedDescription)"), reportDisconnect: true)
            return
        }
        guard ch.isNotifying else {
            endConnection(Self.err("The adapter did not enable reply notifications."), reportDisconnect: true)
            return
        }
        guard let ready else { return }
        self.ready = nil
        established = true
        UserDefaults.standard.set(p.identifier.uuidString, forKey: Self.savedKey)
        onDiagnostic?("BLE: reply notifications active")
        ready.resume()
    }
    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral, ch === tx, let error else { return }
        onWriteError?(error)
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral, ch === rx, error == nil else { return }
        if let d = ch.value { onData?(String(decoding: d, as: UTF8.self)) }
    }

    /// Same rules as js/ble.js chooseChannel: one service with notify + write (known OBD services
    /// first), standard services skipped; else notify and write paired across two services.
    static func chooseChannel(_ services: [CBService], preferFFFSerial: Bool = false) -> (rx: CBCharacteristic, tx: CBCharacteristic)? {
        let usable = services.filter { !notData.contains($0.uuid) }
        if preferFFFSerial,
           let chars = usable.first(where: { $0.uuid == CBUUID(string: "FFF0") })?.characteristics,
           let rx = chars.first(where: { $0.uuid == CBUUID(string: "FFF1") && ($0.properties.contains(.notify) || $0.properties.contains(.indicate)) }),
           let tx = chars.first(where: { $0.uuid == CBUUID(string: "FFF2") && ($0.properties.contains(.write) || $0.properties.contains(.writeWithoutResponse)) }) {
            return (rx, tx)
        }
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
    private var stopped = false
    private var baro = 101.3
    private var misses: [UInt8: Int] = [:]
    private var unsupported = Set<UInt8>()
    private var sfx = ""          // "1" once the adapter takes a reply count ("010C1"): no waiting for other ECUs
    private var multi = false     // several PIDs per request ("010C0D0B11")
    private var basicMode = false
    private var basicRetryAfter: [UInt8: Date] = [:]
    private var observedPIDs = Set<UInt8>()
    private var rxBytes = 0, lastRx = Date.distantPast
    private(set) var identity = ""
    /// Raw requests from the Diagnostics tab ("03", "0101", "04"...), sent between polls.
    private var rawQueue: [(cmd: String, cont: CheckedContinuation<String, Error>)] = []
    func raw(_ cmd: String) async throws -> String {
        guard running else { throw BLELink.err("No adapter connected") }
        guard !t.paused else { throw BLELink.err("OBD is paused") }
        return try await withCheckedThrowingContinuation { rawQueue.append((cmd, $0)) }
    }
    private func drainRaw() async {
        while !rawQueue.isEmpty {
            let q = rawQueue.removeFirst()
            do { q.cont.resume(returning: try await ask(q.cmd, timeout: 4)) } catch { q.cont.resume(throwing: error) }
        }
    }
    private func failRaw(_ why: String) { let q = rawQueue; rawQueue = []; for r in q { r.cont.resume(throwing: BLELink.err(why)) } }

    static let fast: [UInt8] = [0x0C, 0x0D, 0x0B, 0x11]
    static let slow: [UInt8] = [0x04, 0x45, 0x49, 0x4A, 0x4B, 0x4C, 0x05, 0x0F, 0x42, 0x0E, 0x2F, 0x5C, 0x52, 0x10, 0x34, 0x24, 0x06, 0x07, 0x44]
    private static let compatibilityPIDs: [UInt8] = [0x0C, 0x0D, 0x11, 0x05, 0x2F]
    /// Data bytes per PID, so a reply to several PIDs at once can be split up.
    static let pidLen: [UInt8: Int] = [0x04: 1, 0x45: 1, 0x49: 1, 0x4A: 1, 0x4B: 1, 0x4C: 1, 0x0C: 2, 0x0D: 1, 0x05: 1, 0x0F: 1, 0x0B: 1, 0x33: 1, 0x11: 1, 0x0E: 1, 0x42: 2, 0x5C: 1, 0x52: 1,
                                       0x06: 1, 0x07: 1, 0x10: 2, 0x2F: 1, 0x44: 2, 0x34: 4, 0x24: 4]
    private static func hex(_ pids: [UInt8]) -> String { pids.map { String(format: "%02X", $0) }.joined() }

    init(link: BLELink, telemetry: Telemetry) {
        self.link = link; self.t = telemetry
        link.onData = { [weak self] s in self?.received(s) }
        link.onWriteError = { [weak self] error in self?.failRequest(error) }
    }

    private func failRequest(_ error: Error) {
        guard let pending = waiter else { return }
        waiter = nil
        pending.cont.resume(throwing: error)
    }

    private func received(_ s: String) {
        rxBytes += s.count; lastRx = Date()
        buffer += s
        guard let r = buffer.range(of: ">"), let w = waiter else { return }
        var text = String(buffer[..<r.lowerBound]); buffer = String(buffer[r.upperBound...]); waiter = nil
        let trimmed = text.drop { $0.isWhitespace }
        if trimmed.uppercased().hasPrefix(w.cmd) { text = String(trimmed.dropFirst(w.cmd.count)) }   // echoed command
        w.cont.resume(returning: text)
    }

    private func request(_ cmd: String, timeout: Double = 1.5) async throws -> String {
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }
        guard !t.paused else { throw BLELink.err("OBD is paused") }
        buffer = ""
        reqId += 1
        let id = reqId
        return try await withCheckedThrowingContinuation { c in
            waiter = (c, cmd.uppercased(), id)
            do { try link.write(cmd + "\r") }
            catch { failRequest(error); return }
            // The timer is tied to THIS request's id. Matching on the command text alone let an old
            // request's timer cancel a newer request for the same command (the batched polls repeat
            // every ~0.6 s, the same as the timeout), which showed up as a timeout about every second.
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                Task { @MainActor in
                    guard let self, self.waiter?.id == id else { return }
                    self.failRequest(BLELink.err("Timeout waiting for \(cmd)"))
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
        } catch {
            if !stopped && !(error is CancellationError) {
                t.log("! \(cmd): \(error.localizedDescription)")
                await resync()
            }
            throw error
        }
    }
    private func tidy(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }

    /// Call after BLELink.connect succeeded.
    func start() async throws {
        basicMode = BLELink.prefersBasicOBD(link.info["name"] ?? "")
        t.status = "ADAPTER INIT"
        t.log("OBD: checking for ELM327 replies")
        var greeting: String?
        for command in ["ATZ", "ATI", "ATZ"] where greeting == nil {
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            do { greeting = try await ask(command, timeout: command == "ATZ" ? 4 : 2) }
            catch {
                if !stopped && !t.paused { try? link.write("\r"); await resync() }
            }
        }
        guard let greeting else {
            throw BLELink.err(rxBytes == 0
                ? "Bluetooth connected but the adapter returned no ELM327 replies. Close the FIXD app and other scanners, then retry."
                : "The adapter sent data without an ELM327 prompt. The Bluetooth channel may use a different protocol.")
        }
        // Optional formatting commands can return '?' on older adapters.
        for command in ["ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"] { _ = try? await ask(command) }
        identity = (try? await ask("ATI")).map(tidy) ?? tidy(greeting)
        t.log(identity.isEmpty ? "OBD: ELM327 prompt received" : "OBD: adapter ID \(identity)")
        t.status = "ECU SEARCH"
        t.log("OBD: looking for the vehicle ECU")
        var first: String?
        let discoveryAttempts = basicMode ? 1 : 2
        for _ in 0..<discoveryAttempts where first == nil {
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            if let reply = try? await ask("0100", timeout: 10), Self.parseSupport(reply, base: 0x00) != nil {
                first = reply
            }
        }
        // Verify actual live values independently of the 0100 bitmap. Some adapters only
        // return one ECU's capabilities, so a missing bit doesn't rule out a broadcast reply.
        var basic = Set<UInt8>()
        let startupPIDs: [UInt8] = basicMode ? Self.compatibilityPIDs : [0x0C, 0x0D]
        for pid in startupPIDs {
            let bytes = await readPID(pid, timeout: 2)
            try Task.checkCancellation()
            guard !stopped else { throw CancellationError() }
            if let bytes {
                basic.insert(pid)
                t.source = .obd
                t.status = "OBD"
                applySample(pid, bytes)
                NotificationCenter.default.post(name: .telemetrySample, object: nil)
            }
        }
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }
        guard !basic.isEmpty else {
            throw BLELink.err("The adapter responds, but the car returned no standard live data. Turn on the ignition and retry.")
        }
        let missing = startupPIDs.filter { !basic.contains($0) }
        let probeSummary = missing.isEmpty ? "" : "; no valid reply \(Self.hex(missing))"
        let startupSummary = "live startup PIDs \(Self.hex(basic.sorted()))" + probeSummary
        t.log("OBD: " + startupSummary)
        if !basicMode, basic.count == 2, let first {
            await tune(first, basic: basic)
            if let bytes = await readPID(0x33, suffix: sfx), !stopped { applySample(0x33, bytes) }
        } else {
            basicMode = true
            for pid in missing { deferBasicPID(pid) }
            let name = link.info["name"] ?? ""
            let label = BLELink.prefersBasicOBD(name) ? "\(name) compatibility" : "compatibility fallback"
            fastSummary = "\(label): broadcast single PID, no reply-count suffix; \(startupSummary)"
            t.log("OBD: " + fastSummary)
        }
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }
        t.source = .obd
        t.status = "OBD"
        running = true
        NotificationCenter.default.post(name: .telemetrySample, object: nil)
        Task { await loop() }
    }
    func stop() {
        stopped = true
        running = false
        failRequest(CancellationError())
        failRaw("Adapter stopped")
        link.close()
    }

    private func readPID(_ pid: UInt8, suffix: String = "", timeout: Double = 1.5) async -> [UInt8]? {
        guard let reply = try? await ask(String(format: "01%02X", pid) + suffix, timeout: timeout) else { return nil }
        return Self.parse(reply, pid: pid)
    }

    /// Makes polling fast; same steps as js/elm327.js _tune(). Each one is probed and skipped if the
    /// adapter can't do it, so old clones work as before:
    ///  1. On CAN, talk to the engine ECU directly (ATSH7E0) so the transmission doesn't answer too.
    ///  2. End requests with the expected reply count ("010C1"). Without it the ELM327 waits
    ///     50-200 ms after every answer in case another ECU speaks: the main cause of the lag.
    ///  3. Ask for up to 6 PIDs per request: one Bluetooth round trip instead of four.
    ///  4. Read the supported-PID bitmaps so nothing is wasted on PIDs the ECU never answers.
    private func tune(_ firstReply: String, basic: Set<UInt8>) async {
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
            if let r0 = try? await ask("0100"), Self.parseSupport(r0, base: 0x00)?.contains(0x0C) == true,
               await readsBasics(basic) {
                first = r0; direct = true; note.append("engine ECU direct")
            } else { _ = try? await ask("ATSH7DF", timeout: 1) }   // ECU didn't answer directly: broadcast again
        }
        if await readsBasics(basic, suffix: "1") {
            sfx = "1"; note.append("reply count")
        }
        if var all = Self.parseSupport(first, base: 0x00) {
            for base: UInt8 in [0x20, 0x40] where all.contains(base) {
                guard let r = try? await ask(String(format: "01%02X", base) + sfx, timeout: 1) else { break }
                if let s = Self.parseSupport(r, base: base) { all.formUnion(s) }
            }
            for pid in Self.slow where !all.contains(pid) && (pid < 0x40 || all.contains(0x40)) { unsupported.insert(pid) }
            // The list can be wrong for the values that matter most (boost, throttle), so ask for them
            // directly before giving up on them.
            for pid in Self.fast where pid != 0x0C && pid != 0x0D && !all.contains(pid) {
                if let r = try? await ask(String(format: "01%02X", pid) + sfx, timeout: 1), Self.parse(r, pid: pid) != nil {
                    note.append(String(format: "%02X answers although not listed", pid))
                } else { unsupported.insert(pid) }
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
        if !stopped && !Task.isCancelled { t.log("fast mode: " + fastSummary) }
    }

    private func readsBasics(_ basic: Set<UInt8>, suffix: String = "") async -> Bool {
        for pid in basic.sorted() {
            if await readPID(pid, suffix: suffix, timeout: 1) == nil { return false }
        }
        return true
    }

    private func deferBasicPID(_ pid: UInt8) {
        let wasLive = observedPIDs.contains(pid)
        if !wasLive || misses[pid, default: 0] > 1 {
            basicRetryAfter[pid] = Date().addingTimeInterval(wasLive ? 2.5 : 8)
        }
    }

    private func applySample(_ pid: UInt8, _ bytes: [UInt8]) {
        observedPIDs.insert(pid)
        basicRetryAfter.removeValue(forKey: pid)
        misses[pid] = 0
        apply(pid, bytes)
    }

    private func loop() async {
        var n = 0, slowAt = 0, multiFails = 0
        let slow = basicMode ? [UInt8(0x05), 0x2F, 0x33, 0x0B] + Self.slow.filter { $0 != 0x05 && $0 != 0x2F } : Self.slow
        func canPoll(_ pid: UInt8) -> Bool {
            !unsupported.contains(pid) && (basicRetryAfter[pid] ?? .distantPast) <= Date()
        }
        func slowNext(_ k: Int) -> [UInt8] {   // the next k supported slow PIDs, in rotation
            var out: [UInt8] = []
            for _ in slow where out.count < k {
                let pid = slow[slowAt]
                slowAt = (slowAt + 1) % slow.count
                if canPoll(pid) { out.append(pid) }
            }
            return out
        }
        func miss(_ pid: UInt8) {
            misses[pid, default: 0] += 1
            if basicMode { deferBasicPID(pid); return }
            if misses[pid, default: 0] > 3, pid != 0x0C, pid != 0x0D { unsupported.insert(pid) }   // never give up on rpm/speed
        }
        while running {
            if t.paused { t.status = "PAUSED"; failRaw("OBD is paused"); try? await Task.sleep(nanoseconds: 300_000_000); continue }
            if !rawQueue.isEmpty { await drainRaw() }
            guard running else { break }
            let fast = (basicMode ? [UInt8(0x0C), 0x0D, 0x11] : Self.fast).filter(canPoll)
            if multi {
                // one request: the fast PIDs, plus 2 slow ones every other cycle (6 is the OBD limit)
                let pids = n % 2 == 0 ? fast + slowNext(min(2, 6 - fast.count)) : fast
                n += 1
                if pids.isEmpty { try? await Task.sleep(nanoseconds: 100_000_000); continue }   // every PID is waiting for a retry: never send a bare "01"
                do {
                    let text = try await ask("01" + Self.hex(pids) + sfx, timeout: 0.6)
                    guard running, !t.paused else { continue }
                    let got = Self.parseMulti(text)
                    var any = false
                    for pid in pids {
                        if let d = got[pid] { applySample(pid, d); any = true } else { miss(pid) }
                    }
                    multiFails = any ? 0 : multiFails + 1
                    if any { t.status = "OBD" }
                } catch { multiFails += 1 }
                if multiFails >= 4 { multi = false; t.log("! batched requests stopped working; asking one PID at a time") }
                NotificationCenter.default.post(name: .telemetrySample, object: nil)
                continue
            }
            let slowInterval = basicMode ? 1 : 4
            let pids = n % slowInterval == 0 ? fast + slowNext(1) : fast
            n += 1
            for pid in pids where running && !t.paused && canPoll(pid) {
                do {
                    let timeout = basicMode ? 1.5 : 0.6
                    let text = try await ask(String(format: "01%02X", pid) + sfx, timeout: timeout)
                    guard running, !t.paused else { break }
                    if let bytes = Self.parse(text, pid: pid) {
                        applySample(pid, bytes)
                        t.status = "OBD"
                        NotificationCenter.default.post(name: .telemetrySample, object: nil)
                    } else { miss(pid) }
                } catch {
                    if basicMode && running && !t.paused { miss(pid) }
                }
            }
            guard running else { break }
            NotificationCenter.default.post(name: .telemetrySample, object: nil)
            if !t.paused && t.liveCount == 0 { t.status = "NO LIVE DATA" }
            if pids.isEmpty { try? await Task.sleep(nanoseconds: 100_000_000) }   // waiting for a retry
        }
    }

    /// Splits a reply to a multi-PID request into [pid: bytes]. Handles the ELM327's multi-frame layout
    /// (a length line, then "0:", "1:", ... lines) and single-frame replies; only the first ECU's answer
    /// is used. Same rules as js/elm327.js parseMulti (unit-tested in tests/elm.test.mjs).
    static func parseMulti(_ text: String) -> [UInt8: [UInt8]] {
        let up = text.uppercased()
        let flat = up.filter { !$0.isWhitespace }
        if ["NODATA", "UNABLE", "ERROR", "STOPPED", "?"].contains(where: { flat.contains($0) }) { return [:] }
        let lines = up.components(separatedBy: .newlines)
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
        let expected = pidLen[pid] ?? (pid.isMultiple(of: 0x20) ? 4 : 0)
        guard expected > 0 else { return nil }
        let signature = String(format: "41%02X", pid)
        for line in text.uppercased().components(separatedBy: .newlines) {
            let hex = line.filter(\.isHexDigit)
            guard let response = hex.range(of: signature) else { continue }
            var bytes: [UInt8] = []
            var start = response.upperBound
            for _ in 0..<expected {
                guard let end = hex.index(start, offsetBy: 2, limitedBy: hex.endIndex),
                      let byte = UInt8(hex[start..<end], radix: 16) else { break }
                bytes.append(byte)
                start = end
            }
            if bytes.count == expected { return bytes }
        }
        return nil
    }

    private func apply(_ pid: UInt8, _ d: [UInt8]) {
        func f(_ c: Double) -> Double { c * 9 / 5 + 32 }
        switch pid {
        case 0x04: t.set("load", Double(d[0]) * 100 / 255)
        case 0x45: t.set("relative_throttle", Double(d[0]) * 100 / 255)
        case 0x49: t.set("pedal", Double(d[0]) * 100 / 255)
        case 0x4A: t.set("pedal_e", Double(d[0]) * 100 / 255)
        case 0x4B: t.set("pedal_f", Double(d[0]) * 100 / 255)
        case 0x4C: t.set("commanded_throttle", Double(d[0]) * 100 / 255)
        case 0x0C where d.count >= 2: t.set("rpm", Double(Int(d[0]) * 256 + Int(d[1])) / 4)
        case 0x0D: t.set("speed", Double(d[0]) * 0.621371)
        case 0x05: t.set("coolant", f(Double(d[0]) - 40))
        case 0x0F: t.set("iat", f(Double(d[0]) - 40))
        case 0x0B: t.set("boost", (Double(d[0]) - baro) / 6.89476)
        case 0x33: baro = Double(d[0])
        case 0x11: t.set("throttle", Double(d[0]) * 100 / 255)
        case 0x0E: t.set("timing", Double(d[0]) / 2 - 64)
        case 0x42 where d.count >= 2: t.set("battery", Double(Int(d[0]) * 256 + Int(d[1])) / 1000)
        case 0x2F: t.set("fuel_level", Double(d[0]) * 100 / 255)
        case 0x5C: t.set("oil_temp", f(Double(d[0]) - 40))
        case 0x52: t.set("ethanol", Double(d[0]) * 100 / 255)
        case 0x06: t.set("stft", (Double(d[0]) - 128) * 100 / 128)
        case 0x07: t.set("ltft", (Double(d[0]) - 128) * 100 / 128)
        case 0x10 where d.count >= 2: t.set("maf", Double(Int(d[0]) * 256 + Int(d[1])) / 100)
        case 0x44 where d.count >= 2: t.set("lambda_cmd", Double(Int(d[0]) * 256 + Int(d[1])) / 32768)
        case 0x34, 0x24:   // wide-band O2 sensor 1: lambda in the first two bytes; AFR as gasoline-equivalent
            guard d.count >= 2 else { break }
            let lam = Double(Int(d[0]) * 256 + Int(d[1])) / 32768
            if lam > 0.5 && lam < 2 { t.set("lambda", lam); t.set("afr", lam * 14.7) }
        default: break
        }
    }
}
