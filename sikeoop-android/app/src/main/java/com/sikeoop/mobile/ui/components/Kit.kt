package com.sikeoop.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.ui.theme.Sk

val CardShape = RoundedCornerShape(20.dp)

/** 白底、细描边、20dp 圆角的卡片。 */
@Composable
fun SkCard(
    modifier: Modifier = Modifier,
    border: Color = Sk.CardLine,
    borderWidth: Dp = 1.dp,
    bg: Color = Sk.Card,
    radius: Dp = 20.dp,
    padding: PaddingValues = PaddingValues(16.dp),
    gap: Dp = 10.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(radius)
    Column(
        modifier
            .fillMaxWidth()
            .background(bg, shape)
            .border(borderWidth, border, shape)
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(gap),
        content = content,
    )
}

/** 白字主按钮，胶囊形。 */
@Composable
fun PrimaryPill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    minHeight: Dp = 44.dp,
    fontSize: Int = 15,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = minHeight),
        shape = RoundedCornerShape(50),
        colors = ButtonDefaults.buttonColors(containerColor = Sk.Primary, contentColor = Color.White),
        contentPadding = PaddingValues(horizontal = 22.dp),
    ) { Text(text, fontSize = fontSize.sp, fontWeight = FontWeight.Medium) }
}

/** 白底描边次按钮，胶囊形。 */
@Composable
fun SecondaryPill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    minHeight: Dp = 44.dp,
    border: Color = Sk.BtnLine,
    color: Color = Sk.Ink,
    fontSize: Int = 15,
    enabled: Boolean = true,
    weight: FontWeight = FontWeight.Normal,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = minHeight),
        shape = RoundedCornerShape(50),
        border = BorderStroke(1.dp, border),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Sk.Card, contentColor = color),
        contentPadding = PaddingValues(horizontal = 18.dp),
    ) { Text(text, fontSize = fontSize.sp, fontWeight = weight) }
}

/** 小胶囊标签。 */
@Composable
fun Tag(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier, mono: Boolean = false, fontSize: Int = 13) {
    Text(
        text,
        modifier
            .background(bg, RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 3.dp),
        color = fg,
        fontSize = fontSize.sp,
        fontWeight = FontWeight.Medium,
        fontFamily = if (mono) Sk.Mono else null,
    )
}

@Composable
fun Dot(color: Color, size: Dp = 8.dp) {
    Box(Modifier.size(size).background(color, RoundedCornerShape(50)))
}

/** 小节标题（灰字）。 */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, size: Int = 13) {
    Text(text, modifier, fontSize = size.sp, fontWeight = FontWeight.Medium, color = Sk.Muted)
}

/** 二级页顶栏：返回 + 标题 + 右侧。 */
@Composable
fun BackHeader(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Sk.Ink,
    centerTitle: Boolean = true,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = 8.dp, end = 12.dp, top = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = tint)
        }
        Text(
            title,
            Modifier.weight(1f).padding(start = 4.dp),
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = tint,
            textAlign = if (centerTitle) androidx.compose.ui.text.style.TextAlign.Center else null,
        )
        Row(Modifier.defaultMinSize(minWidth = 44.dp), horizontalArrangement = Arrangement.End, content = trailing)
    }
}

/** 列表里一行：标题、右侧说明、箭头。 */
@Composable
fun ListRow(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    divider: Boolean = true,
    minHeight: Dp = 56.dp,
    showChevron: Boolean = onClick != null,
    content: @Composable RowScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .heightIn(min = minHeight)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            content()
            if (showChevron) Chevron()
        }
        if (divider) Box(Modifier.fillMaxWidth().padding(0.dp).heightIn(min = 1.dp, max = 1.dp).background(Sk.Divider))
    }
}

@Composable
fun Chevron() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = Sk.Faint,
        modifier = Modifier.size(20.dp),
    )
}

fun fmtSeconds(sec: Int): String = "%d:%02d".format(sec / 60, sec % 60)
