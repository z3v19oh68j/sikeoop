import SwiftUI

/// 第一次打开：连接电脑。「在手机上写代码」是 B 线（内测），
/// onLocal 为 nil 时不显示这个入口。对应设计稿 Welcome。
struct WelcomeScreen: View {
    var onPair: () -> Void = {}
    var onLocal: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            WhaleImage(pose: .lazy, size: 240, ring: 10)
                .padding(.top, 120)
            Spacer().frame(height: 40)
            Text("本鲸来了，别怕~")
                .font(.system(size: 30, weight: .bold))
                .foregroundColor(Sk.ink)
            Spacer().frame(height: 12)
            Text("把电脑上的我装进口袋")
                .font(.system(size: 16))
                .foregroundColor(Sk.muted)
            Spacer()
            PrimaryPill("连接我的电脑", action: onPair, minHeight: 54, fontSize: 17)
            if let onLocal {
                Spacer().frame(height: 12)
                Button(action: onLocal) {
                    HStack(spacing: 8) {
                        Text("在手机上写代码")
                            .font(.system(size: 15))
                            .foregroundColor(Sk.ink)
                        Tag("内测", bg: Sk.blueSoft, fg: Sk.blueInk, fontSize: 12)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 50)
                }
                .background(Sk.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Sk.btnLine, lineWidth: 1))
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
    }
}

#Preview {
    WelcomeScreen()
}
