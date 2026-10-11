import Foundation
import CryptoKit

/// Each field is length-prefixed; the protocol number itself is a two-byte field.
func canonical(_ fields: [Data]) throws -> Data {
    var out = Data()
    for field in fields {
        guard field.count <= 65535 else { throw LinkFailure.invalid("握手字段太长") }
        out.append(UInt8(field.count >> 8)); out.append(UInt8(field.count & 255)); out.append(field)
    }
    return out
}

struct PairedComputer: Codable {
    let relayUrl: String
    let roomId: String
    let roomToken: String
    let computerId: String
    let computerName: String
    let computerSigningPublicKey: String
    let computerStaticDhPublicKey: String
    func validate() throws {
        _ = try Self.validatedRelayURL(relayUrl)
        guard try MobileCrypto.decodeBase64Url(roomId).count == 16,
              try MobileCrypto.decodeBase64Url(roomToken).count == 32,
              !computerId.isEmpty, !computerName.isEmpty else { throw LinkFailure.invalid("配对信息不完整") }
        _ = try P256.Signing.PublicKey(derRepresentation: MobileCrypto.decodeBase64Url(computerSigningPublicKey))
        _ = try P256.KeyAgreement.PublicKey(derRepresentation: MobileCrypto.decodeBase64Url(computerStaticDhPublicKey))
    }
    static func validatedRelayURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil, url.fragment == nil,
              url.scheme == "wss" || url.scheme == "ws" else { throw LinkFailure.invalid("中继地址不对") }
        if url.scheme == "ws" {
            let h = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            let octets = h.split(separator: ".").compactMap { Int($0) }
            let privateIPv4 = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } &&
                (octets[0] == 10 || octets[0] == 127 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 169 && octets[1] == 254))
            let privateIPv6 = h.contains(":") && (h == "::1" || h.hasPrefix("fc") || h.hasPrefix("fd") || h.hasPrefix("fe80:"))
            guard h == "localhost" || privateIPv4 || privateIPv6 else { throw LinkFailure.invalid("公网中继必须使用 wss://") }
        }
        return url
    }
}

struct PairingQr {
    let computer: PairedComputer
    let pairId: String
    let expiresAt: Int64
    let pairingToken: Data
    static func parse(_ payload: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> PairingQr {
        let prefix = "sikeoop://pair/"
        guard payload.hasPrefix(prefix), payload.utf8.count <= 32768 else { throw LinkFailure.invalid("这不是 sikeoop 的配对二维码") }
        let o = try WireJSON.object(MobileCrypto.decodeBase64Url(String(payload.dropFirst(prefix.count))))
        guard o["v"] as? Int == 1 else { throw LinkFailure.invalid("二维码版本不对，请更新 sikeoop") }
        func s(_ key: String) throws -> String { guard let s = o[key] as? String else { throw LinkFailure.invalid("二维码缺少 \(key)") }; return s }
        guard let expiry = o["expiresAt"] as? NSNumber, expiry.int64Value > now else { throw LinkFailure.invalid("二维码过期了，请在电脑上重新生成") }
        let c = try PairedComputer(relayUrl: s("relayUrl"), roomId: s("roomId"), roomToken: s("roomToken"), computerId: s("computerId"), computerName: s("computerName"), computerSigningPublicKey: s("computerSigningPublicKey"), computerStaticDhPublicKey: s("computerStaticDhPublicKey"))
        try c.validate()
        let token = try MobileCrypto.decodeBase64Url(s("pairingToken")), id = try s("pairId")
        guard token.count == 32, try MobileCrypto.decodeBase64Url(id).count == 16 else { throw LinkFailure.invalid("二维码内容不完整") }
        return PairingQr(computer: c, pairId: id, expiresAt: expiry.int64Value, pairingToken: token)
    }
}

struct SessionKeys { let sessionId: String; let key: Data }

final class PhoneHandshake {
    private let computer: PairedComputer
    private let device: DeviceIdentity
    private let pairing: PairingQr?
    private let ephemeral = P256.KeyAgreement.PrivateKey()
    private let clientNonce: Data
    private(set) var session: SessionKeys?
    init(computer: PairedComputer, device: DeviceIdentity, pairing: PairingQr? = nil) throws {
        try computer.validate()
        self.computer = computer; self.device = device; self.pairing = pairing
        clientNonce = try MobileCrypto.randomBytes(32)
    }
    func hello() throws -> [String: Any] {
        let signing = device.signing.publicKey.derRepresentation, dh = device.staticDh.publicKey.derRepresentation
        let eph = ephemeral.publicKey.derRepresentation
        var o: [String: Any] = ["t": "hello", "v": 1, "roomId": computer.roomId, "deviceId": device.deviceId,
            "deviceName": device.deviceName, "deviceSigningPublicKey": MobileCrypto.encodeBase64Url(signing),
            "deviceStaticDhPublicKey": MobileCrypto.encodeBase64Url(dh), "deviceEphemeralPublicKey": MobileCrypto.encodeBase64Url(eph),
            "clientNonce": MobileCrypto.encodeBase64Url(clientNonce)]
        if let pairing {
            guard pairing.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { throw LinkFailure.invalid("二维码过期了") }
            let digest = MobileCrypto.sha256(try canonical([Data("sikeoop/mobile/v1/hello".utf8), Data([0, 1]), Data(computer.roomId.utf8), Data(pairing.pairId.utf8), Data(device.deviceId.utf8), Data(device.deviceName.utf8), signing, dh, eph, clientNonce]))
            o["pairId"] = pairing.pairId
            o["helloProof"] = MobileCrypto.encodeBase64Url(MobileCrypto.hmacSha256(key: pairing.pairingToken, data: digest))
        }
        return o
    }
    func answer(_ challenge: [String: Any]) throws -> [String: Any] {
        func s(_ key: String) throws -> String { guard let v = challenge[key] as? String else { throw LinkFailure.invalid("challenge 缺少 \(key)") }; return v }
        guard session == nil, challenge["t"] as? String == "challenge", challenge["v"] as? Int == 1 else { throw LinkFailure.invalid("电脑拒绝了连接") }
        guard try s("computerId") == computer.computerId,
              try s("computerSigningPublicKey") == computer.computerSigningPublicKey,
              try s("computerStaticDhPublicKey") == computer.computerStaticDhPublicKey else { throw LinkFailure.invalid("这台电脑的身份和配对时不一样") }
        let id = try s("sessionId"); try MobileCrypto.validateSessionId(id)
        let compEph = try MobileCrypto.decodeBase64Url(s("computerEphemeralPublicKey"))
        let nonce = try MobileCrypto.decodeBase64Url(s("serverNonce"))
        guard nonce.count == 32 else { throw LinkFailure.invalid("电脑随机数长度不对") }
        let compSign = try MobileCrypto.decodeBase64Url(computer.computerSigningPublicKey)
        let compDh = try MobileCrypto.decodeBase64Url(computer.computerStaticDhPublicKey)
        let base = try canonical([Data("sikeoop/mobile/v1/handshake".utf8), Data([0, 1]), Data(computer.roomId.utf8), Data((pairing?.pairId ?? "").utf8), Data(computer.computerId.utf8), Data(device.deviceId.utf8), Data(device.deviceName.utf8), compSign, compDh, device.signing.publicKey.derRepresentation, device.staticDh.publicKey.derRepresentation, compEph, ephemeral.publicKey.derRepresentation, clientNonce, nonce])
        let compSig = try MobileCrypto.decodeBase64Url(s("computerSignature"))
        guard try P256.Signing.PublicKey(derRepresentation: compSign).isValidSignature(P256.Signing.ECDSASignature(derRepresentation: compSig), for: base) else { throw LinkFailure.invalid("电脑的签名不对") }
        let devSig = try device.signing.signature(for: base + compSig).derRepresentation
        func dh(_ key: P256.KeyAgreement.PrivateKey, _ peer: Data) throws -> Data {
            try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(derRepresentation: peer)).withUnsafeBytes { Data($0) }
        }
        let key = try MobileCrypto.deriveSessionKey(ss: dh(device.staticDh, compDh), es: dh(ephemeral, compDh), se: dh(device.staticDh, compEph), ee: dh(ephemeral, compEph), transcriptHash: MobileCrypto.sha256(canonical([base, compSig, devSig])), pairingToken: pairing?.pairingToken ?? Data())
        session = SessionKeys(sessionId: id, key: key)
        return ["t": "authenticate", "v": 1, "sessionId": id, "deviceSignature": MobileCrypto.encodeBase64Url(devSig)]
    }
}
