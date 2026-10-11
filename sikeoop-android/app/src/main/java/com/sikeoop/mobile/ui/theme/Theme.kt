package com.sikeoop.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

/** 设计令牌，和高保真设计稿一致。改这里，整个 App 一起变。 */
object Sk {
    val Bg = Color(0xFFFBF7F2)
    val Ink = Color(0xFF2A2420)
    val Ink2 = Color(0xFF4A413B)
    val Muted = Color(0xFF6E635A)
    val Faint = Color(0xFFA39A92)
    val Card = Color(0xFFFFFFFF)
    val CardLine = Color(0xFFECE3D9)
    val FieldLine = Color(0xFFE6DCD1)
    val BtnLine = Color(0xFFD9CEC2)
    val Divider = Color(0xFFF1E9E0)
    val Ring = Color(0xFFF3ECE4)
    val CodeBg = Color(0xFFF6F1EB)
    val GrayCard = Color(0xFFF3EEE8)
    val Pending = Color(0xFFCFC4B8)

    val Accent = Color(0xFFE8553F)       // 只做描边、进度条、点缀
    val AccentSoft = Color(0xFFFDF0EC)
    val Primary = Color(0xFFC4402C)      // 白字按钮底色
    val Warn = Color(0xFFA8361F)
    val WarnSoft = Color(0xFFFCE9E4)

    val Blue = Color(0xFF2A6F8E)
    val BlueSoft = Color(0xFFE3EEF3)
    val BlueInk = Color(0xFF1F5A74)
    val Online = Color(0xFF2E9B5F)
    val Ok = Color(0xFF24653F)
    val Ok2 = Color(0xFF2E7D4F)
    val OkSoft = Color(0xFFE5F2EA)

    val Dark = Color(0xFF1E1A17)
    val Dark2 = Color(0xFF2E2824)
    val Dark3 = Color(0xFF3A332E)
    val DarkMuted = Color(0xFFB8ADA2)

    val Mono = FontFamily.Monospace
}

private val LightColors = lightColorScheme(
    primary = Sk.Primary,
    onPrimary = Color.White,
    secondary = Sk.Blue,
    onSecondary = Color.White,
    background = Sk.Bg,
    onBackground = Sk.Ink,
    surface = Sk.Card,
    onSurface = Sk.Ink,
    surfaceVariant = Sk.GrayCard,
    onSurfaceVariant = Sk.Muted,
    outline = Sk.BtnLine,
    outlineVariant = Sk.CardLine,
    error = Sk.Warn,
)

@Composable
fun SikeoopTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LightColors, content = content)
}
