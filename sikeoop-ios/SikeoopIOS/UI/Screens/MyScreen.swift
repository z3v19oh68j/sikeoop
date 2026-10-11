import SwiftUI

/// 我的：电脑卡片、设置列表、懒人模式说明。对应设计稿 My。
/// keepAliveMissing：保活检查里还没开的项数，0 时不显示红字。
struct MyScreen: View {
    let state: LinkState
    var onPair: () -> Void = {}
    var onKeepAlive: () -> Void = {}
    var keepAliveMissing: Int = 0
    var onShortcuts: () -> Void = {}
    var onModels: () -> Void = {}
    var onAbout: () -> Void = {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("我的")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(Sk.ink)

                Button(action: onPair) {
                    HStack(spacing: 14) {
                        Image(systemName: "laptopcomputer")
                            .font(.system(size: 22))
                            .foregroundColor(Sk.blueInk)
                            .frame(width: 48, height: 48)
                            .background(Sk.blueSoft, in: RoundedRectangle(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 0) {
                            Text(state.computerName)
                                .font(.system(size: 17, weight: .bold))
                                .foregroundColor(Sk.ink)
                            HStack(spacing: 6) {
                                Dot(color: state.online ? Sk.online : Sk.faint, size: 7)
                                let where_ = state.project.isEmpty ? "" : " · 项目 \(state.project)"
                                Text((state.online ? "在线" : "离线") + where_)
                                    .font(.system(size: 13))
                                    .foregroundColor(Sk.muted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(Sk.faint)
                    }
                    .padding(16)
                    .background(Sk.card, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Sk.cardLine, lineWidth: 1))
                }
                .buttonStyle(.plain)

                VStack(spacing: 0) {
                    SettingRow(title: "通知与保活检查", onClick: onKeepAlive,
                               note: keepAliveMissing > 0 ? "\(keepAliveMissing) 项没开" : nil, warn: true)
                    SettingRow(title: "快捷指令", onClick: onShortcuts)
                    SettingRow(title: "模型与 Key", onClick: onModels, sub: "本地编程用")
                    SettingRow(title: "微信兜底", onClick: nil, note: "电脑端已开启")
                    SettingRow(title: "关于 / 反馈", onClick: onAbout, last: true)
                }
                .background(Sk.card, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Sk.cardLine, lineWidth: 1))

                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "shield.fill")
                        .font(.system(size: 18))
                        .foregroundColor(Sk.blueInk)
                        .padding(.top, 2)
                    Text("远程任务默认用\(state.mode)模式：危险操作照旧拦下，推送和发布会在手机上问你。")
                        .font(.system(size: 13))
                        .foregroundColor(Sk.blueInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Sk.blueSoft, in: RoundedRectangle(cornerRadius: 16))
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }
}

private struct SettingRow: View {
    let title: String
    let onClick: (() -> Void)?
    var sub: String? = nil
    var note: String? = nil
    var warn: Bool = false
    var last: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Button {
                onClick?()
            } label: {
                HStack(spacing: 6) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 15))
                            .foregroundColor(Sk.ink)
                        if let sub {
                            Text(sub)
                                .font(.system(size: 12))
                                .foregroundColor(Sk.muted)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let note {
                        Text(note)
                            .font(.system(size: 13))
                            .foregroundColor(warn ? Sk.warn : Sk.muted)
                    }
                    if onClick != nil {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(Sk.faint)
                    }
                }
                .frame(minHeight: 56)
                .padding(.horizontal, 16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onClick == nil)
            if !last {
                Rectangle().fill(Sk.divider).frame(height: 1)
            }
        }
    }
}

#Preview {
    MyScreen(state: FakeLink().state, keepAliveMissing: 2)
}
