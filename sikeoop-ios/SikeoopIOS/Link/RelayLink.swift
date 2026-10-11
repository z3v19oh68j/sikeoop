import Foundation
import Combine

/// Main-actor isolation covers every published mutation, including socket events.
@MainActor
final class RelayLink: @preconcurrency LinkClient {
    @Published private(set) var state = LinkState()
    private let store: LinkStore
    private let deviceName: String
    private let appVersion: String
    private var identity: DeviceIdentity?
    private var computer: PairedComputer?
    private var session: RelaySession?
    private var loop: Task<Void, Never>?
    private var wake: Task<Void, Error>?
    private var refreshJob: Task<Void, Never>?
    private var generation = UUID()

    init(store: LinkStore = LinkStore(), deviceName: String = "iPhone", appVersion: String = "0.1.0") {
        self.store = store; self.deviceName = deviceName; self.appVersion = appVersion
        do {
            computer = try store.computer()
            if let computer {
                state.paired = true; state.computerName = computer.computerName
                startLoop()
            }
        } catch { state.notice = error.localizedDescription }
    }
    private func deviceIdentity() throws -> DeviceIdentity {
        if let identity { return identity }
        let created = try store.identity(defaultName: deviceName)
        identity = created
        return created
    }
    private func stop() {
        generation = UUID()
        loop?.cancel(); loop = nil
        wake?.cancel(); wake = nil
        refreshJob?.cancel(); refreshJob = nil
        session?.close(); session = nil
    }
    private func startLoop() {
        stop()
        let token = generation
        loop = Task { [weak self] in
            var attempt = 0
            while let self, !Task.isCancelled, self.generation == token, let c = self.computer {
                let s = RelaySession()
                self.session = s
                let watch = Task { [weak self] in
                    for await event in s.events {
                        guard let self, self.generation == token, self.session === s else { return }
                        self.onEvent(event, session: s)
                    }
                }
                do {
                    try await s.open(computer: c, device: self.deviceIdentity())
                    guard self.generation == token, !Task.isCancelled else { s.close(); watch.cancel(); return }
                    attempt = 0
                    self.state.online = true; self.state.lastSeen = "现在"
                    try await self.afterConnect(s)
                    await watch.value
                } catch { s.close(error.localizedDescription) }
                watch.cancel()
                guard self.generation == token, !Task.isCancelled else { return }
                self.session = nil
                self.refreshJob?.cancel(); self.refreshJob = nil
                self.state.online = false; self.state.status = .offline
                if self.state.lastSeen == "现在" { self.state.lastSeen = Self.clock(Date()) }
                let delay = RelaySession.reconnectDelay(attempt: attempt)
                attempt = min(attempt + 1, 4)
                let sleeping = Task { try await Task.sleep(nanoseconds: delay) }
                self.wake = sleeping
                _ = try? await sleeping.value
                self.wake = nil
            }
        }
    }
    func reconnect() {
        guard computer != nil else { return }
        if let wake { wake.cancel() }
        else if loop == nil { startLoop() }
    }
    private func afterConnect(_ s: RelaySession) async throws {
        let d = try deviceIdentity()
        _ = try await s.call(Methods.initialize, params: ["protocolVersion": 1, "device": ["id": d.deviceId, "name": d.deviceName, "platform": "ios", "appVersion": appVersion, "signingPublicKey": MobileCrypto.encodeBase64Url(d.signing.publicKey.derRepresentation), "staticDhPublicKey": MobileCrypto.encodeBase64Url(d.staticDh.publicKey.derRepresentation)], "capabilities": [String]()])
        try await refresh(s)
    }
    private func onEvent(_ event: RelaySession.Event, session s: RelaySession) {
        switch event {
        case .notification(let method, let params):
            let p = params as? [String: Any] ?? [:]
            if method == "mobile.status" { applyView(p) }
            if method == "mobile.event", let e = p["event"] as? [String: Any], let type = e["type"] as? String,
               ["approval_request", "approval_result", "question", "question_answered", "turn_changes", "done", "error", "plan"].contains(type) {
                scheduleRefresh(s)
            }
        case .closed, .presence(desktopOnline: false): state.online = false; state.status = .offline
        default: break
        }
    }
    private func scheduleRefresh(_ s: RelaySession) {
        guard refreshJob == nil else { return }
        refreshJob = Task { [weak self] in
            defer { self?.refreshJob = nil }
            do { try await Task.sleep(nanoseconds: 300_000_000); try Task.checkCancellation() } catch { return }
            guard let self, self.session === s else { return }
            try? await self.refresh(s)
        }
    }
    private func refresh(_ s: RelaySession) async throws {
        guard let snap = try await s.call(Methods.sessionSnapshot, params: ["messageLimit": 20]) as? [String: Any] else { return }
        let agentResponse = try? await s.call(Methods.agentsList)
        guard session === s, !s.closed, !Task.isCancelled else { return }
        let agents = Self.array((agentResponse as? [String: Any])?["sessions"]).map { AgentInfo(name: $0["name"] as? String ?? "AI", busy: $0["status"] as? String == "working") }
        let view = snap["view"] as? [String: Any] ?? [:]
        applyView(view, agents: agents)
        let project = (view["project"] as? [String: Any])?["name"] as? String ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        state.approvals = Self.array(snap["approvals"]).compactMap { a in
            let status = a["status"] as? String ?? "pending"
            guard status != "approved", status != "rejected", let id = a["id"] as? String else { return nil }
            let remaining = max(0, ((a["deadlineAt"] as? NSNumber)?.doubleValue ?? now) - now) / 1000
            return ApprovalItem(id: id, from: a["source"] as? String == "terminal" ? "终端里的 AI" : "本鲸", title: a["title"] as? String ?? "要你拍板", detail: a["detail"] as? String ?? "", location: project, secondsLeft: Int(min(remaining, Double(Int32.max))), humanOnly: a["humanOnly"] as? Bool ?? false, handledReason: status == "expired" ? "已超时，回电脑上问" : status == "handled_elsewhere" ? (a["statusReason"] as? String ?? "已在电脑上处理") : nil)
        }
        try await loadReceipt(s, view: view)
    }
    private func applyView(_ v: [String: Any], agents: [AgentInfo]? = nil) {
        let status: WhaleStatus
        switch v["status"] as? String {
        case "working": status = .working
        case "waiting": status = .waiting
        case "done": status = .done
        case "error": status = .error
        case "incomplete": status = .halted
        default: status = .idle
        }
        state.online = true; state.status = status; state.lastSeen = "现在"
        state.computerName = (v["computer"] as? [String: Any])?["name"] as? String ?? state.computerName
        state.project = (v["project"] as? [String: Any])?["name"] as? String ?? ""
        if let turn = v["turn"] as? [String: Any] {
            let plan = Self.array(turn["plan"]).map { p -> PlanStep in
                let step: StepState
                switch p["status"] as? String {
                case "done": step = .done
                case "in_progress": step = .inProgress
                case "skipped": step = .skipped
                default: step = .pending
                }
                return PlanStep(title: p["text"] as? String ?? "", state: step)
            }
            state.task = TaskSnapshot(instruction: turn["prompt"] as? String ?? "", plan: plan, current: turn["currentActivity"] as? String ?? (status == .working ? "在想下一步" : ""), agents: agents ?? state.task?.agents ?? [])
        } else if status != .working { state.task = nil }
    }
    private func loadReceipt(_ s: RelaySession, view: [String: Any]) async throws {
        guard let r = view["lastReceipt"] as? [String: Any], let turnId = (r["turnId"] as? NSNumber)?.int64Value else { return }
        let id = "turn-\(turnId)"
        guard !state.receipts.contains(where: { $0.id == id }) else { return }
        let diff = try? await s.call(Methods.diffGet, params: ["turnId": turnId])
        guard session === s, !s.closed, !Task.isCancelled, !state.receipts.contains(where: { $0.id == id }) else { return }
        let files = Self.array((diff as? [String: Any])?["files"]).map { f -> FileChange in
            let lines = (f["unifiedDiff"] as? String ?? "").components(separatedBy: "\n")
            let kind: ChangeKind = f["before"] == nil || f["before"] is NSNull ? .added : f["after"] == nil || f["after"] is NSNull ? .deleted : .modified
            return FileChange(path: f["path"] as? String ?? "", kind: kind, added: lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count, removed: lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count)
        }
        let summary = (r["summary"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let time = (r["completedAt"] as? NSNumber)?.doubleValue ?? 0
        state.receipts.insert(Receipt(id: id, time: Self.clock(time > 0 ? Date(timeIntervalSince1970: time / 1000) : Date()), title: summary.isEmpty ? "第 \(turnId) 轮" : String((summary.components(separatedBy: "\n").first ?? summary).prefix(16)), summary: summary.isEmpty ? "做完了。" : summary, files: files), at: 0)
        state.receipts = Array(state.receipts.prefix(20))
    }

    func pair(code: String) {
        let qr: PairingQr
        do { qr = try PairingQr.parse(code) }
        catch { state.pairing = .failed; state.pairingError = error.localizedDescription; return }
        stop()
        state.online = false; state.status = .offline
        state.pairing = .connecting; state.pairingError = nil; state.computerName = qr.computer.computerName
        let token = generation
        let s = RelaySession(); session = s
        loop = Task { [weak self] in
            guard let self else { return }
            let deadline = Task {
                do { try await Task.sleep(nanoseconds: 310_000_000_000) } catch { return }
                s.close("电脑上一直没点「允许」，请重新扫码")
            }
            defer { deadline.cancel() }
            do {
                try await s.open(computer: qr.computer, device: self.deviceIdentity(), pairing: qr)
                for await event in s.events {
                    guard self.generation == token, !Task.isCancelled else { s.close(); return }
                    switch event {
                    case .closed(let reason): throw LinkFailure.invalid(reason)
                    case .notification(let method, let params) where method == "mobile.pairing":
                        let status = (params as? [String: Any])?["status"] as? String
                        if status == "pending" { self.state.pairing = .waitingApproval }
                        if status == "rejected" { throw LinkFailure.invalid("电脑上拒绝了这台手机") }
                        if status == "approved" {
                            try self.store.saveComputer(qr.computer)
                            self.computer = qr.computer
                            self.state.paired = true; self.state.pairing = .approved; self.state.pairingError = nil
                            s.close("配对完成")
                            self.startLoop()
                            return
                        }
                    default: break
                    }
                }
                throw LinkFailure.invalid("配对连接已断开")
            } catch {
                s.close(error.localizedDescription)
                guard self.generation == token, !Task.isCancelled else { return }
                self.state.pairing = .failed; self.state.pairingError = error.localizedDescription
                self.session = nil; self.loop = nil
                if self.computer != nil { self.startLoop() }
            }
        }
    }
    func unpair() {
        stop()
        do { try store.forgetComputer(); computer = nil; state = LinkState() }
        catch { state.online = false; state.status = .offline; state.notice = error.localizedDescription }
    }
    private func act(_ block: @escaping @MainActor (RelaySession) async throws -> Void) {
        guard let s = session, state.online else { state.notice = "电脑不在线"; return }
        let token = generation
        Task { [weak self] in
            do { try await block(s) }
            catch {
                guard let self, self.generation == token, self.session === s else { return }
                if let rpc = error as? RelaySession.RpcException {
                    switch rpc.code {
                    case -32001: self.state.notice = "电脑那边还在忙上一件事，等它做完再派"
                    case -32006: self.state.notice = "等电脑上点「允许」"
                    case -32005: self.state.notice = "这件事已经处理过了"
                    default: self.state.notice = rpc.message
                    }
                    try? await self.refresh(s)
                } else { self.state.notice = error.localizedDescription }
            }
        }
    }
    func send(_ text: String) {
        act { [weak self] s in
            _ = try await s.call(Methods.chatSend, params: ["requestId": UUID().uuidString, "text": text, "mode": "lazy"])
            if self?.session === s, !s.closed { self?.state.status = .working }
        }
    }
    func cancel() { act { s in _ = try await s.call(Methods.chatCancel, params: ["requestId": UUID().uuidString]) } }
    func respondApproval(id: String, allow: Bool) {
        act { [weak self] s in
            _ = try await s.call(Methods.approvalRespond, params: ["id": id, "approved": allow])
            guard let self, self.session === s else { return }
            self.state.approvals.removeAll { $0.id == id }; try await self.refresh(s)
        }
    }
    func undoTurn(receiptId: String) {
        guard receiptId.hasPrefix("turn-"), let turnId = Int64(receiptId.dropFirst(5)) else { return }
        act { [weak self] s in
            _ = try await s.call(Methods.turnUndo, params: ["turnId": turnId])
            guard let self, self.session === s else { return }
            self.state.receipts.removeAll { $0.id == receiptId }; self.state.notice = "已撤销这一轮"
            try await self.refresh(s)
        }
    }
    func clearNotice() { state.notice = nil }
    private static func array(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }
    private static func clock(_ date: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
}
