import Foundation
import CryptoKit

// From project root:
// swiftc sikeoop-ios/SikeoopIOS/Core/Crypto/*.swift sikeoop-ios/SikeoopIOS/Core/LinkStore.swift sikeoop-ios/SikeoopIOS/Core/Messages.swift sikeoop-ios/Tests/CryptoVectorTest/main.swift -o /tmp/sikeoop-crypto-vector-test
// /tmp/sikeoop-crypto-vector-test protocol/crypto-vectors.json

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
func unhex(_ string: String) throws -> Data {
    guard string.count % 2 == 0 else { throw LinkFailure.invalid("Odd hex length") }
    var result = Data(); var index = string.startIndex
    while index < string.endIndex {
        let end = string.index(index, offsetBy: 2)
        guard let b = UInt8(string[index..<end], radix: 16) else { throw LinkFailure.invalid("Invalid hex") }
        result.append(b); index = end
    }
    return result
}
var checks = 0
func check(_ condition: Bool, _ label: String) throws {
    guard condition else { throw LinkFailure.invalid("FAIL: \(label)") }
    checks += 1; print("PASS: \(label)")
}
struct Vector: Decodable {
    let curve: String
    let privateKeysPkcs8DerBase64Url: [String]
    let publicKeysSpkiDerBase64Url: [String]
    let publicPointsUncompressedHex: [String]
    let keyRoles: [String: Int]
    let ecdhSecretsHex: [String: String]
    let pairingTokenHex: String
    let transcriptHashHex: String
    let sessionKeyHex: String
    struct Frame: Decodable {
        let version: Int; let sessionId: String; let direction: String; let counter: String
        let ciphertext: String; let tag: String; let plaintextUtf8: String
        var sealed: SealedFrame { SealedFrame(version: version, sessionId: sessionId, direction: direction, counter: counter, ciphertext: ciphertext, tag: tag) }
    }
    let frame: Frame
}

do {
    let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "protocol/crypto-vectors.json"
    let raw = try Data(contentsOf: URL(fileURLWithPath: path))
    let decoder = JSONDecoder()
    // Accept both the current single fixture and a future fixture array, without skipping entries.
    let vectors: [Vector]
    if (try JSONSerialization.jsonObject(with: raw)) is [Any] { vectors = try decoder.decode([Vector].self, from: raw) }
    else { vectors = [try decoder.decode(Vector.self, from: raw)] }
    try check(!vectors.isEmpty, "vectors present")
    for (number, v) in vectors.enumerated() {
        try check(v.curve == "secp256r1", "vector \(number): curve")
        let priv = try v.privateKeysPkcs8DerBase64Url.map(MobileCrypto.decodeBase64Url)
        let pub = try v.publicKeysSpkiDerBase64Url.map(MobileCrypto.decodeBase64Url)
        try check(priv.count == pub.count && pub.count == v.publicPointsUncompressedHex.count, "key array lengths")
        for i in priv.indices {
            let key = try P256.KeyAgreement.PrivateKey(derRepresentation: priv[i])
            try check(key.publicKey.derRepresentation == pub[i], "key \(i): PKCS8 → SPKI")
            try check(hex(key.publicKey.x963Representation) == v.publicPointsUncompressedHex[i], "key \(i): uncompressed point")
            let signing = try P256.Signing.PrivateKey(derRepresentation: priv[i])
            try check(signing.publicKey.derRepresentation == pub[i], "key \(i): signing SPKI")
        }
        func role(_ name: String) throws -> Int {
            guard let i = v.keyRoles[name], priv.indices.contains(i) else { throw LinkFailure.invalid("Invalid role \(name)") }
            return i
        }
        let ps = try role("phoneStatic"), pe = try role("phoneEphemeral"), cs = try role("computerStatic"), ce = try role("computerEphemeral")
        var secrets: [String: Data] = [:]
        for (name, a, b) in [("ss", ps, cs), ("es", pe, cs), ("se", ps, ce), ("ee", pe, ce)] {
            let secret = try MobileCrypto.deriveEcdh(privatePkcs8: priv[a], peerPublicSpki: pub[b])
            try check(hex(secret) == v.ecdhSecretsHex[name], "ECDH \(name)")
            try check(secret == MobileCrypto.deriveEcdh(privatePkcs8: priv[b], peerPublicSpki: pub[a]), "ECDH \(name): symmetric")
            secrets[name] = secret
        }
        let key = try MobileCrypto.deriveSessionKey(ss: secrets["ss"]!, es: secrets["es"]!, se: secrets["se"]!, ee: secrets["ee"]!, transcriptHash: unhex(v.transcriptHashHex), pairingToken: unhex(v.pairingTokenHex))
        try check(hex(key) == v.sessionKeyHex, "HKDF session key")
        guard let direction = FrameDirection(rawValue: v.frame.direction), let counter = UInt64(v.frame.counter) else { throw LinkFailure.invalid("Invalid fixture direction/counter") }
        let frame = try MobileCrypto.seal(key: key, sessionId: v.frame.sessionId, direction: direction, counter: counter, plaintext: Data(v.frame.plaintextUtf8.utf8))
        try check(frame == v.frame.sealed, "AES-256-GCM: byte-identical ciphertext/tag and metadata")
        let opened = try MobileCrypto.open(key: key, frame: v.frame.sealed, expectedDirection: direction, expectedCounter: counter)
        try check(opened == Data(v.frame.plaintextUtf8.utf8), "AES-256-GCM: open fixture")
    }
    print("ALL VECTORS PASS (\(vectors.count) vectors, \(checks) checks)")
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
