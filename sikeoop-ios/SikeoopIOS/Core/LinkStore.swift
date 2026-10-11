import Foundation
import Security

protocol SecretStore {
    func load(_ name: String) throws -> Data?
    func save(_ name: String, data: Data) throws
    func delete(_ name: String) throws
}

/// Device-only, non-synchronizable items: neither backup nor iCloud migration.
final class KeychainSecrets: SecretStore {
    private let service: String
    init(service: String = "com.sikeoop.mobile.link.v1") { self.service = service }
    private func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: name, kSecAttrSynchronizable as String: false]
    }
    func load(_ name: String) throws -> Data? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure(status) }
        return data
    }
    func save(_ name: String, data: Data) throws {
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(name) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query(name).merging(attrs) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw failure(added) }
        } else if status != errSecSuccess { throw failure(status) }
    }
    func delete(_ name: String) throws {
        let status = SecItemDelete(query(name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    }
    private func failure(_ status: OSStatus) -> LinkFailure { .invalid("钥匙串操作失败（\(status)）") }
}

final class LinkStore {
    private let secrets: SecretStore
    init(secrets: SecretStore = KeychainSecrets()) { self.secrets = secrets }
    func identity(defaultName: String) throws -> DeviceIdentity { try DeviceIdentity.loadOrCreate(defaultName: defaultName, secrets: secrets) }
    func computer() throws -> PairedComputer? {
        guard let raw = try secrets.load("computer") else { return nil }
        let computer = try JSONDecoder().decode(PairedComputer.self, from: raw)
        try computer.validate()
        return computer
    }
    /// Only approved pairing is persisted. QR pairId/token/expiry are never stored.
    func saveComputer(_ computer: PairedComputer) throws {
        try computer.validate()
        try secrets.save("computer", data: JSONEncoder().encode(computer))
    }
    func forgetComputer() throws { try secrets.delete("computer") }
}
