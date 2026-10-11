import SwiftUI

/// 底部标签。「项目」是 B 线，过了本机技术验证的门才显示（showProjects）。
enum Tab: String, CaseIterable, Identifiable {
    case home, todo, projects, my

    var id: String { rawValue }

    var label: String {
        switch self {
        case .home: return "首页"
        case .todo: return "待办"
        case .projects: return "项目"
        case .my: return "我的"
        }
    }

    var icon: String {
        switch self {
        case .home: return "house.fill"
        case .todo: return "tray.fill"
        case .projects: return "folder.fill"
        case .my: return "person.fill"
        }
    }
}

private let showProjects = false

/// 标签页上面的二级页。
enum Detail: Equatable {
    case task
    case receiptDetail(Receipt)
    case pair
    case keepAlive
}

/// 第一次打开：欢迎 → 扫码配对 → 保活引导 → 首页。走完一次记下来，之后直接进首页。
private enum Onboarding {
    case welcome, pair, keepAlive
}

/// 整个 App 的壳：引导流程、二级页、底部标签、临时提示。界面都从这里进出。
struct AppRoot<Link: LinkClient>: View {
    @ObservedObject var link: Link
    @AppStorage("onboarded") private var onboarded = false

    @State private var onboarding: Onboarding?
    @State private var tab: Tab = .home
    @State private var detail: Detail?

    private var state: LinkState { link.state }

    var body: some View {
        ZStack {
            if let step = onboarding {
                onboardingView(step)
            } else if let d = detail {
                detailView(d)
            } else {
                mainView
            }
        }
        .background(Sk.bg.ignoresSafeArea())
        .overlay(alignment: .top) { noticeOverlay }
        .onAppear {
            if !onboarded && onboarding == nil {
                onboarding = .welcome
            }
        }
    }

    // MARK: - 引导流程

    @ViewBuilder
    private func onboardingView(_ step: Onboarding) -> some View {
        ZStack {
            (step == .pair ? Sk.dark : Sk.bg).ignoresSafeArea()
            switch step {
            case .welcome:
                WelcomeScreen(onPair: { onboarding = .pair })
            case .pair:
                PairScreen(
                    onBack: { onboarding = .welcome },
                    onPaired: { code in
                        if code.hasPrefix("debug://") {
                            onboarding = .keepAlive
                        } else {
                            link.pair(code: code)
                        }
                    },
                    phase: state.pairing,
                    error: state.pairingError,
                )
                .onChange(of: state.pairing) { _, phase in
                    // 电脑上点了「允许」才进下一步。
                    if phase == .approved {
                        onboarding = .keepAlive
                    }
                }
            case .keepAlive:
                KeepAliveScreen(
                    computerName: state.computerName,
                    onBack: finishOnboarding,
                    onDone: finishOnboarding,
                )
            }
        }
    }

    private func finishOnboarding() {
        onboarded = true
        onboarding = nil
    }

    // MARK: - 二级页

    @ViewBuilder
    private func detailView(_ d: Detail) -> some View {
        ZStack {
            (d == .pair ? Sk.dark : Sk.bg).ignoresSafeArea()
            switch d {
            case .task:
                TaskDetailScreen(state: state, onBack: { detail = nil }, onStop: link.cancel)
            case .receiptDetail(let receipt):
                ReceiptScreen(
                    receipt: receipt,
                    onBack: { detail = nil },
                    onUndo: {
                        link.undoTurn(receiptId: receipt.id)
                        detail = nil
                    },
                )
            case .pair:
                PairDetail(link: link, onBack: { detail = nil })
            case .keepAlive:
                KeepAliveScreen(
                    computerName: state.computerName,
                    onBack: { detail = nil },
                    onDone: { detail = nil },
                )
            }
        }
    }

    // MARK: - 标签页

    private var mainView: some View {
        VStack(spacing: 0) {
            Group {
                switch tab {
                case .home:
                    HomeScreen(
                        state: state,
                        onSend: link.send,
                        onStop: link.cancel,
                        onReconnect: link.reconnect,
                        onOpenTask: { detail = .task },
                        onOpenReceipt: { detail = .receiptDetail($0) },
                        onRespond: link.respondApproval,
                    )
                case .todo:
                    TodoScreen(
                        state: state,
                        onRespond: link.respondApproval,
                        onOpenReceipt: { detail = .receiptDetail($0) },
                    )
                case .projects:
                    Color.clear // B 线，内测通过前不显示
                case .my:
                    MyScreen(
                        state: state,
                        onPair: { detail = .pair },
                        onKeepAlive: { detail = .keepAlive },
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            BottomNav(
                current: tab,
                todoBadge: state.approvals.filter { $0.handledReason == nil }.count,
                onSelect: { tab = $0 },
            )
        }
    }

    // MARK: - 临时提示

    @ViewBuilder
    private var noticeOverlay: some View {
        if let notice = state.notice {
            Text(notice)
                .font(.system(size: 14))
                .foregroundColor(Sk.ring)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Sk.ink, in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .task(id: notice) {
                    // 连接层的临时提示（忙、离线、已撤销……），三秒后自己消失。
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    link.clearNotice()
                }
        }
    }
}

/// 配对二级页：扫到之后自己管「开始/完成」时序，批准了就关掉。
private struct PairDetail<Link: LinkClient>: View {
    @ObservedObject var link: Link
    var onBack: () -> Void = {}

    @State private var started = false

    var body: some View {
        PairScreen(
            onBack: onBack,
            onPaired: { code in
                started = true
                if code.hasPrefix("debug://") {
                    onBack()
                } else {
                    link.pair(code: code)
                }
            },
            phase: started ? link.state.pairing : .none,
            error: link.state.pairingError,
        )
        .onChange(of: link.state.pairing) { _, phase in
            if started && phase == .approved {
                onBack()
            }
        }
    }
}

/// 设计稿的底栏：白底、上边一条细线，选中的标签红字加粗；待办上挂未处理的数量。
private struct BottomNav: View {
    let current: Tab
    let todoBadge: Int
    let onSelect: (Tab) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Sk.cardLine).frame(height: 1)
            HStack(spacing: 0) {
                ForEach(Tab.allCases.filter { $0 != .projects || showProjects }) { t in
                    let on = t == current
                    Button {
                        onSelect(t)
                    } label: {
                        ZStack(alignment: .top) {
                            VStack(spacing: 2) {
                                Image(systemName: t.icon)
                                    .font(.system(size: 20))
                                Text(t.label)
                                    .font(.system(size: 12, weight: on ? .bold : .regular))
                            }
                            .foregroundColor(on ? Sk.primary : Sk.muted)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 52)

                            if t == .todo && todoBadge > 0 {
                                Text(todoBadge > 99 ? "99+" : "\(todoBadge)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 5)
                                    .frame(minWidth: 18)
                                    .background(Sk.primary, in: Capsule())
                                    .offset(x: 14, y: 2)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 6)
            .padding(.bottom, 14)
        }
        .background(Sk.card)
    }
}
