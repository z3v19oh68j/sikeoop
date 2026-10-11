import SwiftUI

/// 待办：要你拍板的卡（普通 / 撤不回 / 已在别处处理）+ 回执列表。对应设计稿 Todo。
struct TodoScreen: View {
    let state: LinkState
    var onRespond: (String, Bool) -> Void = { _, _ in }
    var onOpenReceipt: (Receipt) -> Void = { _ in }

    private var open: Int {
        state.approvals.filter { $0.handledReason == nil }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("待办")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(Sk.ink)
                Heading("要你拍板 · \(open)")
                    .padding(.top, 8)
                if state.approvals.isEmpty {
                    Text("没有要拍板的事，本鲸自己搞得定~")
                        .font(.system(size: 14))
                        .foregroundColor(Sk.muted)
                }
                ForEach(state.approvals) { a in
                    if a.handledReason != nil {
                        HandledCard(a: a)
                    } else if a.humanOnly {
                        HumanOnlyCard(a: a, onRespond: onRespond)
                    } else {
                        ApprovalCard(a: a, onRespond: onRespond)
                    }
                }
                Heading("回执")
                    .padding(.top, 12)
                if state.receipts.isEmpty {
                    Text("还没有回执")
                        .font(.system(size: 14))
                        .foregroundColor(Sk.muted)
                } else {
                    ReceiptList(receipts: state.receipts, onOpen: onOpenReceipt)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }
}

private struct Heading: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 15, weight: .medium))
            .foregroundColor(Sk.muted)
    }
}

private struct ApprovalCard: View {
    let a: ApprovalItem
    let onRespond: (String, Bool) -> Void

    var body: some View {
        SkCard {
            HStack {
                Text("\(a.from) \(a.title)")
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
                Spacer()
                Tag(fmtSeconds(a.secondsLeft), bg: Sk.warnSoft, fg: Sk.warn, mono: true)
            }
            Text(a.detail)
                .font(.system(size: 15, design: .monospaced))
                .foregroundColor(Sk.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Sk.codeBg, in: RoundedRectangle(cornerRadius: 12))
            Text("位置 \(a.location) · 超时会回到电脑上问")
                .font(.system(size: 13))
                .foregroundColor(Sk.muted)
            TwoButtons(no: "拒绝", yes: "同意", onNo: { onRespond(a.id, false) }, onYes: { onRespond(a.id, true) })
        }
    }
}

/// 推送、发布这类撤不回的操作：红色描边、锁形标记，同意前要先解锁手机。
private struct HumanOnlyCard: View {
    let a: ApprovalItem
    let onRespond: (String, Bool) -> Void

    var body: some View {
        SkCard(border: Sk.accent, borderWidth: 1.5) {
            HStack {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 16))
                        .foregroundColor(Sk.warn)
                    Text("撤不回 · 同意前要先解锁")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Sk.warn)
                }
                Spacer()
                Tag(fmtSeconds(a.secondsLeft), bg: Sk.codeBg, fg: Sk.muted, mono: true)
            }
            Text("\(a.from)\(a.title)")
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(Sk.ink)
            Text(a.detail)
                .font(.system(size: 14, design: .monospaced))
                .foregroundColor(Sk.ink2)
            Text("位置 \(a.location) · 超时没回按拒绝处理")
                .font(.system(size: 13))
                .foregroundColor(Sk.muted)
            TwoButtons(no: "拒绝", yes: "解锁并同意", onNo: { onRespond(a.id, false) }, onYes: { onRespond(a.id, true) })
        }
    }
}

/// 已超时或在电脑、微信上处理过：灰底虚线，没有按钮。
private struct HandledCard: View {
    let a: ApprovalItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(a.from) \(a.title)")
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
                Spacer()
                Text(a.secondsLeft <= 0 ? "已超时" : "已处理")
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
            }
            Text(a.detail)
                .font(.system(size: 14, design: .monospaced))
                .foregroundColor(Sk.muted)
            Text(a.handledReason ?? "")
                .font(.system(size: 13))
                .foregroundColor(Sk.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Sk.grayCard, in: RoundedRectangle(cornerRadius: 20))
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(
                    Sk.btnLine,
                    style: StrokeStyle(lineWidth: 1, dash: [8, 6])
                )
        )
    }
}

private struct TwoButtons: View {
    let no: String
    let yes: String
    let onNo: () -> Void
    let onYes: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            SecondaryPill(no, action: onNo, minHeight: 48)
            PrimaryPill(yes, action: onYes, minHeight: 48)
        }
    }
}

private struct ReceiptList: View {
    let receipts: [Receipt]
    let onOpen: (Receipt) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(receipts.enumerated()), id: \.element.id) { i, r in
                Button {
                    onOpen(r)
                } label: {
                    HStack(spacing: 12) {
                        Text(r.time)
                            .font(.system(size: 13))
                            .foregroundColor(Sk.muted)
                            .frame(width: 40, alignment: .leading)
                            .lineLimit(1)
                        Text(r.title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Sk.ink)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("改 \(r.files.count) 个文件")
                            .font(.system(size: 13))
                            .foregroundColor(Sk.muted)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(Sk.faint)
                    }
                    .frame(minHeight: 64)
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if i < receipts.count - 1 {
                    Rectangle().fill(Sk.divider).frame(height: 1)
                }
            }
        }
        .background(Sk.card, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Sk.cardLine, lineWidth: 1))
    }
}

#Preview {
    TodoScreen(state: FakeLink().state)
}
