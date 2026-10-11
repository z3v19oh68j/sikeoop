package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.link.FakeLink
import com.sikeoop.mobile.ui.components.Dot
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/**
 * 我的：电脑卡片、设置列表、懒人模式说明。对应设计稿 My。
 * keepAliveMissing：保活检查里还没开的项数，0 时不显示红字。
 */
@Composable
fun MyScreen(
    state: LinkState,
    onPair: () -> Unit,
    onKeepAlive: () -> Unit,
    keepAliveMissing: Int = 0,
    onShortcuts: () -> Unit = {},
    onModels: () -> Unit = {},
    onAbout: () -> Unit = {},
) {
    Column(
        Modifier.fillMaxSize().background(Sk.Bg).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("我的", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Sk.Ink)

        val shape = RoundedCornerShape(20.dp)
        Row(
            Modifier.fillMaxWidth().background(Sk.Card, shape).border(1.dp, Sk.CardLine, shape).clickable(onClick = onPair).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(Modifier.size(48.dp).background(Sk.BlueSoft, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                SkIcon(SkIcons.Laptop, Sk.BlueInk)
            }
            Column(Modifier.weight(1f)) {
                Text(state.computerName, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Sk.Ink)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Dot(if (state.online) Sk.Online else Sk.Faint, size = 7.dp)
                    val where = state.project.takeIf { it.isNotEmpty() }?.let { " · 项目 $it" }.orEmpty()
                    Text((if (state.online) "在线" else "离线") + where, fontSize = 13.sp, color = Sk.Muted)
                }
            }
            SkIcon(SkIcons.Chevron, Sk.Faint, size = 18.dp)
        }

        Column(Modifier.fillMaxWidth().background(Sk.Card, shape).border(1.dp, Sk.CardLine, shape)) {
            SettingRow("通知与保活检查", onKeepAlive, note = if (keepAliveMissing > 0) "$keepAliveMissing 项没开" else null, warn = true)
            SettingRow("快捷指令", onShortcuts)
            SettingRow("模型与 Key", onModels, sub = "本地编程用")
            SettingRow("微信兜底", null, note = "电脑端已开启")
            SettingRow("关于 / 反馈", onAbout, last = true)
        }

        Row(
            Modifier.fillMaxWidth().background(Sk.BlueSoft, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SkIcon(SkIcons.Shield, Sk.BlueInk, size = 18.dp, modifier = Modifier.padding(top = 2.dp))
            Text(
                "远程任务默认用${state.mode}模式：危险操作照旧拦下，推送和发布会在手机上问你。",
                fontSize = 13.sp,
                lineHeight = 21.sp,
                color = Sk.BlueInk,
            )
        }
    }
}

@Composable
private fun SettingRow(
    title: String,
    onClick: (() -> Unit)?,
    sub: String? = null,
    note: String? = null,
    warn: Boolean = false,
    last: Boolean = false,
) {
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).heightIn(min = 56.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, fontSize = 15.sp, color = Sk.Ink)
            if (sub != null) Text(sub, fontSize = 12.sp, color = Sk.Muted)
        }
        if (note != null) Text(note, fontSize = 13.sp, color = if (warn) Sk.Warn else Sk.Muted)
        if (onClick != null) SkIcon(SkIcons.Chevron, Sk.Faint, size = 18.dp)
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(Sk.Divider))
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun MyPreview() {
    SikeoopTheme { MyScreen(FakeLink().state.value, {}, {}, keepAliveMissing = 2) }
}
