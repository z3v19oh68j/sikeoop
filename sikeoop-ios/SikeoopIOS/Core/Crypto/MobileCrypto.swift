import Foundation
import CryptoKit
import Security

enum LinkFailure: LocalizedError {
    case invalid(String)
    var errorDescription: String? { switch self { case .invalid(let message): return message } }
}

enum FrameDirection: String, Codable {
    case mobileToDesktop = "mobile-to-desktop"
    case desktopToMobile = "desktop-to-mobile"
    var prefix: Data { Data((self == .mobileToDesktop ? "MOB1" : "HOS1").utf8) }
}

struct SealedFrame: Codable, Equatable {
    let version: Int
    let sessionId: String
    let direction: String
    let counter: String
    let ciphertext: String
    let tag: String
}

enum MobileCrypto {
    static let maxFrameBytes = 1_048_576
    static func encodeBase64Url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decodeBase64Url(_ value: String) throws -> Data {
        guard value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }), value.count % 4 != 1,
              let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)), encodeBase64Url(data) == value else {
            throw LinkFailure.invalid("无效的 base64url")
        }
        return data
    }
    static func randomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw LinkFailure.invalid("随机数生成失败") }
        return Data(bytes)
    }
    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    static func hmacSha256(key: Data, data: Data) -> Data { Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key))) }
    static func deriveSessionKey(ss: Data, es: Data, se: Data, ee: Data, transcriptHash: Data, pairingToken: Data = Data()) throws -> Data {
        guard [ss, es, se, ee, transcriptHash].allSatisfy({ $0.count == 32 }), pairingToken.isEmpty || pairingToken.count == 32 else { throw LinkFailure.invalid("会话密钥输入长度不对") }
        let ikm = ss + es + se + ee + Data([UInt8(pairingToken.count)]) + pairingToken
        let salt = sha256(Data("sikeoop/mobile/v1/kdf/salt\0".utf8) + transcriptHash)
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data("sikeoop/mobile/v1/session-key".utf8), outputByteCount: 32)
        return key.withUnsafeBytes { Data($0) }
    }
    static func deriveEcdh(privatePkcs8: Data, peerPublicSpki: Data) throws -> Data {
        let key = try P256.KeyAgreement.PrivateKey(derRepresentation: privatePkcs8)
        let peer = try P256.KeyAgreement.PublicKey(derRepresentation: peerPublicSpki)
        return try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
    }
    static func validateSessionId(_ value: String) throws {
        guard (8...128).contains(value.count), value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw LinkFailure.invalid("无效的 sessionId") }
    }
    static func nonce(_ direction: FrameDirection, _ counter: UInt64) -> Data {
        direction.prefix + Data((0..<8).map { UInt8(truncatingIfNeeded: counter >> (56 - $0 * 8)) })
    }
    static func aad(_ sessionId: String, _ direction: FrameDirection, _ counter: UInt64) -> Data {
        Data("sikeoop-mobile-v1\n\(sessionId)\n\(direction.rawValue)\n\(counter)".utf8)
    }
    static func seal(key: Data, sessionId: String, direction: FrameDirection, counter: UInt64, plaintext: Data) throws -> SealedFrame {
        try validateSessionId(sessionId)
        guard key.count == 32, plaintext.count <= maxFrameBytes else { throw LinkFailure.invalid("加密帧长度不对") }
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce(direction, counter)), authenticating: aad(sessionId, direction, counter))
        let frame = SealedFrame(version: 1, sessionId: sessionId, direction: direction.rawValue, counter: String(counter), ciphertext: encodeBase64Url(box.ciphertext), tag: encodeBase64Url(box.tag))
        guard try JSONEncoder().encode(frame).count <= maxFrameBytes else { throw LinkFailure.invalid("加密帧超过 1 MiB") }
        return frame
    }
    static func open(key: Data, frame: SealedFrame, expectedDirection: FrameDirection, expectedCounter: UInt64) throws -> Data {
        try validateSessionId(frame.sessionId)
        guard key.count == 32, frame.version == 1, frame.direction == expectedDirection.rawValue,
              frame.counter == String(expectedCounter), try JSONEncoder().encode(frame).count <= maxFrameBytes else { throw LinkFailure.invalid("收到重放、乱序或无效的帧") }
        let ciphertext = try decodeBase64Url(frame.ciphertext), tag = try decodeBase64Url(frame.tag)
        guard tag.count == 16 else { throw LinkFailure.invalid("认证标签长度不对") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce(expectedDirection, expectedCounter)), ciphertext: ciphertext, tag: tag)
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(frame.sessionId, expectedDirection, expectedCounter))
    }
}

/// Separate identity-signing and static-DH keys; raw private scalars never leave Keychain persistence.
struct DeviceIdentity {
    let deviceId: String
    let deviceName: String
    let signing: P256.Signing.PrivateKey
    let staticDh: P256.KeyAgreement.PrivateKey
    static func loadOrCreate(defaultName: String, secrets: SecretStore) throws -> DeviceIdentity {
        struct Stored: Codable { let deviceId: String; let deviceName: String; let signing: Data; let staticDh: Data }
        if let data = try secrets.load("identity") {
            let stored = try JSONDecoder().decode(Stored.self, from: data)
            return try DeviceIdentity(deviceId: stored.deviceId, deviceName: stored.deviceName, signing: P256.Signing.PrivateKey(rawRepresentation: stored.signing), staticDh: P256.KeyAgreement.PrivateKey(rawRepresentation: stored.staticDh))
        }
        let name = String(defaultName.prefix(64))
        let identity = try DeviceIdentity(deviceId: MobileCrypto.encodeBase64Url(MobileCrypto.randomBytes(16)), deviceName: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "iPhone" : name, signing: P256.Signing.PrivateKey(), staticDh: P256.KeyAgreement.PrivateKey())
        try secrets.save("identity", data: JSONEncoder().encode(Stored(deviceId: identity.deviceId, deviceName: identity.deviceName, signing: identity.signing.rawRepresentation, staticDh: identity.staticDh.rawRepresentation)))
        return identity
    }
}
