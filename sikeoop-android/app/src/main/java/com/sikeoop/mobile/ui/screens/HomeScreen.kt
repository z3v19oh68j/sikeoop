package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.core.model.StepState
import com.sikeoop.mobile.core.model.WhaleStatus
import com.sikeoop.mobile.core.model.speech
import com.sikeoop.mobile.link.FakeLink
import com.sikeoop.mobile.ui.components.Dot
import com.sikeoop.mobile.ui.components.PrimaryPill
import com.sikeoop.mobile.ui.components.SecondaryPill
import com.sikeoop.mobile.ui.components.SkCard
import com.sikeoop.mobile.ui.components.Tag
import com.sikeoop.mobile.ui.components.WhaleAvatar
import com.sikeoop.mobile.ui.components.fmtSeconds
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/** 首页卡片的一种样子，对应设计稿 Main 的 S 表。 */
private data class HomeCard(
    val kicker: String,
    val meta: String,
    val title: String,
    val body: String,
    val mono: Boolean = false,
    val progress: Float? = null,
    val secondary: String? = null,
    val primary: String,
    val onSecondary: () -> Unit = {},
    val onPrimary: () -> Unit,
)

private val WhaleStatus.homeLabel: String
    get() = when (this) {
        WhaleStatus.IDLE -> "空闲"
        WhaleStatus.WORKING -> "干活中"
        WhaleStatus.WAITING -> "等你拍板"
        WhaleStatus.DONE -> "做完了"
        WhaleStatus.ERROR -> "出错"
        WhaleStatus.HALTED -> "没做完"
        WhaleStatus.OFFLINE -> "电脑不在线"
    }

/** 首页「本鲸」：状态头像、一张状态卡、快捷指令、输入框。 */
@Composable
fun HomeScreen(
    state: LinkState,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onOpenTask: () -> Unit,
    onOpenReceipt: (Receipt) -> Unit = {},
    onRespond: (id: String, allow: Boolean) -> Unit = { _, _ -> },
) {
    var text by remember { mutableStateOf("") }
    val offline = !state.online || state.status == WhaleStatus.OFFLINE
    val status = if (offline) WhaleStatus.OFFLINE else state.status
    val card = homeCard(state, status, onSend, onStop, onReconnect, onOpenTask, onOpenReceipt, onRespond)

    Column(Modifier.fillMaxSize().background(Sk.Bg)) {
        // 顶部：电脑胶囊 + 懒人模式
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier
                        .heightIn(min = 44.dp)
                        .background(Sk.Card, RoundedCornerShape(50))
                        .border(1.dp, Sk.FieldLine, RoundedCornerShape(50))
                        .padding(start = 12.dp, end = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Dot(if (offline) Sk.Faint else Sk.Online)
                    Text(state.computerName, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Sk.Ink)
                    Text(if (offline) "离线" else "在线", fontSize = 13.sp, color = Sk.Muted)
                }
                Spacer(Modifier.weight(1f))
                Tag(state.mode + "模式", Sk.BlueSoft, Sk.BlueInk, fontSize = 13)
            }
            Row(Modifier.padding(start = 4.dp)) {
                Text("项目 ", fontSize = 13.sp, color = Sk.Muted)
                Text(state.project.ifEmpty { "还没打开" }, fontSize = 13.sp, color = Sk.Ink, fontFamily = Sk.Mono)
            }
        }

        // 中间：头像、台词、卡片
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            WhaleAvatar(status, size = 196.dp)
            Spacer(Modifier.height(18.dp))
            Text(
                status.speech,
                Modifier
                    .background(Sk.Card, RoundedCornerShape(18.dp))
                    .border(1.dp, Sk.FieldLine, RoundedCornerShape(18.dp))
                    .padding(horizontal = 18.dp, vertical = 10.dp),
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
                color = Sk.Ink,
            )
            Spacer(Modifier.height(6.dp))
            Text(status.homeLabel, fontSize = 12.sp, color = Sk.Muted, letterSpacing = 1.sp)
            Spacer(Modifier.height(18.dp))
            StatusCard(card)
            Spacer(Modifier.height(4.dp))
        }

        // 快捷指令
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("继续", "停下", "跑测试修一下", "总结改了啥").forEach { cmd ->
                SecondaryPill(
                    cmd,
                    onClick = { if (cmd == "停下") onStop() else onSend(cmd) },
                    minHeight = 40.dp,
                    border = Sk.FieldLine,
                    fontSize = 14,
                    enabled = !offline,
                )
            }
        }

        // 输入框。统一规则第 4 条：电脑不在线时禁用。
        Row(
            Modifier
                .padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 14.dp)
                .fillMaxWidth()
                .alpha(if (offline) 0.45f else 1f)
                .background(Sk.Card, RoundedCornerShape(26.dp))
                .border(1.dp, Sk.FieldLine, RoundedCornerShape(26.dp))
                .padding(start = 18.dp, top = 4.dp, bottom = 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) {
                    Text(if (offline) "电脑不在线，暂时不能派活" else "说一句话派活…", fontSize = 15.sp, color = Sk.Faint)
                }
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    enabled = !offline,
                    maxLines = 3,
                    textStyle = TextStyle(fontSize = 15.sp, color = Sk.Ink),
                    cursorBrush = SolidColor(Sk.Accent),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = {
                    if (text.isNotBlank()) {
                        onSend(text.trim())
                        text = ""
                    }
                },
                enabled = !offline,
                modifier = Modifier.size(44.dp),
                colors = IconButtonDefaults.iconButtonColors(
                    containerColor = Sk.Primary,
                    contentColor = Color.White,
                    disabledContainerColor = Sk.Primary,
                    disabledContentColor = Color.White,
                ),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "发送", modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun StatusCard(c: HomeCard) {
    SkCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(c.kicker, Modifier.weight(1f), fontSize = 13.sp, color = Sk.Muted)
            if (c.meta.isNotEmpty()) Text(c.meta, fontSize = 12.sp, color = Sk.Muted)
        }
        Text(c.title, fontSize = 17.sp, fontWeight = FontWeight.Bold, lineHeight = 24.sp, color = Sk.Ink)
        if (c.progress != null) {
            Box(Modifier.fillMaxWidth().height(6.dp).background(Sk.Divider, RoundedCornerShape(3.dp))) {
                Box(
                    Modifier
                        .fillMaxWidth(c.progress.coerceIn(0f, 1f))
                        .fillMaxHeight()
                        .background(Sk.Accent, RoundedCornerShape(3.dp)),
                )
            }
        }
        Text(
            c.body,
            fontSize = 14.sp,
            lineHeight = 21.sp,
            color = Sk.Ink2,
            fontFamily = if (c.mono) FontFamily.Monospace else null,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            if (c.secondary != null) SecondaryPill(c.secondary, c.onSecondary)
            PrimaryPill(c.primary, c.onPrimary)
        }
    }
}

private fun homeCard(
    s: LinkState,
    status: WhaleStatus,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onReconnect: () -> Unit,
    onOpenTask: () -> Unit,
    onOpenReceipt: (Receipt) -> Unit,
    onRespond: (String, Boolean) -> Unit,
): HomeCard {
    val task = s.task
    val receipt = s.receipts.firstOrNull()
    val total = task?.plan?.size ?: 0
    val stepNo = task?.plan?.let { p ->
        val i = p.indexOfFirst { it.state == StepState.IN_PROGRESS }
        if (i >= 0) i + 1 else p.count { it.state == StepState.DONE || it.state == StepState.SKIPPED }
    } ?: 0
    return when (status) {
        WhaleStatus.WORKING -> HomeCard(
            kicker = "计划 $stepNo/$total",
            meta = task?.agents?.firstOrNull { it.busy }?.name.orEmpty(),
            title = task?.plan?.firstOrNull { it.state == StepState.IN_PROGRESS }?.title ?: task?.instruction.orEmpty(),
            body = "正在" + (task?.current ?: "准备"),
            mono = true,
            progress = if (total > 0) (stepNo - 1).coerceAtLeast(0).toFloat() / total + 0.5f / total else 0f,
            secondary = "停下",
            onSecondary = onStop,
            primary = "详情",
            onPrimary = onOpenTask,
        )
        WhaleStatus.WAITING -> {
            val a = s.approvals.firstOrNull { it.handledReason == null }
            HomeCard(
                kicker = a?.let { "${it.from} ${it.title}" } ?: "有事要你拍板",
                meta = a?.let { "还剩 " + fmtSeconds(it.secondsLeft) }.orEmpty(),
                title = a?.detail ?: "去「待办」处理",
                body = "位置：" + (a?.where ?: s.project),
                secondary = "拒绝",
                onSecondary = { a?.let { onRespond(it.id, false) } },
                primary = "同意",
                onPrimary = { a?.let { onRespond(it.id, true) } },
            )
        }
        WhaleStatus.DONE -> HomeCard(
            kicker = "回执 · " + (receipt?.time ?: ""),
            meta = receipt?.let { "改了 ${it.files.size} 个文件" }.orEmpty(),
            title = receipt?.summary ?: "做完了",
            body = receipt?.let { if (it.blocked.isEmpty()) "没有被拦下的事" else "有 ${it.blocked.size} 件事被拦下，要你自己来" }.orEmpty(),
            primary = "看回执",
            onPrimary = { receipt?.let(onOpenReceipt) },
        )
        WhaleStatus.ERROR -> HomeCard(
            kicker = "任务中断",
            meta = "",
            title = "模型拒绝回答这一步", // 接口里没有出错原因，先用常量
            body = "换个说法再派一次，或者在电脑上看看",
            secondary = "看详情",
            onSecondary = onOpenTask,
            primary = "重试",
            onPrimary = { task?.instruction?.let(onSend) },
        )
        WhaleStatus.HALTED -> HomeCard(
            kicker = "已停下",
            meta = if (total > 0) "计划 $stepNo/$total" else "",
            title = "步数用完了", // 接口里没有停下原因，先用常量
            body = task?.plan?.filter { it.state == StepState.PENDING || it.state == StepState.IN_PROGRESS }
                ?.takeIf { it.isNotEmpty() }
                ?.joinToString("、", prefix = "还差：") { it.title } ?: "还差几步没做",
            secondary = "看详情",
            onSecondary = onOpenTask,
            primary = "继续",
            onPrimary = { onSend("继续") },
        )
        WhaleStatus.OFFLINE -> HomeCard(
            kicker = "上次在线",
            meta = "",
            title = s.lastSeen.ifEmpty { "不久前" },
            body = "电脑醒来后会自动连上",
            primary = "重新连接",
            onPrimary = onReconnect,
        )
        WhaleStatus.IDLE -> if (receipt != null) {
            HomeCard(
                kicker = "最近一条回执",
                meta = receipt.time,
                title = receipt.title,
                body = "改了 ${receipt.files.size} 个文件",
                primary = "看回执",
                onPrimary = { onOpenReceipt(receipt) },
            )
        } else {
            HomeCard(kicker = "还没有回执", meta = "", title = "派个活试试", body = "在下面说一句话就行", primary = "跑测试修一下", onPrimary = { onSend("跑测试修一下") })
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun HomePreview() {
    SikeoopTheme {
        HomeScreen(state = FakeLink().state.value, onSend = {}, onStop = {}, onReconnect = {}, onOpenTask = {})
    }
}
