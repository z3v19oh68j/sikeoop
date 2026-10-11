package com.sikeoop.mobile.link

import com.sikeoop.mobile.core.model.LinkState
import kotlinx.coroutines.flow.StateFlow

/**
 * 界面层（ui/）和连接层（core/）之间的接口。
 * 界面只认这个接口：走中继遥控电脑、局域网直连、还是手机本机的内核，
 * 只是它的不同实现，界面一行都不用改。
 */
interface LinkClient {
    /** 界面照着它画。 */
    val state: StateFlow<LinkState>

    /** 派活。 */
    fun send(text: String)

    /** 停下。 */
    fun cancel()

    /** 审批 / 确认撤不回的操作。 */
    fun respondApproval(id: String, allow: Boolean)

    /** 撤销这一轮。 */
    fun undoTurn(receiptId: String)

    /** 电脑不在线时重新连接。 */
    fun reconnect()

    /** 扫到的二维码内容（sikeoop://pair/…）：连上电脑，等电脑上点「允许」。 */
    fun pair(code: String)

    /** 忘掉这台电脑（要重新扫码才能再连）。 */
    fun unpair()

    /** 看过 notice 之后清掉。 */
    fun clearNotice() {}
}
