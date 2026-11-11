import CoreBluetooth
import Foundation

/// Bluetooth LE link to an ELM327-style OBD-II adapter (Vgate, OBDLink CX, Veepeak BLE, maybe FIXD).
/// Finds the adapter, subscribes to its notify characteristic and writes to its write characteristic.
/// Keeps working with the phone locked thanks to the bluetooth-central background mode.
final class BLELink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let services = ["FFF0", "FFE0", "18F0", "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"].map(CBUUID.init(string:))
    private static let nameHint = try! NSRegularExpression(pattern: "obd|elm|vlink|v-link|vgate|veepeak|obdlink|fixd|icar|konnwei", options: .caseInsensitive)
    private static let savedKey = "carbox.adapter"

    var onData: ((String) -> Void)?
    var onState: ((String) -> Void)?
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var tx: CBCharacteristic?
    private var ready: CheckedContinuation<Void, Error>?

    /// Connects (scanning if needed) and returns once the adapter can be written to.
    func open() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            ready = c
            central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionRestoreIdentifierKey: "carbox-central"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.fail("No OBD adapter found. Is it plugged in with the ignition on?") }
        }
    }
    func close() { if let p = peripheral { central?.cancelPeripheralConnection(p) } }

    func write(_ s: String) {
        guard let p = peripheral, let tx else { return }
        let type: CBCharacteristicWriteType = tx.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        let bytes = Array(s.utf8)
        stride(from: 0, to: bytes.count, by: 20).forEach { p.writeValue(Data(bytes[$0..<min($0 + 20, bytes.count)]), for: tx, type: type) }
    }

    private func fail(_ msg: String) {
        guard let r = ready else { return }
        ready = nil; central?.stopScan(); r.resume(throwing: NSError(domain: "carbox", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]))
    }

    // MARK: central
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state == .poweredOn else { if c.state == .unauthorized || c.state == .poweredOff { fail("Bluetooth is off or not allowed for Carbox Dash") }; return }
        if let id = UserDefaults.standard.string(forKey: Self.savedKey).flatMap(UUID.init(uuidString:)),
           let known = c.retrievePeripherals(withIdentifiers: [id]).first {
            connect(known); return
        }
        onState?("SCANNING")
        c.scanForPeripherals(withServices: nil, options: nil)   // some adapters don't advertise their service
    }
    func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {}
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = p.name ?? (ad[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        let uuids = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let byName = Self.nameHint.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
        if byName || uuids.contains(where: { Self.services.contains($0) }) { c.stopScan(); connect(p) }
    }
    private func connect(_ p: CBPeripheral) { peripheral = p; p.delegate = self; onState?("CONNECTING"); central.connect(p) }
    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices(nil) }
    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { fail(error?.localizedDescription ?? "Could not connect") }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        onState?("DISCONNECTED")
        c.connect(p)   // reconnect automatically when the car comes back
    }

    // MARK: peripheral
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) { p.services?.forEach { p.discoverCharacteristics(nil, for: $0) } }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            if ch.properties.contains(.notify) || ch.properties.contains(.indicate) { p.setNotifyValue(true, for: ch) }
            if tx == nil, ch.properties.contains(.write) || ch.properties.contains(.writeWithoutResponse) { tx = ch }
        }
        if tx != nil, let r = ready {
            ready = nil
            UserDefaults.standard.set(p.identifier.uuidString, forKey: Self.savedKey)
            r.resume()
        }
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        if let d = ch.value, let s = String(data: d, encoding: .ascii) { onData?(s) }
    }
}

/// ELM327 protocol: init, then Mode 01 polling. Mirrors js/elm327.js (tested with a fake adapter).
@MainActor
final class ELM327 {
    private let link: BLELink
    private let t: Telemetry
    private var buffer = ""
    private var waiter: CheckedContinuation<String, Error>?
    private var running = false
    private var baro = 101.3
    private var misses: [UInt8: Int] = [:]
    private var unsupported = Set<UInt8>()

    static let fast: [UInt8] = [0x0C, 0x0D, 0x0B, 0x11]
    static let slow: [UInt8] = [0x05, 0x0F, 0x42, 0x0E, 0x5C, 0x52]

    init(link: BLELink, telemetry: Telemetry) {
        self.link = link; self.t = telemetry
        link.onData = { [weak self] s in Task { @MainActor in self?.received(s) } }
        link.onState = { [weak t = telemetry] s in Task { @MainActor in t?.status = s } }
    }

    private func received(_ s: String) {
        buffer += s
        if let r = buffer.range(of: ">"), let w = waiter {
            let text = String(buffer[..<r.lowerBound]); buffer = String(buffer[r.upperBound...]); waiter = nil
            w.resume(returning: text)
        }
    }

    private func request(_ cmd: String, timeout: Double = 1.5) async throws -> String {
        buffer = ""
        return try await withCheckedThrowingContinuation { c in
            waiter = c
            link.write(cmd + "\r")
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self, let w = self.waiter else { return }
                self.waiter = nil; w.resume(throwing: NSError(domain: "carbox", code: 2, userInfo: [NSLocalizedDescriptionKey: "timeout: \(cmd)"]))
            }
        }
    }

    func start() async throws {
        t.status = "CONNECTING"
        try await link.open()
        t.status = "INIT"
        for c in ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"] { _ = try await request(c, timeout: c == "ATZ" ? 4 : 1.5) }
        let first = try await request("0100", timeout: 8)
        if first.uppercased().contains("UNABLE") { throw NSError(domain: "carbox", code: 3, userInfo: [NSLocalizedDescriptionKey: "Adapter can't reach the ECU. Is the ignition on?"]) }
        let baroText = try await request("0133")
        if let b = Self.parse(baroText, pid: 0x33) { baro = Double(b[0]) }
        t.source = .obd; t.status = "OBD"; running = true
        Task { await loop() }
    }
    func stop() { running = false; link.close() }

    private func loop() async {
        var n = 0
        while running {
            if t.paused { t.status = "PAUSED"; try? await Task.sleep(nanoseconds: 300_000_000); continue }
            t.status = "OBD"
            var pids = Self.fast
            if n % 4 == 0 { pids.append(Self.slow[(n / 4) % Self.slow.count]) }
            n += 1
            for pid in pids where running && !t.paused && !unsupported.contains(pid) {
                do {
                    let text = try await request(String(format: "01%02X", pid))
                    if let bytes = Self.parse(text, pid: pid) { apply(pid, bytes) }
                    else { misses[pid, default: 0] += 1; if misses[pid]! > 3 { unsupported.insert(pid) } }
                } catch { /* timeouts are normal now and then; keep polling */ }
            }
        }
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
        func need(_ n: Int) -> Bool { d.count >= n }
        switch pid {
        case 0x0C where need(2): t.set("rpm", Double(Int(d[0]) * 256 + Int(d[1])) / 4)
        case 0x0D: t.set("speed", Double(d[0]) * 0.621371)
        case 0x05: t.set("coolant", f(Double(d[0]) - 40))
        case 0x0F: t.set("iat", f(Double(d[0]) - 40))
        case 0x0B: t.set("boost", (Double(d[0]) - baro) / 6.89476)
        case 0x11: t.set("throttle", Double(d[0]) * 100 / 255)
        case 0x0E: t.set("timing", Double(d[0]) / 2 - 64)
        case 0x42 where need(2): t.set("battery", Double(Int(d[0]) * 256 + Int(d[1])) / 1000)
        case 0x5C: t.set("oil_temp", f(Double(d[0]) - 40))
        case 0x52: t.set("ethanol", Double(d[0]) * 100 / 255)
        default: break
        }
    }
}
