import SwiftUI

/// 设计令牌，和高保真设计稿一致。改这里，整个 App 一起变。
enum Sk {
    static let bg = Color(hex: 0xFBF7F2)
    static let ink = Color(hex: 0x2A2420)
    static let ink2 = Color(hex: 0x4A413B)
    static let muted = Color(hex: 0x6E635A)
    static let faint = Color(hex: 0xA39A92)
    static let card = Color.white
    static let cardLine = Color(hex: 0xECE3D9)
    static let fieldLine = Color(hex: 0xE6DCD1)
    static let btnLine = Color(hex: 0xD9CEC2)
    static let divider = Color(hex: 0xF1E9E0)
    static let ring = Color(hex: 0xF3ECE4)
    static let codeBg = Color(hex: 0xF6F1EB)
    static let grayCard = Color(hex: 0xF3EEE8)
    static let pending = Color(hex: 0xCFC4B8)

    static let accent = Color(hex: 0xE8553F)      // 只做描边、进度条、点缀
    static let accentSoft = Color(hex: 0xFDF0EC)
    static let primary = Color(hex: 0xC4402C)     // 白字按钮底色
    static let warn = Color(hex: 0xA8361F)
    static let warnSoft = Color(hex: 0xFCE9E4)

    static let blue = Color(hex: 0x2A6F8E)
    static let blueSoft = Color(hex: 0xE3EEF3)
    static let blueInk = Color(hex: 0x1F5A74)
    static let online = Color(hex: 0x2E9B5F)
    static let ok = Color(hex: 0x24653F)
    static let ok2 = Color(hex: 0x2E7D4F)
    static let okSoft = Color(hex: 0xE5F2EA)

    static let dark = Color(hex: 0x1E1A17)
    static let dark2 = Color(hex: 0x2E2824)
    static let dark3 = Color(hex: 0x3A332E)
    static let darkMuted = Color(hex: 0xB8ADA2)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1,
        )
    }
}
