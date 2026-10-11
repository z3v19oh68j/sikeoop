import SwiftUI

@main
struct SikeoopIOSApp: App {
    // 走中继的真连接（P1）；预览和界面调试可换回 FakeLink。
    @StateObject private var link = RelayLink()

    var body: some Scene {
        WindowGroup {
            AppRoot(link: link)
        }
    }
}
