package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.ui.components.PrimaryPill
import com.sikeoop.mobile.ui.components.Tag
import com.sikeoop.mobile.ui.components.WhaleImage
import com.sikeoop.mobile.ui.components.WhalePose
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/**
 * 第一次打开：连接电脑。「在手机上写代码」是 B 线（内测），
 * onLocal 为 null 时不显示这个入口。对应设计稿 Welcome。
 */
@Composable
fun WelcomeScreen(onPair: () -> Unit, onLocal: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().background(Sk.Bg).padding(start = 28.dp, end = 28.dp, top = 120.dp, bottom = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WhaleImage(WhalePose.LAZY, size = 240.dp, ring = 10.dp)
        Spacer(Modifier.height(40.dp))
        Text("本鲸来了，别怕~", fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp, color = Sk.Ink)
        Spacer(Modifier.height(12.dp))
        Text("把电脑上的我装进口袋", fontSize = 16.sp, color = Sk.Muted)
        Spacer(Modifier.weight(1f))
        PrimaryPill("连接我的电脑", onPair, Modifier.fillMaxWidth(), minHeight = 54.dp, fontSize = 17)
        if (onLocal != null) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onLocal,
                modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
                shape = RoundedCornerShape(50),
                border = BorderStroke(1.dp, Sk.BtnLine),
                colors = ButtonDefaults.outlinedButtonColors(containerColor = Sk.Card),
            ) { LocalLabel() }
        }
    }
}

/** 次按钮里带「内测」标签的那一种。 */
@Composable
private fun LocalLabel() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("在手机上写代码", fontSize = 15.sp, color = Sk.Ink)
        Tag("内测", Sk.BlueSoft, Sk.BlueInk, fontSize = 12)
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun WelcomePreview() {
    SikeoopTheme { WelcomeScreen(onPair = {}) }
}
