import SwiftUI
#if os(iOS)
import UIKit
#endif

private struct KeepAliveItem {
    let title: String
    let hint: String
}

private let items = [
    KeepAliveItem(title: "允许通知", hint: "有事要你拍板时才会响"),
    KeepAliveItem(title: "电池不限制", hint: "不然锁屏几分钟就被系统杀掉"),
    KeepAliveItem(title: "后台自启动", hint: "手机重启后自动连回电脑"),
]

/// 打开本 App 的系统设置页。iOS 不让直接跳到某个系统开关，只能到 App 自己那一页。
func openAppSettings() {
    #if os(iOS)
    if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
    }
    #endif
}

/// 保活引导：配对成功后的三项检查。「去设置」跳到系统设置页，回来把这一项标成已开启。
/// 对应设计稿 KeepAlive。
struct KeepAliveScreen: View {
    var computerName: String = "我的 MacBook"
    var onBack: () -> Void = {}
    var onDone: () -> Void = {}
    var onOpenSetting: (Int) -> Void = { _ in }

    @State private var done: Set<Int> = [0]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(Sk.ok)
                    Text("已连上：\(computerName)")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Sk.ok)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Sk.okSoft, in: RoundedRectangle(cornerRadius: 14))

                HStack(spacing: 14) {
                    WhaleImage(pose: .waiting, size: 76, ring: 5)
                    Text("再做 3 步，\n本鲸才不会掉线")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundColor(Sk.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                        HStack(spacing: 12) {
                            if done.contains(i) {
                                ZStack {
                                    Circle().fill(Sk.blue).frame(width: 26, height: 26)
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 14, weight: .bold))
                                        .foregroundColor(.white)
                                }
                            } else {
                                Circle().strokeBorder(Sk.pending, lineWidth: 2).frame(width: 26, height: 26)
                            }
                            VStack(alignment: .leading, spacing: 0) {
                                Text(item.title)
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundColor(Sk.ink)
                                Text(item.hint)
                                    .font(.system(size: 13))
                                    .foregroundColor(Sk.muted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            if done.contains(i) {
                                Text("已开启")
                                    .font(.system(size: 13))
                                    .foregroundColor(Sk.ok)
                            } else {
                                Button {
                                    onOpenSetting(i)
                                    openAppSettings()
                                    done.insert(i)
                                } label: {
                                    Text("去设置")
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundColor(Sk.warn)
                                        .padding(.horizontal, 14)
                                        .frame(minHeight: 40)
                                }
                                .background(Sk.warnSoft, in: Capsule())
                            }
                        }
                        .frame(minHeight: 72)
                        .padding(.horizontal, 16)
                        if i < items.count - 1 {
                            Rectangle().fill(Sk.divider).frame(height: 1)
                        }
                    }
                }
                .background(Sk.card, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Sk.cardLine, lineWidth: 1))

                Text("小米、华为、OPPO、vivo 等国产手机，后两项一定要打开。")
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 8) {
                    PrimaryPill("全部好了，进入", action: onDone, minHeight: 54, fontSize: 17)
                    Button(action: onDone) {
                        Text("先跳过")
                            .font(.system(size: 14))
                            .foregroundColor(Sk.muted)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 48)
            .padding(.bottom, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }
}

#Preview {
    KeepAliveScreen()
}
