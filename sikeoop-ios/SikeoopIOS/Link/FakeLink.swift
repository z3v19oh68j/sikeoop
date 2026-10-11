import Foundation

/// 假数据源：中继还没接上之前，让界面先跑起来。
/// 点按钮会真的改状态——派活转圈、停下、审批消失，方便调界面。
final class FakeLink: LinkClient {

    @Published private(set) var state: LinkState = FakeLink.sample()

    func send(_ text: String) {
        state.online = true
        state.status = .working
        state.task = TaskSnapshot(
            instruction: text,
            plan: FakeLink.samplePlan(),
            current: "读相关代码",
            agents: [AgentInfo(name: "Claude-1", busy: true), AgentInfo(name: "Codex-1", busy: false)],
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self else { return }
            self.state.status = .done
            self.state.task?.current = "都做完了"
            self.state.receipts.insert(
                Receipt(
                    id: "r-\(Date().timeIntervalSince1970)",
                    time: "刚刚",
                    title: String(text.prefix(12)),
                    summary: "修好了，来看看。",
                    files: [
                        FileChange(path: "src/api/login.ts", kind: .modified),
                        FileChange(path: "tests/login.test.ts", kind: .added),
                    ],
                    blocked: ["git push：要你亲自发"],
                    decisions: ["用了现有 jest，没装新库"],
                ),
                at: 0,
            )
        }
    }

    func cancel() {
        state.status = .halted
        state.task?.current = "已停下"
    }

    func respondApproval(id: String, allow: Bool) {
        state.approvals.removeAll { $0.id == id }
        if state.approvals.isEmpty && state.status == .waiting {
            state.status = .working
        }
    }

    func undoTurn(receiptId: String) {
        state.receipts.removeAll { $0.id == receiptId }
        state.status = .idle
    }

    func pair(code: String) {
        state.paired = true
        state.pairing = .approved
        state.online = true
        state.status = .idle
    }

    func unpair() {
        state.paired = false
        state.pairing = .none
        state.online = false
        state.status = .offline
    }

    func reconnect() {
        state.online = true
        state.status = .idle
        state.project = "shop-web"
        state.lastSeen = "现在"
    }

    func clearNotice() {
        state.notice = nil
    }

    private static func samplePlan() -> [PlanStep] {
        [
            PlanStep(title: "读登录相关代码", state: .done),
            PlanStep(title: "复现报错", state: .done),
            PlanStep(title: "修配置加载顺序", state: .inProgress),
            PlanStep(title: "跑测试", state: .pending),
            PlanStep(title: "推送到远程", state: .pending, needsConfirm: true),
            PlanStep(title: "更新 README", state: .skipped),
        ]
    }

    private static func sample() -> LinkState {
        LinkState(
            paired: true,
            online: true,
            computerName: "我的 MacBook",
            project: "shop-web",
            mode: "懒人",
            status: .working,
            task: TaskSnapshot(
                instruction: "帮我修登录接口 500",
                plan: samplePlan(),
                current: "$ npm test · 12s",
                agents: [AgentInfo(name: "Claude-1", busy: true), AgentInfo(name: "Codex-1", busy: false)],
            ),
            approvals: [
                ApprovalItem(
                    id: "a1",
                    from: "Claude-1",
                    title: "想运行命令",
                    detail: "npm install express",
                    location: "shop-web",
                    secondsLeft: 92,
                ),
                ApprovalItem(
                    id: "a2",
                    from: "本鲸",
                    title: "想推送到 origin/main",
                    detail: "3 个提交",
                    location: "shop-web",
                    secondsLeft: 552,
                    humanOnly: true,
                ),
                ApprovalItem(
                    id: "a3",
                    from: "Codex-1",
                    title: "想改文件",
                    detail: "src/config.ts",
                    location: "shop-web",
                    secondsLeft: 0,
                    handledReason: "已回电脑上询问",
                ),
            ],
            receipts: [
                Receipt(
                    id: "r1",
                    time: "14:20",
                    title: "修登录 500",
                    summary: "修好了，登录不再 500。",
                    files: [
                        FileChange(path: "src/api/login.ts", kind: .modified, added: 12, removed: 4),
                        FileChange(path: "src/config.ts", kind: .modified, added: 3, removed: 3),
                        FileChange(path: "tests/login.test.ts", kind: .added, added: 41),
                    ],
                    approved: ["git push：你同意了，已推送"],
                    blocked: ["sudo npm i -g：要你自己来"],
                    decisions: ["用了现有 jest，没装新库"],
                ),
                Receipt(
                    id: "r2",
                    time: "昨天",
                    title: "加深色模式",
                    summary: "加好了，设置里能切。",
                    files: [FileChange(path: "src/theme.css", kind: .added)],
                ),
            ],
        )
    }
}
