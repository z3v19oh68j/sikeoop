import SwiftUI

/// 任务详情：计划四态、现在在跑什么、终端里的小伙伴。对应设计稿 TaskDetail。
struct TaskDetailScreen: View {
    let state: LinkState
    var onBack: () -> Void = {}
    var onStop: () -> Void = {}
    var onOpenChat: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            BackHeader(title: "任务详情", onBack: onBack) {
                if state.task != nil {
                    SecondaryPill(
                        "停下",
                        action: onStop,
                        minHeight: 40,
                        border: Sk.accent,
                        color: Sk.warn,
                        fontSize: 14,
                        weight: .medium,
                    )
                    .frame(width: 88)
                }
            }
            if let task = state.task {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(task.instruction)
                            .font(.system(size: 24, weight: .bold))
                            .foregroundColor(Sk.ink)
                            .fixedSize(horizontal: false, vertical: true)

                        SkCard(radius: 20, padding: 16, gap: 0) {
                            HStack {
                                Text("计划")
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundColor(Sk.ink)
                                Spacer()
                                Text("\(task.plan.filter { $0.state == .done }.count) / \(task.plan.count)")
                                    .font(.system(size: 13))
                                    .foregroundColor(Sk.muted)
                            }
                            .padding(.bottom, 8)
                            ForEach(task.plan) { step in
                                StepRow(step: step)
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            SectionLabel("现在")
                            Text(task.current)
                                .font(.system(size: 14, design: .monospaced))
                                .foregroundColor(Sk.ring)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .background(Sk.ink, in: RoundedRectangle(cornerRadius: 16))
                        }

                        if !task.agents.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                SectionLabel("终端里的小伙伴")
                                let rows = task.agents.chunked(into: 2)
                                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                                    HStack(spacing: 10) {
                                        ForEach(row) { a in
                                            SkCard(radius: 16, padding: 12, gap: 4) {
                                                Text(a.name)
                                                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                                                    .foregroundColor(Sk.ink)
                                                Text(a.busy ? "● 干活中" : "○ 空闲")
                                                    .font(.system(size: 13))
                                                    .foregroundColor(a.busy ? Sk.warn : Sk.muted)
                                            }
                                        }
                                        if row.count == 1 {
                                            Color.clear.frame(maxWidth: .infinity)
                                        }
                                    }
                                }
                            }
                        }

                        Button(action: onOpenChat) {
                            HStack {
                                Text("看完整对话")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundColor(Sk.ink)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(Sk.faint)
                            }
                            .frame(minHeight: 56)
                            .padding(.horizontal, 16)
                            .background(Sk.card, in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Sk.cardLine, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
            } else {
                Spacer()
                Text("现在没有在跑的任务")
                    .font(.system(size: 15))
                    .foregroundColor(Sk.muted)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }
}

private struct StepRow: View {
    let step: PlanStep

    private var current: Bool { step.state == .inProgress }

    var body: some View {
        HStack(spacing: 12) {
            stateIcon
            Text(step.title + (step.state == .skipped ? "（跳过）" : ""))
                .font(.system(size: 15, weight: current ? .bold : .regular))
                .foregroundColor(titleColor)
                .strikethrough(step.state == .skipped)
                .frame(maxWidth: .infinity, alignment: .leading)
            if step.needsConfirm && step.state != .done && step.state != .skipped {
                Tag("要你确认", bg: Sk.warnSoft, fg: Sk.warn, fontSize: 12)
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, current ? 10 : 0)
        .background(current ? Sk.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch step.state {
        case .done:
            ZStack {
                Circle().fill(Sk.blue).frame(width: 22, height: 22)
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
            }
        case .inProgress:
            ZStack {
                Circle().strokeBorder(Sk.accent, lineWidth: 2).frame(width: 22, height: 22)
                Circle().fill(Sk.accent).frame(width: 8, height: 8)
            }
        case .pending:
            Circle().strokeBorder(Sk.pending, lineWidth: 2).frame(width: 22, height: 22)
        case .skipped:
            Image(systemName: "minus")
                .font(.system(size: 16))
                .foregroundColor(Sk.faint)
                .frame(width: 22, height: 22)
        }
    }

    private var titleColor: Color {
        switch step.state {
        case .done: return Sk.muted
        case .skipped: return Sk.faint
        default: return Sk.ink
        }
    }
}

private extension Array {
    /// 把数组切成每份 n 个的一行行，用来画两列小组件。
    func chunked(into n: Int) -> [[Element]] {
        stride(from: 0, to: count, by: n).map {
            Array(self[$0..<Swift.min($0 + n, count)])
        }
    }
}

#Preview {
    TaskDetailScreen(state: FakeLink().state)
}
