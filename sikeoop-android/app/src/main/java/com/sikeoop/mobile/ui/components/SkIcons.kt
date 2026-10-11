package com.sikeoop.mobile.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 设计稿里的描边图标（24×24 视框，圆头圆角），路径照抄设计稿的 SVG。 */
object SkIcons {
    val Home = stroke("M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z")
    val Todo = stroke("M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z", "M8 12l3 3 5-6")
    val Folder = stroke("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")
    val Person = stroke("M16 8a4 4 0 1 1-8 0a4 4 0 1 1 8 0z", "M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6")
    val Send = stroke("M5 12h14M13 6l6 6-6 6")
    val Back = stroke("M15 6l-6 6 6 6")
    val Chevron = stroke("M9 6l6 6-6 6")
    val Check = stroke("M5 12l5 5 9-10", width = 3f)
    val Minus = stroke("M6 12h12", width = 2.5f)
    val Lock = stroke("M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z", "M8 11V7a4 4 0 0 1 8 0v4")
    val Clock = stroke("M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M12 7v5l3 2")
    val Laptop = stroke("M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M2 20h20")
    val Shield = stroke("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z")

    private fun stroke(vararg paths: String, width: Float = 2f): ImageVector =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            for (p in paths) {
                addPath(
                    pathData = addPathNodes(p),
                    fill = null,
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = width,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()
}

@Composable
fun SkIcon(icon: ImageVector, tint: Color, size: Dp = 24.dp, contentDescription: String? = null, modifier: Modifier = Modifier) {
    Icon(icon, contentDescription = contentDescription, tint = tint, modifier = modifier.size(size))
}
