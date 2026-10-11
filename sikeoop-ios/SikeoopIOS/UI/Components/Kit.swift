import SwiftUI

/// 白底、细描边、20 圆角的卡片。
struct SkCard<Content: View>: View {
    var border: Color = Sk.cardLine
    var borderWidth: CGFloat = 1
    var bg: Color = Sk.card
    var radius: CGFloat = 20
    var padding: CGFloat = 16
    var gap: CGFloat = 10
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: gap) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padding)
        .background(bg, in: RoundedRectangle(cornerRadius: radius))
        .overlay(
            RoundedRectangle(cornerRadius: radius)
                .strokeBorder(border, lineWidth: borderWidth)
        )
    }
}

/// 白字主按钮，胶囊形。
struct PrimaryPill: View {
    let text: String
    var action: () -> Void = {}
    var minHeight: CGFloat = 44
    var fontSize: CGFloat = 15
    var enabled: Bool = true

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: fontSize, weight: .medium))
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .frame(minHeight: minHeight)
                .padding(.horizontal, 22)
        }
        .background(Sk.primary, in: Capsule())
        .opacity(enabled ? 1 : 0.45)
        .disabled(!enabled)
    }
}

/// 白底描边次按钮，胶囊形。
struct SecondaryPill: View {
    let text: String
    var action: () -> Void = {}
    var minHeight: CGFloat = 44
    var border: Color = Sk.btnLine
    var color: Color = Sk.ink
    var fontSize: CGFloat = 15
    var enabled: Bool = true
    var weight: Font.Weight = .regular

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: fontSize, weight: weight))
                .foregroundColor(color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: minHeight)
                .padding(.horizontal, 18)
        }
        .background(Sk.card, in: Capsule())
        .overlay(Capsule().strokeBorder(border, lineWidth: 1))
        .opacity(enabled ? 1 : 0.45)
        .disabled(!enabled)
    }
}

/// 小胶囊标签。
struct Tag: View {
    let text: String
    let bg: Color
    let fg: Color
    var mono: Bool = false
    var fontSize: CGFloat = 13

    var body: some View {
        Text(text)
            .font(mono ? .system(size: fontSize, weight: .medium, design: .monospaced)
                       : .system(size: fontSize, weight: .medium))
            .foregroundColor(fg)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(bg, in: Capsule())
    }
}

struct Dot: View {
    let color: Color
    var size: CGFloat = 8

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
    }
}

/// 小节标题（灰字）。
struct SectionLabel: View {
    let text: String
    var size: CGFloat = 13

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .foregroundColor(Sk.muted)
    }
}

/// 二级页顶栏：返回 + 标题 + 右侧。
struct BackHeader<Trailing: View>: View {
    let title: String
    let tint: Color
    let centerTitle: Bool
    let onBack: () -> Void
    let trailing: Trailing

    init(
        title: String,
        tint: Color = Sk.ink,
        centerTitle: Bool = true,
        onBack: @escaping () -> Void = {},
        @ViewBuilder trailing: () -> Trailing,
    ) {
        self.title = title
        self.tint = tint
        self.centerTitle = centerTitle
        self.onBack = onBack
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onBack) {
                Image(systemName: "arrow.left")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundColor(tint)
                    .frame(width: 44, height: 44)
            }
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(tint)
                .frame(maxWidth: centerTitle ? .infinity : nil, alignment: centerTitle ? .center : .leading)
                .padding(.leading, 4)
            Spacer(minLength: 0)
            trailing
                .frame(minWidth: 44, alignment: .trailing)
        }
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .padding(.top, 12)
    }
}

/// 右边没东西的顶栏。
extension BackHeader where Trailing == EmptyView {
    init(
        title: String,
        tint: Color = Sk.ink,
        centerTitle: Bool = true,
        onBack: @escaping () -> Void = {},
    ) {
        self.init(title: title, tint: tint, centerTitle: centerTitle, onBack: onBack, trailing: { EmptyView() })
    }
}

/// 列表里一行：标题、右侧说明、箭头。
struct ListRow<Content: View>: View {
    var onClick: (() -> Void)? = nil
    var divider: Bool = true
    var minHeight: CGFloat = 56
    var showChevron: Bool? = nil
    @ViewBuilder var content: Content

    private var chevronVisible: Bool { showChevron ?? (onClick != nil) }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                onClick?()
            } label: {
                HStack(spacing: 8) {
                    content
                    if chevronVisible {
                        Chevron()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: minHeight)
                .padding(.horizontal, 16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onClick == nil)
            if divider {
                Rectangle().fill(Sk.divider).frame(height: 1)
            }
        }
    }
}

struct Chevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 14, weight: .semibold))
            .foregroundColor(Sk.faint)
            .frame(width: 20, height: 20)
    }
}

func fmtSeconds(_ sec: Int) -> String {
    String(format: "%d:%02d", sec / 60, sec % 60)
}
