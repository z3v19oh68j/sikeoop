package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.sikeoop.mobile.core.model.PairingPhase
import com.sikeoop.mobile.ui.components.BackHeader
import com.sikeoop.mobile.ui.components.QrScanner
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/**
 * 扫码配对（深色取景页）。P1 在取景框里接 ZXing（不依赖谷歌服务）；
 * 二维码只能用一次、5 分钟过期。双击画面切换前后摄像头；调试版长按画面当作扫码成功。
 * 对应设计稿 Pair。
 */
@Composable
fun PairScreen(
    onBack: () -> Unit,
    onPaired: (code: String) -> Unit,
    phase: PairingPhase = PairingPhase.NONE,
    error: String? = null,
) {
    // 失败后重新扫：换一个 key，取景器重新开始识别。
    var attempt by remember { mutableIntStateOf(0) }
    var lastPhase by remember { mutableStateOf(phase) }
    if (phase != lastPhase) {
        if (phase == PairingPhase.FAILED) attempt++
        lastPhase = phase
    }
    val busy = phase == PairingPhase.CONNECTING || phase == PairingPhase.WAITING_APPROVAL
    Column(Modifier.fillMaxSize().background(Sk.Dark)) {
        BackHeader("添加电脑", onBack, tint = Sk.Ring, centerTitle = false)
        Spacer(Modifier.height(48.dp))
        key(attempt) {
            QrScanner(onResult = onPaired, modifier = Modifier.align(Alignment.CenterHorizontally).size(270.dp)) {
                if (busy) {
                    Box(Modifier.fillMaxSize().background(Sk.Dark.copy(alpha = 0.78f)), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            CircularProgressIndicator(color = Sk.Accent, strokeWidth = 3.dp, modifier = Modifier.size(32.dp))
                            Text(if (phase == PairingPhase.CONNECTING) "正在连接电脑…" else "在电脑上点「允许」", fontSize = 15.sp, color = Sk.Ring)
                        }
                    }
                } else {
                    ViewfinderOverlay()
                }
            }
        }
        if (phase == PairingPhase.FAILED && error != null) {
            Text(
                error,
                Modifier.padding(start = 28.dp, end = 28.dp, top = 20.dp).fillMaxWidth()
                    .background(Sk.Warn.copy(alpha = 0.22f), RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
                fontSize = 14.sp,
                color = Sk.Ring,
            )
        }
        Column(Modifier.padding(start = 28.dp, end = 28.dp, top = if (phase == PairingPhase.FAILED) 20.dp else 40.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("在电脑上的 sikeoop 里：", fontSize = 15.sp, color = Sk.DarkMuted)
            listOf("打开「手机」页", "点「添加手机」", "扫屏幕上的二维码").forEachIndexed { i, step ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(26.dp).background(Sk.Dark3, CircleShape), contentAlignment = Alignment.Center) {
                        Text("${i + 1}", fontSize = 13.sp, color = Sk.Ring)
                    }
                    Text(step, fontSize = 16.sp, color = Sk.Ring)
                }
            }
        }
        Spacer(Modifier.weight(1f))
        Row(
            Modifier.padding(start = 28.dp, end = 28.dp, bottom = 36.dp).fillMaxWidth()
                .background(Sk.Dark2, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SkIcon(SkIcons.Clock, Sk.DarkMuted, size = 16.dp)
            Text("二维码 5 分钟内有效，只能扫一次", fontSize = 13.sp, color = Sk.DarkMuted)
        }
    }
}

/** 画在相机画面上的取景框：四个圆角描边角、上下扫的光线、提示文字。 */
@Composable
private fun ViewfinderOverlay() {
    val scan by rememberInfiniteTransition(label = "scan").animateFloat(
        initialValue = 0.2f,
        targetValue = 0.8f,
        animationSpec = infiniteRepeatable(tween(1600), RepeatMode.Reverse),
        label = "line",
    )
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val k = size.width / 270f
            val corners = Path().apply {
                moveTo(14f * k, 60f * k); lineTo(14f * k, 36f * k); quadraticTo(14f * k, 14f * k, 36f * k, 14f * k); lineTo(60f * k, 14f * k)
                moveTo(210f * k, 14f * k); lineTo(234f * k, 14f * k); quadraticTo(256f * k, 14f * k, 256f * k, 36f * k); lineTo(256f * k, 60f * k)
                moveTo(256f * k, 210f * k); lineTo(256f * k, 234f * k); quadraticTo(256f * k, 256f * k, 234f * k, 256f * k); lineTo(210f * k, 256f * k)
                moveTo(60f * k, 256f * k); lineTo(36f * k, 256f * k); quadraticTo(14f * k, 256f * k, 14f * k, 234f * k); lineTo(14f * k, 210f * k)
            }
            drawPath(corners, Sk.Accent, style = Stroke(width = 5f * k, cap = StrokeCap.Round))
            val y = size.height * scan
            drawLine(Sk.Accent.copy(alpha = 0.35f), Offset(30f * k, y), Offset(size.width - 30f * k, y), strokeWidth = 8f * k, cap = StrokeCap.Round)
            drawLine(Sk.Accent, Offset(30f * k, y), Offset(size.width - 30f * k, y), strokeWidth = 2f * k, cap = StrokeCap.Round)
        }
        Text(
            "把二维码放进框里 · 双击切换前后摄像头",
            Modifier.align(Alignment.BottomCenter).padding(bottom = 22.dp)
                .background(Sk.Dark.copy(alpha = 0.55f), RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
            fontSize = 12.sp,
            fontWeight = FontWeight.Normal,
            color = Sk.Ring,
        )
    }
}

@Preview(widthDp = 390, heightDp = 844)
@Composable
private fun PairPreview() {
    SikeoopTheme { PairScreen({}, {}) }
}
