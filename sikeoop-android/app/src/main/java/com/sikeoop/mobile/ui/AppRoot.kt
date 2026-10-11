package com.sikeoop.mobile.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.PairingPhase
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.link.LinkClient
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.screens.HomeScreen
import com.sikeoop.mobile.ui.screens.KeepAliveScreen
import com.sikeoop.mobile.ui.screens.MyScreen
import com.sikeoop.mobile.ui.screens.PairScreen
import com.sikeoop.mobile.ui.screens.ReceiptScreen
import com.sikeoop.mobile.ui.screens.TaskDetailScreen
import com.sikeoop.mobile.ui.screens.TodoScreen
import com.sikeoop.mobile.ui.screens.WelcomeScreen
import com.sikeoop.mobile.ui.theme.Sk

/** 底部标签。「项目」是 B 线，过了本机技术验证的门才显示（SHOW_PROJECTS）。 */
enum class Tab(val label: String, val icon: ImageVector) {
    HOME("首页", SkIcons.Home),
    TODO("待办", SkIcons.Todo),
    PROJECTS("项目", SkIcons.Folder),
    MY("我的", SkIcons.Person),
}

private const val SHOW_PROJECTS = false

/** 标签页上面的二级页。 */
sealed interface Detail {
    data object Task : Detail
    data class ReceiptDetail(val receipt: Receipt) : Detail
    data object Pair : Detail
    data object KeepAlive : Detail
}

/** 第一次打开：欢迎 → 扫码配对 → 保活引导 → 首页。走完一次记下来，之后直接进首页。 */
private enum class Onboarding { WELCOME, PAIR, KEEP_ALIVE }

private const val PREFS = "sikeoop"
private const val KEY_ONBOARDED = "onboarded"

@Composable
fun AppRoot(link: LinkClient) {
    val state by link.state.collectAsState()
    val prefs = LocalContext.current.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    var onboarding by remember { mutableStateOf(if (prefs.getBoolean(KEY_ONBOARDED, false)) null else Onboarding.WELCOME) }
    var tab by remember { mutableStateOf(Tab.HOME) }
    var detail by remember { mutableStateOf<Detail?>(null) }

    val step = onboarding
    if (step != null) {
        val finish = {
            prefs.edit().putBoolean(KEY_ONBOARDED, true).apply()
            onboarding = null
        }
        Box(Modifier.fillMaxSize().background(if (step == Onboarding.PAIR) Sk.Dark else Sk.Bg).safeDrawingPadding()) {
            when (step) {
                Onboarding.WELCOME -> WelcomeScreen(onPair = { onboarding = Onboarding.PAIR })
                Onboarding.PAIR -> {
                    BackHandler { onboarding = Onboarding.WELCOME }
                    // 电脑上点了「允许」才进下一步。
                    LaunchedEffect(state.pairing) { if (state.pairing == PairingPhase.APPROVED) onboarding = Onboarding.KEEP_ALIVE }
                    PairScreen(
                        onBack = { onboarding = Onboarding.WELCOME },
                        onPaired = { code -> if (code.startsWith("debug://")) onboarding = Onboarding.KEEP_ALIVE else link.pair(code) },
                        phase = state.pairing,
                        error = state.pairingError,
                    )
                }
                Onboarding.KEEP_ALIVE -> KeepAliveScreen(computerName = state.computerName, onBack = finish, onDone = finish)
            }
        }
        return
    }

    val d = detail
    if (d != null) {
        BackHandler { detail = null }
        Box(Modifier.fillMaxSize().background(if (d == Detail.Pair) Sk.Dark else Sk.Bg).safeDrawingPadding()) {
            when (d) {
                Detail.Task -> TaskDetailScreen(state = state, onBack = { detail = null }, onStop = link::cancel)
                is Detail.ReceiptDetail -> ReceiptScreen(
                    receipt = d.receipt,
                    onBack = { detail = null },
                    onUndo = {
                        link.undoTurn(d.receipt.id)
                        detail = null
                    },
                )
                Detail.Pair -> {
                    var started by remember { mutableStateOf(false) }
                    LaunchedEffect(state.pairing) { if (started && state.pairing == PairingPhase.APPROVED) detail = null }
                    PairScreen(
                        onBack = { detail = null },
                        onPaired = { code ->
                            started = true
                            if (code.startsWith("debug://")) detail = null else link.pair(code)
                        },
                        phase = if (started) state.pairing else PairingPhase.NONE,
                        error = state.pairingError,
                    )
                }
                Detail.KeepAlive -> KeepAliveScreen(computerName = state.computerName, onBack = { detail = null }, onDone = { detail = null })
            }
        }
        return
    }

    val badge = state.approvals.count { it.handledReason == null }
    Column(Modifier.fillMaxSize().background(Sk.Bg)) {
        Box(Modifier.weight(1f).fillMaxWidth().statusBarsPadding()) {
            when (tab) {
                Tab.HOME -> HomeScreen(
                    state = state,
                    onSend = link::send,
                    onStop = link::cancel,
                    onReconnect = link::reconnect,
                    onOpenTask = { detail = Detail.Task },
                    onOpenReceipt = { detail = Detail.ReceiptDetail(it) },
                    onRespond = link::respondApproval,
                )
                Tab.TODO -> TodoScreen(
                    state = state,
                    onRespond = link::respondApproval,
                    onOpenReceipt = { detail = Detail.ReceiptDetail(it) },
                )
                Tab.PROJECTS -> Unit
                Tab.MY -> MyScreen(
                    state = state,
                    onPair = { detail = Detail.Pair },
                    onKeepAlive = { detail = Detail.KeepAlive },
                )
            }
        }
        BottomNav(tab, badge) { tab = it }
    }
    // 连接层的临时提示（忙、离线、已撤销……），三秒后自己消失。
    val notice = state.notice
    if (notice != null) {
        LaunchedEffect(notice) {
            kotlinx.coroutines.delay(3000)
            link.clearNotice()
        }
        Box(Modifier.fillMaxSize().statusBarsPadding().padding(top = 12.dp), contentAlignment = Alignment.TopCenter) {
            Text(
                notice,
                Modifier.padding(horizontal = 20.dp).background(Sk.Ink, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 10.dp),
                fontSize = 14.sp,
                color = Sk.Ring,
            )
        }
    }
}

/** 设计稿的底栏：白底、上边一条细线，选中的标签红字加粗；待办上挂未处理的数量。 */
@Composable
private fun BottomNav(current: Tab, todoBadge: Int, onSelect: (Tab) -> Unit) {
    Column(Modifier.fillMaxWidth().background(Sk.Card)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Sk.CardLine))
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(top = 6.dp, bottom = 14.dp)) {
            Tab.entries.filter { it != Tab.PROJECTS || SHOW_PROJECTS }.forEach { t ->
                val on = t == current
                val color = if (on) Sk.Primary else Sk.Muted
                Box(
                    Modifier.weight(1f).heightIn(min = 52.dp).clickable(role = Role.Tab, onClickLabel = t.label) { onSelect(t) },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        SkIcon(t.icon, color)
                        Text(t.label, fontSize = 12.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, color = color)
                    }
                    if (t == Tab.TODO && todoBadge > 0) {
                        Text(
                            if (todoBadge > 99) "99+" else "$todoBadge",
                            Modifier.align(Alignment.TopCenter).offset(x = 14.dp, y = 2.dp)
                                .widthIn(min = 18.dp).background(Sk.Primary, RoundedCornerShape(9.dp)).padding(horizontal = 5.dp),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}
