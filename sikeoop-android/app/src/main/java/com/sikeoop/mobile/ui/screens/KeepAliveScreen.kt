package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.ui.components.PrimaryPill
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.components.WhaleImage
import com.sikeoop.mobile.ui.components.WhalePose
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

private data class KeepAliveItem(val title: String, val hint: String)

private val ITEMS = listOf(
    KeepAliveItem("允许通知", "有事要你拍板时才会响"),
    KeepAliveItem("电池不限制", "不然锁屏几分钟就被系统杀掉"),
    KeepAliveItem("后台自启动", "手机重启后自动连回电脑"),
)

/**
 * onBack 由外层的返回键处理，这页本身不画返回按钮（设计稿如此）。
 * 保活引导：配对成功后的三项检查。「去设置」现在只把这一项标成已开启，
 * 跳到各家系统设置页放 P1（每个厂商的页面不一样）。对应设计稿 KeepAlive。
 */
@Composable
fun KeepAliveScreen(
    computerName: String = "我的 MacBook",
    onBack: () -> Unit,
    onDone: () -> Unit,
    onOpenSetting: (index: Int) -> Unit = {},
) {
    var done by remember { mutableStateOf(setOf(0)) }
    Column(
        Modifier.fillMaxSize().background(Sk.Bg).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 48.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(
            Modifier.background(Sk.OkSoft, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SkIcon(SkIcons.Check, Sk.Ok, size = 14.dp)
            Text("已连上：$computerName", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Sk.Ok)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            WhaleImage(WhalePose.WAITING, size = 76.dp, ring = 5.dp)
            Text("再做 3 步，\n本鲸才不会掉线", fontSize = 24.sp, fontWeight = FontWeight.Bold, lineHeight = 32.sp, color = Sk.Ink)
        }

        val shape = RoundedCornerShape(20.dp)
        Column(Modifier.fillMaxWidth().background(Sk.Card, shape).border(1.dp, Sk.CardLine, shape)) {
            ITEMS.forEachIndexed { i, item ->
                val ok = i in done
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (ok) {
                        Box(Modifier.size(26.dp).background(Sk.Blue, CircleShape), contentAlignment = Alignment.Center) { SkIcon(SkIcons.Check, Color.White, size = 14.dp) }
                    } else {
                        Box(Modifier.size(26.dp).border(2.dp, Sk.Pending, CircleShape))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(item.title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Sk.Ink)
                        Text(item.hint, fontSize = 13.sp, color = Sk.Muted)
                    }
                    if (ok) {
                        Text("已开启", fontSize = 13.sp, color = Sk.Ok)
                    } else {
                        Button(
                            onClick = { onOpenSetting(i); done = done + i },
                            modifier = Modifier.heightIn(min = 40.dp),
                            shape = RoundedCornerShape(50),
                            colors = ButtonDefaults.buttonColors(containerColor = Sk.WarnSoft, contentColor = Sk.Warn),
                            contentPadding = PaddingValues(horizontal = 14.dp),
                            elevation = null,
                        ) { Text("去设置", fontSize = 14.sp, fontWeight = FontWeight.Medium) }
                    }
                }
                if (i < ITEMS.lastIndex) Box(Modifier.fillMaxWidth().height(1.dp).background(Sk.Divider))
            }
        }

        Text("小米、华为、OPPO、vivo 等国产手机，后两项一定要打开。", fontSize = 13.sp, lineHeight = 21.sp, color = Sk.Muted)
        Spacer(Modifier.height(4.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryPill("全部好了，进入", onDone, Modifier.fillMaxWidth(), minHeight = 54.dp, fontSize = 17)
            Text(
                "先跳过",
                Modifier.fillMaxWidth().clickable(onClick = onDone).heightIn(min = 44.dp).padding(top = 12.dp),
                fontSize = 14.sp,
                color = Sk.Muted,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun KeepAlivePreview() {
    SikeoopTheme { KeepAliveScreen(onBack = {}, onDone = {}) }
}
