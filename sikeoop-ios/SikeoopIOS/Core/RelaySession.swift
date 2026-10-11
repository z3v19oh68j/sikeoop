import Foundation

/// A session is single-use. All counters and socket operations are main-actor serialized.
/// RelayLink owns the reconnect loop; every attempt creates a fresh instance/handshake.
@MainActor
final class RelaySession {
    enum Event {
        case notification(method: String, params: Any?)
        case presence(desktopOnline: Bool)
        case closed(reason: String)
    }
    struct RpcException: LocalizedError {
        let code: Int
        let message: String
        var errorDescription: String? { message }
    }
    static func reconnectDelay(attempt: Int) -> UInt64 {
        // Android's bounded exponential schedule: 1, 2, 5, 10, 30 seconds.
        [1, 2, 5, 10, 30][min(max(attempt, 0), 4)] * 1_000_000_000
    }
    let events: AsyncStream<Event>
    private let emitter: AsyncStream<Event>.Continuation
    private var webSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var outgoing: Task<Void, Error>?
    private var keys: SessionKeys?
    private var sendCounter: UInt64 = 0
    private var recvCounter: UInt64 = 0
    private var nextId: UInt64 = 1
    private var pending: [RpcId: CheckedContinuation<Any, Error>] = [:]
    private var timeouts: [RpcId: Task<Void, Never>] = [:]
    private(set) var closed = false
    private var started = false

    init() {
        var continuation: AsyncStream<Event>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingOldest(512)) { continuation = $0 }
        emitter = continuation
    }

    func open(computer: PairedComputer, device: DeviceIdentity, pairing: PairingQr? = nil, timeout: TimeInterval = 15) async throws {
        guard !started, !closed else { throw LinkFailure.invalid("会话已经用过") }
        started = true
        let hs = try PhoneHandshake(computer: computer, device: device, pairing: pairing)
        let url = try PairedComputer.validatedRelayURL(computer.relayUrl)
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        let session = URLSession(configuration: config)
        webSession = session
        let ws = session.webSocketTask(with: url)
        ws.maximumMessageSize = MobileCrypto.maxFrameBytes
        socket = ws; ws.resume()
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
            self?.close("连接握手超时")
        }
        defer { deadline.cancel() }
        do {
            try await withTaskCancellationHandler(operation: {
                try await sendObject(["type": "join", "protocolVersion": 1, "roomId": computer.roomId, "roomToken": computer.roomToken, "role": "mobile"])
                while true {
                    let o = try await receiveObject()
                    if o["type"] as? String == "joined" { break }
                    try handleControl(o)
                }
                try await sendHandshake(hs.hello())
                var challenge: [String: Any]?
                while challenge == nil {
                    let o = try await receiveObject()
                    if o["type"] as? String == "forward", o["from"] as? String == "desktop",
                       let env = o["envelope"] as? [String: Any], env["type"] as? String == "handshake" {
                        challenge = try decodeHandshake(env)
                    } else { try handleControl(o) }
                }
                let auth = try hs.answer(challenge!)
                keys = hs.session
                try await sendHandshake(auth)
                guard !closed else { throw LinkFailure.invalid("连接已经断了") }
                reader = Task { [weak self] in await self?.receiveLoop() }
            }, onCancel: { Task { @MainActor [weak self] in self?.close("连接已取消") } })
        } catch {
            close(error.localizedDescription)
            throw error
        }
    }

    private func sendHandshake(_ object: [String: Any]) async throws {
        let raw = try WireJSON.encode(object)
        guard raw.count <= 32768 else { throw LinkFailure.invalid("握手消息太长") }
        try await sendObject(["type": "handshake", "payload": MobileCrypto.encodeBase64Url(raw)])
    }
    private func decodeHandshake(_ envelope: [String: Any]) throws -> [String: Any] {
        guard let payload = envelope["payload"] as? String, payload.utf8.count <= 43691 else { throw LinkFailure.invalid("握手消息太长") }
        let raw = try MobileCrypto.decodeBase64Url(payload)
        guard raw.count <= 32768 else { throw LinkFailure.invalid("握手消息太长") }
        return try WireJSON.object(raw)
    }
    private func sendObject(_ object: [String: Any]) async throws {
        try await enqueueObject(object).value
    }
    private func enqueueObject(_ object: [String: Any]) throws -> Task<Void, Error> {
        guard !closed, let ws = socket else { throw LinkFailure.invalid("连接已经断了") }
        let data = try WireJSON.encode(object)
        guard data.count <= MobileCrypto.maxFrameBytes else { throw LinkFailure.invalid("中继消息超过 1 MiB") }
        guard let text = String(data: data, encoding: .utf8) else { throw LinkFailure.invalid("JSON 编码失败") }
        let previous = outgoing
        let send = Task {
            if let previous { try await previous.value }
            try Task.checkCancellation()
            try await ws.send(.string(text))
        }
        outgoing = send
        return send
    }
    private func receiveObject() async throws -> [String: Any] {
        guard !closed, let ws = socket else { throw LinkFailure.invalid("连接已经断了") }
        let message = try await ws.receive()
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw LinkFailure.invalid("未知的中继消息")
        }
        guard data.count <= MobileCrypto.maxFrameBytes else { throw LinkFailure.invalid("中继消息太长") }
        return try WireJSON.object(data)
    }
    private func handleControl(_ o: [String: Any]) throws {
        switch o["type"] as? String {
        case "error":
            let code = o["code"] as? String ?? "UNKNOWN"
            let reasons = ["ROOM_NOT_FOUND": "电脑不在线（电脑上的手机连接没打开）", "AUTH_FAILED": "电脑换了配对信息，请重新扫码", "ROLE_BUSY": "已经有一台手机连着这台电脑", "KICKED": "电脑断开了这台手机（没通过验证，或已被移除）"]
            throw LinkFailure.invalid(reasons[code] ?? "中继拒绝了连接（\(code)）")
        case "presence":
            if o["role"] as? String == "desktop" {
                let online = o["online"] as? Bool ?? false
                emit(.presence(desktopOnline: online))
                if !online { throw LinkFailure.invalid("电脑断开了") }
            }
        default: break
        }
    }
    private func receiveLoop() async {
        do {
            while !closed {
                let o = try await receiveObject()
                try handleControl(o)
                guard o["type"] as? String == "forward" else { continue }
                guard o["from"] as? String == "desktop", let env = o["envelope"] as? [String: Any], env["type"] as? String == "data", let frame = env["frame"] as? [String: Any] else { throw LinkFailure.invalid("握手后收到无效的中继消息") }
                try onFrame(frame)
            }
        } catch { close(error.localizedDescription) }
    }
    private func onFrame(_ object: [String: Any]) throws {
        guard let keys, recvCounter < UInt64.max else { throw LinkFailure.invalid("会话不可用") }
        let data = try WireJSON.encode(object)
        guard data.count <= MobileCrypto.maxFrameBytes else { throw LinkFailure.invalid("加密帧超过 1 MiB") }
        let frame = try JSONDecoder().decode(SealedFrame.self, from: data)
        guard frame.sessionId == keys.sessionId else { throw LinkFailure.invalid("会话 ID 不匹配") }
        let raw = try MobileCrypto.open(key: keys.key, frame: frame, expectedDirection: .desktopToMobile, expectedCounter: recvCounter)
        recvCounter += 1 // Never advance before successful authentication.
        let msg = try WireJSON.object(raw)
        guard msg["jsonrpc"] as? String == "2.0" else { throw LinkFailure.invalid("无效的 RPC 消息") }
        if let method = msg["method"] as? String {
            emit(.notification(method: method, params: msg["params"]))
        } else if let id = RpcId(msg["id"]), let waiter = pending.removeValue(forKey: id) {
            timeouts.removeValue(forKey: id)?.cancel()
            if let err = msg["error"] as? [String: Any] {
                waiter.resume(throwing: RpcException(code: err["code"] as? Int ?? -1, message: err["message"] as? String ?? "电脑那边出错了"))
            } else { waiter.resume(returning: msg["result"] ?? NSNull()) }
        }
    }
    func call(_ method: String, params: [String: Any] = [:], timeout: TimeInterval = 20) async throws -> Any {
        try Task.checkCancellation()
        guard !closed, let keys, sendCounter < UInt64.max, nextId < UInt64.max else { throw LinkFailure.invalid("还没连上电脑") }
        let id = RpcId.string(String(nextId)); nextId += 1
        let raw = try WireJSON.encode(["jsonrpc": "2.0", "id": id.value, "method": method, "params": params])
        let frame = try MobileCrypto.seal(key: keys.key, sessionId: keys.sessionId, direction: .mobileToDesktop, counter: sendCounter, plaintext: raw)
        sendCounter += 1
        let frameObject = try WireJSON.object(JSONEncoder().encode(frame))
        return try await withTaskCancellationHandler(operation: {
            return try await withCheckedThrowingContinuation { waiter in
                pending[id] = waiter
                timeouts[id] = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
                    self?.finish(id, error: LinkFailure.invalid("电脑响应超时"))
                }
                do {
                    // Reserve the send chain synchronously with the counter allocation.
                    let sent = try enqueueObject(["type": "data", "frame": frameObject])
                    Task { [weak self] in
                        do { try await sent.value } catch { self?.close(error.localizedDescription) }
                    }
                } catch { close(error.localizedDescription) }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.close("请求已取消") } })
    }
    private func emit(_ event: Event) {
        if case .dropped = emitter.yield(event) { close("通知积压过多，已断开重连") }
    }
    private func finish(_ id: RpcId, error: Error) {
        timeouts.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }
    func close(_ reason: String = "已断开") {
        guard !closed else { return }
        closed = true
        reader?.cancel(); reader = nil
        outgoing?.cancel(); outgoing = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        webSession?.invalidateAndCancel(); webSession = nil
        keys = nil
        for id in Array(pending.keys) { finish(id, error: LinkFailure.invalid(reason)) }
        emitter.yield(.closed(reason: reason)); emitter.finish()
    }
}
