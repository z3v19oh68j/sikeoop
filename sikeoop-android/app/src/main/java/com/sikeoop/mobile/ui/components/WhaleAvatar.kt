package com.sikeoop.mobile.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sikeoop.mobile.R
import com.sikeoop.mobile.core.model.WhaleStatus
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/** 鲸鱼娘的几张静止画面。 */
enum class WhalePose(val res: Int) {
    WORK(R.drawable.whale_work),
    SLEEPY(R.drawable.whale_sleepy),
    WAITING(R.drawable.whale_waiting),
    LAZY(R.drawable.whale_lazy),
    ERROR(R.drawable.whale_error),
}

fun WhaleStatus.pose(): WhalePose = when (this) {
    WhaleStatus.IDLE -> WhalePose.SLEEPY
    WhaleStatus.WORKING -> WhalePose.WORK
    WhaleStatus.WAITING -> WhalePose.WAITING
    WhaleStatus.DONE -> WhalePose.LAZY
    WhaleStatus.ERROR -> WhalePose.ERROR
    WhaleStatus.HALTED -> WhalePose.SLEEPY
    WhaleStatus.OFFLINE -> WhalePose.SLEEPY
}

/** 状态头像：圆形白底 + 一圈 #F3ECE4 外环；离线时灰度加半透明。动画版放 P3。 */
@Composable
fun WhaleAvatar(status: WhaleStatus, modifier: Modifier = Modifier, size: Dp = 196.dp) {
    WhaleImage(status.pose(), modifier, size, ring = (size.value / 24f).coerceAtLeast(5f).dp, dim = status == WhaleStatus.OFFLINE)
}

@Composable
fun WhaleImage(pose: WhalePose, modifier: Modifier = Modifier, size: Dp, ring: Dp = 5.dp, dim: Boolean = false) {
    Box(
        modifier
            .size(size + ring * 2)
            .clip(CircleShape)
            .background(Sk.Ring),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(pose.res),
            contentDescription = "鲸鱼娘",
            contentScale = ContentScale.Crop,
            colorFilter = if (dim) ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) else null,
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(Sk.Card)
                .alpha(if (dim) 0.6f else 1f),
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun AvatarPreview() {
    SikeoopTheme {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            WhaleAvatar(WhaleStatus.WORKING, Modifier.padding(8.dp), size = 120.dp)
            WhaleAvatar(WhaleStatus.OFFLINE, Modifier.padding(8.dp), size = 120.dp)
        }
    }
}
