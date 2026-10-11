import SwiftUI

/// 首页卡片的一种样子，对应设计稿 Main 的 S 表。
private struct HomeCard {
    var kicker: String
    var meta: String
    var title: String
    var body: String
    var mono: Bool = false
    var progress: Double? = nil
    var secondary: String? = nil
    var primary: String
    var onSecondary: () -> Void = {}
    var onPrimary: () -> Void = {}
}

private extension WhaleStatus {
    var homeLabel: String {
        switch self {
        case .idle: return "空闲"
        case .working: return "干活中"
        case .waiting: return "等你拍板"
        case .done: return "做完了"
        case .error: return "出错"
        case .halted: return "没做完"
        case .offline: return "电脑不在线"
        }
    }
}

/// 首页「本鲸」：状态头像、一张状态卡、快捷指令、输入框。
struct HomeScreen: View {
    let state: LinkState
    var onSend: (String) -> Void = { _ in }
    var onStop: () -> Void = {}
    var onReconnect: () -> Void = {}
    var onOpenTask: () -> Void = {}
    var onOpenReceipt: (Receipt) -> Void = { _ in }
    var onRespond: (String, Bool) -> Void = { _, _ in }

    @State private var text = ""

    private var offline: Bool {
        !state.online || state.status == .offline
    }

    private var status: WhaleStatus {
        offline ? .offline : state.status
    }

    var body: some View {
        VStack(spacing: 0) {
            // 顶部：电脑胶囊 + 懒人模式
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    HStack(spacing: 8) {
                        Dot(color: offline ? Sk.faint : Sk.online)
                        Text(state.computerName)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Sk.ink)
                        Text(offline ? "离线" : "在线")
                            .font(.system(size: 13))
                            .foregroundColor(Sk.muted)
                    }
                    .frame(minHeight: 44)
                    .padding(.leading, 12)
                    .padding(.trailing, 14)
                    .background(Sk.card, in: Capsule())
                    .overlay(Capsule().strokeBorder(Sk.fieldLine, lineWidth: 1))
                    Spacer()
                    Tag(state.mode + "模式", bg: Sk.blueSoft, fg: Sk.blueInk, fontSize: 13)
                }
                HStack(spacing: 0) {
                    Text("项目 ")
                        .font(.system(size: 13))
                        .foregroundColor(Sk.muted)
                    Text(state.project.isEmpty ? "还没打开" : state.project)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(Sk.ink)
                }
                .padding(.leading, 4)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)

            // 中间：头像、台词、卡片
            ScrollView {
                VStack(spacing: 0) {
                    WhaleAvatar(status: status, size: 196)
                        .padding(.top, 8)
                    Spacer().frame(height: 18)
                    Text(status.speech)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(Sk.ink)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(Sk.card, in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Sk.fieldLine, lineWidth: 1))
                    Spacer().frame(height: 6)
                    Text(status.homeLabel)
                        .font(.system(size: 12))
                        .foregroundColor(Sk.muted)
                        .tracking(1)
                    Spacer().frame(height: 18)
                    StatusCard(card: homeCard())
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 20)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 快捷指令
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(["继续", "停下", "跑测试修一下", "总结改了啥"], id: \.self) { cmd in
                        SecondaryPill(
                            cmd,
                            action: { if cmd == "停下" { onStop() } else { onSend(cmd) } },
                            minHeight: 40,
                            border: Sk.fieldLine,
                            fontSize: 14,
                            enabled: !offline,
                        )
                    }
                }
                .padding(.horizontal, 20)
            }
            .padding(.top, 14)

            // 输入框。统一规则第 4 条：电脑不在线时禁用。
            HStack(spacing: 8) {
                ZStack(alignment: .leading) {
                    if text.isEmpty {
                        Text(offline ? "电脑不在线，暂时不能派活" : "说一句话派活…")
                            .font(.system(size: 15))
                            .foregroundColor(Sk.faint)
                    }
                    TextField("", text: $text, axis: .vertical)
                        .font(.system(size: 15))
                        .foregroundColor(Sk.ink)
                        .lineLimit(1...3)
                        .tint(Sk.accent)
                        .disabled(offline)
                }
                Button {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        onSend(trimmed)
                        text = ""
                    }
                } label: {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundColor(.white)
                        .frame(width: 44, height: 44)
                        .background(Sk.primary, in: Circle())
                }
                .disabled(offline)
            }
            .padding(.leading, 18)
            .padding(.top, 4)
            .padding(.bottom, 4)
            .padding(.trailing, 4)
            .background(Sk.card, in: RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(Sk.fieldLine, lineWidth: 1))
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 14)
            .opacity(offline ? 0.45 : 1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }

    private func homeCard() -> HomeCard {
        let task = state.task
        let receipt = state.receipts.first
        let total = task?.plan.count ?? 0
        let stepNo: Int = {
            guard let plan = task?.plan else { return 0 }
            if let i = plan.firstIndex(where: { $0.state == .inProgress }) {
                return i + 1
            }
            return plan.filter { $0.state == .done || $0.state == .skipped }.count
        }()

        switch status {
        case .working:
            return HomeCard(
                kicker: "计划 \(stepNo)/\(total)",
                meta: task?.agents.first(where: { $0.busy })?.name ?? "",
                title: task?.plan.first(where: { $0.state == .inProgress })?.title ?? task?.instruction ?? "",
                body: "正在" + (task?.current ?? "准备"),
                mono: true,
                progress: total > 0 ? Double(max(stepNo - 1, 0)) / Double(total) + 0.5 / Double(total) : 0,
                secondary: "停下",
                primary: "详情",
                onSecondary: onStop,
                onPrimary: onOpenTask,
            )
        case .waiting:
            let a = state.approvals.first(where: { $0.handledReason == nil })
            return HomeCard(
                kicker: a.map { "\($0.from) \($0.title)" } ?? "有事要你拍板",
                meta: a.map { "还剩 " + fmtSeconds($0.secondsLeft) } ?? "",
                title: a?.detail ?? "去「待办」处理",
                body: "位置：" + (a?.location ?? state.project),
                secondary: "拒绝",
                primary: "同意",
                onSecondary: { if let a { onRespond(a.id, false) } },
                onPrimary: { if let a { onRespond(a.id, true) } },
            )
        case .done:
            return HomeCard(
                kicker: "回执 · " + (receipt?.time ?? ""),
                meta: receipt.map { "改了 \($0.files.count) 个文件" } ?? "",
                title: receipt?.summary ?? "做完了",
                body: receipt.map { $0.blocked.isEmpty ? "没有被拦下的事" : "有 \($0.blocked.count) 件事被拦下，要你自己来" } ?? "",
                primary: "看回执",
                onPrimary: { if let receipt { onOpenReceipt(receipt) } },
            )
        case .error:
            return HomeCard(
                kicker: "任务中断",
                meta: "",
                title: "模型拒绝回答这一步", // 接口里没有出错原因，先用常量
                body: "换个说法再派一次，或者在电脑上看看",
                secondary: "看详情",
                primary: "重试",
                onSecondary: onOpenTask,
                onPrimary: { if let t = task?.instruction { onSend(t) } },
            )
        case .halted:
            let rest = task?.plan.filter { $0.state == .pending || $0.state == .inProgress } ?? []
            return HomeCard(
                kicker: "已停下",
                meta: total > 0 ? "计划 \(stepNo)/\(total)" : "",
                title: "步数用完了", // 接口里没有停下原因，先用常量
                body: rest.isEmpty ? "还差几步没做" : "还差：" + rest.map(\.title).joined(separator: "、"),
                secondary: "看详情",
                primary: "继续",
                onSecondary: onOpenTask,
                onPrimary: { onSend("继续") },
            )
        case .offline:
            return HomeCard(
                kicker: "上次在线",
                meta: "",
                title: state.lastSeen.isEmpty ? "不久前" : state.lastSeen,
                body: "电脑醒来后会自动连上",
                primary: "重新连接",
                onPrimary: onReconnect,
            )
        case .idle:
            if let receipt {
                return HomeCard(
                    kicker: "最近一条回执",
                    meta: receipt.time,
                    title: receipt.title,
                    body: "改了 \(receipt.files.count) 个文件",
                    primary: "看回执",
                    onPrimary: { onOpenReceipt(receipt) },
                )
            }
            return HomeCard(
                kicker: "还没有回执",
                meta: "",
                title: "派个活试试",
                body: "在下面说一句话就行",
                primary: "跑测试修一下",
                onPrimary: { onSend("跑测试修一下") },
            )
        }
    }
}

private struct StatusCard: View {
    let card: HomeCard

    var body: some View {
        SkCard {
            HStack {
                Text(card.kicker)
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
                Spacer()
                if !card.meta.isEmpty {
                    Text(card.meta)
                        .font(.system(size: 12))
                        .foregroundColor(Sk.muted)
                }
            }
            Text(card.title)
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(Sk.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let progress = card.progress {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3).fill(Sk.divider)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Sk.accent)
                            .frame(width: geo.size.width * min(max(progress, 0), 1))
                    }
                }
                .frame(height: 6)
            }
            Text(card.body)
                .font(card.mono ? .system(size: 14, design: .monospaced) : .system(size: 14))
                .foregroundColor(Sk.ink2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Spacer()
                if let secondary = card.secondary {
                    SecondaryPill(secondary, action: card.onSecondary)
                }
                PrimaryPill(card.primary, action: card.onPrimary)
            }
        }
    }
}

#Preview {
    HomeScreen(state: FakeLink().state)
}
