import Foundation

// 配对 / 连接流程的逻辑层测试，跑在 macOS 上，不需要 Xcode 和模拟器：
//   swiftc 会把 Core / Link 里的模型和 FakeLink 编进来，模拟一遍真实走过的流程。
// 怎么跑见 ../../README.md。

var failures = 0

func expect(_ ok: Bool, _ name: String) {
    if ok {
        print("✅ \(name)")
    } else {
        print("❌ \(name)")
        failures += 1
    }
}

/// 跑一会儿主队列，让 FakeLink 里定时器触发的回调执行掉。
func spin(_ seconds: TimeInterval) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}

// ---- 配对流程 ----

let link = FakeLink()

link.unpair()
expect(!link.state.paired && link.state.status == .offline, "取消配对后：未配对、离线")

link.pair(code: "sikeoop://pair/abc123")
expect(link.state.pairing == .approved, "扫码配对：状态变成「已批准」")
expect(link.state.paired && link.state.online, "扫码配对：已配对、在线")
expect(link.state.status == .idle, "扫码配对：鲸鱼娘进入空闲")

link.unpair()
link.pair(code: "debug://placeholder")
expect(link.state.paired, "调试码也能走通配对")

// ---- 派活 → 做完 → 回执 ----

link.unpair()
link.pair(code: "sikeoop://pair/abc123")
let receiptsBefore = link.state.receipts.count

link.send("帮我修登录接口 500")
expect(link.state.status == .working, "派活后：状态变成「干活」")
expect(link.state.task?.instruction == "帮我修登录接口 500", "派活后：任务内容是刚才输入的话")

spin(3.2) // FakeLink 2.5 秒后宣布做完
expect(link.state.status == .done, "做完后：状态变成「做完」")
expect(link.state.receipts.count == receiptsBefore + 1, "做完后：多了一张回执")

let newReceipt = link.state.receipts.first
expect(newReceipt?.summary.isEmpty == false, "回执里有说人话的总结")
expect(newReceipt?.files.isEmpty == false, "回执里列了改动的文件")

// ---- 审批 ----

if let id = link.state.approvals.first?.id {
    link.respondApproval(id: id, allow: true)
    expect(!link.state.approvals.contains { $0.id == id }, "拍板后：这张审批卡消失")
}

// ---- 停下 / 撤销 ----

link.send("再修一个 bug")
link.cancel()
expect(link.state.status == .halted, "停下后：状态变成「没做完」")

if let id = link.state.receipts.first?.id {
    link.undoTurn(receiptId: id)
    expect(!link.state.receipts.contains { $0.id == id }, "撤销后：那张回执消失")
}

// ---- 断开 / 重连 ----

link.unpair()
expect(!link.state.paired && link.state.status == .offline, "忘记电脑后：未配对、离线")

link.pair(code: "sikeoop://pair/abc123")
link.reconnect()
expect(link.state.online && link.state.status == .idle, "重连后：在线、空闲")

// ---- 清提示 ----

link.clearNotice()
expect(link.state.notice == nil, "清提示后：提示消失")

if failures > 0 {
    print("\n共 \(failures) 条没过")
    exit(1)
}
print("\n配对 / 连接流程全部通过")
