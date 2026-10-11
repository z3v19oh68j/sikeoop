import SwiftUI

/// 扫码配对（深色取景页）。P1 在取景框里接真扫码；二维码只能用一次、5 分钟过期。
/// 相机没接之前，用「手动输入配对码」走完整配对流程，另有「模拟扫到」调试按钮。对应设计稿 Pair。
struct PairScreen: View {
    var onBack: () -> Void = {}
    /// 扫到的二维码内容（sikeoop://pair/…）。
    var onPaired: (String) -> Void = { _ in }
    var phase: PairingPhase = .none
    var error: String? = nil

    @State private var showInput = false
    @State private var codeInput = ""

    private var trimmedCode: String {
        codeInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitCode() {
        let code = trimmedCode
        guard !code.isEmpty else { return }
        onPaired(code)
    }

    private var busy: Bool {
        phase == .connecting || phase == .waitingApproval
    }

    var body: some View {
        VStack(spacing: 0) {
            BackHeader(title: "添加电脑", tint: Sk.ring, centerTitle: false, onBack: onBack)
            Spacer().frame(height: 48)
            ZStack {
                ViewfinderOverlay()
                if busy {
                    VStack(spacing: 14) {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .tint(Sk.accent)
                            .scaleEffect(1.1)
                        Text(phase == .connecting ? "正在连接电脑…" : "在电脑上点「允许」")
                            .font(.system(size: 15))
                            .foregroundColor(Sk.ring)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Sk.dark.opacity(0.78))
                }
            }
            .frame(width: 270, height: 270)
            .clipped()

            if phase == .failed, let error {
                Text(error)
                    .font(.system(size: 14))
                    .foregroundColor(Sk.ring)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Sk.warn.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 28)
                    .padding(.top, 20)
            }

            VStack(alignment: .leading, spacing: 14) {
                Text("在电脑上的 sikeoop 里：")
                    .font(.system(size: 15))
                    .foregroundColor(Sk.darkMuted)
                ForEach(["打开「手机」页", "点「添加手机」", "扫屏幕上的二维码"], id: \.self) { step in
                    HStack(spacing: 12) {
                        Text("\(["打开「手机」页", "点「添加手机」", "扫屏幕上的二维码"].firstIndex(of: step)! + 1)")
                            .font(.system(size: 13))
                            .foregroundColor(Sk.ring)
                            .frame(width: 26, height: 26)
                            .background(Sk.dark3, in: Circle())
                        Text(step)
                            .font(.system(size: 16))
                            .foregroundColor(Sk.ring)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28)
            .padding(.top, phase == .failed ? 20 : 40)

            // 真扫码要接相机（放 P1），先把手动输入配对码补上：一样能走完整个配对流程。
            VStack(spacing: 12) {
                if showInput {
                    TextField(
                        "",
                        text: $codeInput,
                        prompt: Text("输入电脑上的配对码").foregroundColor(Sk.darkMuted)
                    )
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .foregroundColor(Sk.ring)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 48)
                    .background(Sk.dark2, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Sk.dark3, lineWidth: 1))
                    .submitLabel(.done)
                    .onSubmit(submitCode)

                    Button(action: submitCode) {
                        Text("配对")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Sk.dark)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 48)
                            .background(Sk.accent, in: Capsule())
                    }
                    .opacity(trimmedCode.isEmpty ? 0.45 : 1)
                    .disabled(trimmedCode.isEmpty)
                } else {
                    Button {
                        showInput = true
                    } label: {
                        Text("手动输入配对码")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Sk.dark)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 48)
                            .background(Sk.accent, in: Capsule())
                    }
                }

                // 调试用：不走配对，直接进下一步。
                Button {
                    onPaired("debug://placeholder")
                } label: {
                    Text("模拟扫到二维码（调试）")
                        .font(.system(size: 13))
                        .foregroundColor(Sk.darkMuted)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 40)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)

            Spacer()

            HStack(spacing: 8) {
                Image(systemName: "clock")
                    .font(.system(size: 16))
                    .foregroundColor(Sk.darkMuted)
                Text("二维码 5 分钟内有效，只能扫一次")
                    .font(.system(size: 13))
                    .foregroundColor(Sk.darkMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Sk.dark2, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 28)
            .padding(.bottom, 36)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.dark)
    }
}

/// 画在相机画面上的取景框：四个圆角描边角、上下扫的光线、提示文字。
private struct ViewfinderOverlay: View {
    @State private var scan: CGFloat = 0.2

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack {
                Path { p in
                    let k = w / 270
                    p.move(to: CGPoint(x: 14 * k, y: 60 * k))
                    p.addLine(to: CGPoint(x: 14 * k, y: 36 * k))
                    p.addQuadCurve(to: CGPoint(x: 36 * k, y: 14 * k), control: CGPoint(x: 14 * k, y: 14 * k))
                    p.addLine(to: CGPoint(x: 60 * k, y: 14 * k))
                    p.move(to: CGPoint(x: 210 * k, y: 14 * k))
                    p.addLine(to: CGPoint(x: 234 * k, y: 14 * k))
                    p.addQuadCurve(to: CGPoint(x: 256 * k, y: 36 * k), control: CGPoint(x: 256 * k, y: 14 * k))
                    p.addLine(to: CGPoint(x: 256 * k, y: 60 * k))
                    p.move(to: CGPoint(x: 256 * k, y: 210 * k))
                    p.addLine(to: CGPoint(x: 256 * k, y: 234 * k))
                    p.addQuadCurve(to: CGPoint(x: 234 * k, y: 256 * k), control: CGPoint(x: 256 * k, y: 256 * k))
                    p.addLine(to: CGPoint(x: 210 * k, y: 256 * k))
                    p.move(to: CGPoint(x: 60 * k, y: 256 * k))
                    p.addLine(to: CGPoint(x: 36 * k, y: 256 * k))
                    p.addQuadCurve(to: CGPoint(x: 14 * k, y: 234 * k), control: CGPoint(x: 14 * k, y: 256 * k))
                    p.addLine(to: CGPoint(x: 14 * k, y: 210 * k))
                }
                .stroke(Sk.accent, style: StrokeStyle(lineWidth: 5 * w / 270, lineCap: .round))

                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(Sk.accent.opacity(0.35))
                        .frame(height: 8 * w / 270)
                    Rectangle()
                        .fill(Sk.accent)
                        .frame(height: 2 * w / 270)
                }
                .offset(y: (geo.size.height * scan) - geo.size.height / 2)

                VStack {
                    Spacer()
                    Text("把二维码放进框里")
                        .font(.system(size: 12))
                        .foregroundColor(Sk.ring)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Sk.dark.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                        .padding(.bottom, 22)
                }
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                scan = 0.8
            }
        }
    }
}

#Preview {
    PairScreen()
}
