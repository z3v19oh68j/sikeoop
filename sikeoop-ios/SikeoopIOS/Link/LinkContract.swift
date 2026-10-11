import Combine
import Foundation

/// 界面层（UI/）和连接层（Link/）之间的接口。
/// 界面只认这个接口：走中继遥控电脑、局域网直连、还是手机本机的内核，
/// 只是它的不同实现，界面一行都不用改。
protocol LinkClient: ObservableObject {
    /// 界面照着它画。
    var state: LinkState { get }

    /// 派活。
    func send(_ text: String)

    /// 停下。
    func cancel()

    /// 审批 / 确认撤不回的操作。
    func respondApproval(id: String, allow: Bool)

    /// 撤销这一轮。
    func undoTurn(receiptId: String)

    /// 电脑不在线时重新连接。
    func reconnect()

    /// 扫到的二维码内容（sikeoop://pair/…）：连上电脑，等电脑上点「允许」。
    func pair(code: String)

    /// 忘掉这台电脑（要重新扫码才能再连）。
    func unpair()

    /// 看过 notice 之后清掉。
    func clearNotice()
}

extension LinkClient {
    func clearNotice() {}
}
