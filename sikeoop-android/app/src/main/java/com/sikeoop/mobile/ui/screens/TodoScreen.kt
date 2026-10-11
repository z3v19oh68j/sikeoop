package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.ApprovalItem
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.link.FakeLink
import com.sikeoop.mobile.ui.components.PrimaryPill
import com.sikeoop.mobile.ui.components.SecondaryPill
import com.sikeoop.mobile.ui.components.SkCard
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.components.Tag
import com.sikeoop.mobile.ui.components.fmtSeconds
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/** 待办：要你拍板的卡（普通 / 撤不回 / 已在别处处理）+ 回执列表。对应设计稿 Todo。 */
@Composable
fun TodoScreen(
    state: LinkState,
    onRespond: (id: String, allow: Boolean) -> Unit,
    onOpenReceipt: (Receipt) -> Unit,
) {
    val open = state.approvals.count { it.handledReason == null }
    LazyColumn(
        Modifier.fillMaxSize().background(Sk.Bg),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { Text("待办", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Sk.Ink) }
        item { Heading("要你拍板 · $open", Modifier.padding(top = 8.dp)) }
        if (state.approvals.isEmpty()) {
            item { Text("没有要拍板的事，本鲸自己搞得定~", fontSize = 14.sp, color = Sk.Muted) }
        }
        items(state.approvals, key = { it.id }) { a ->
            when {
                a.handledReason != null -> HandledCard(a)
                a.humanOnly -> HumanOnlyCard(a, onRespond)
                else -> ApprovalCard(a, onRespond)
            }
        }
        item { Heading("回执", Modifier.padding(top = 12.dp)) }
        if (state.receipts.isEmpty()) {
            item { Text("还没有回执", fontSize = 14.sp, color = Sk.Muted) }
        } else {
            item { ReceiptList(state.receipts, onOpenReceipt) }
        }
    }
}

@Composable
private fun Heading(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Sk.Muted)
}

@Composable
private fun ApprovalCard(a: ApprovalItem, onRespond: (String, Boolean) -> Unit) {
    SkCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("${a.from} ${a.title}", Modifier.weight(1f), fontSize = 13.sp, color = Sk.Muted)
            Tag(fmtSeconds(a.secondsLeft), Sk.WarnSoft, Sk.Warn, mono = true)
        }
        Text(
            a.detail,
            Modifier.fillMaxWidth().background(Sk.CodeBg, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
            fontSize = 15.sp,
            fontFamily = Sk.Mono,
            color = Sk.Ink,
        )
        Text("位置 ${a.where} · 超时会回到电脑上问", fontSize = 13.sp, color = Sk.Muted)
        TwoButtons("拒绝", "同意", { onRespond(a.id, false) }, { onRespond(a.id, true) })
    }
}

/** 推送、发布这类撤不回的操作：红色描边、锁形标记，同意前要先解锁手机。 */
@Composable
private fun HumanOnlyCard(a: ApprovalItem, onRespond: (String, Boolean) -> Unit) {
    SkCard(border = Sk.Accent, borderWidth = 1.5.dp) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SkIcon(SkIcons.Lock, Sk.Warn, size = 16.dp)
                Text("撤不回 · 同意前要先解锁", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Sk.Warn)
            }
            Tag(fmtSeconds(a.secondsLeft), Sk.CodeBg, Sk.Muted, mono = true)
        }
        Text("${a.from}${a.title}", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Sk.Ink)
        Text(a.detail, fontSize = 14.sp, fontFamily = Sk.Mono, color = Sk.Ink2)
        Text("位置 ${a.where} · 超时没回按拒绝处理", fontSize = 13.sp, color = Sk.Muted)
        TwoButtons("拒绝", "解锁并同意", { onRespond(a.id, false) }, { onRespond(a.id, true) })
    }
}

/** 已超时或在电脑、微信上处理过：灰底虚线，没有按钮。 */
@Composable
private fun HandledCard(a: ApprovalItem) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Sk.GrayCard, RoundedCornerShape(20.dp))
            .drawBehind {
                drawRoundRect(
                    color = Sk.BtnLine,
                    cornerRadius = CornerRadius(20.dp.toPx()),
                    style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f))),
                )
            }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text("${a.from} ${a.title}", Modifier.weight(1f), fontSize = 13.sp, color = Sk.Muted)
            Text(if (a.secondsLeft <= 0) "已超时" else "已处理", fontSize = 13.sp, color = Sk.Muted)
        }
        Text(a.detail, fontSize = 14.sp, fontFamily = Sk.Mono, color = Sk.Muted)
        Text(a.handledReason.orEmpty(), fontSize = 13.sp, color = Sk.Muted)
    }
}

@Composable
private fun TwoButtons(no: String, yes: String, onNo: () -> Unit, onYes: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        SecondaryPill(no, onNo, Modifier.weight(1f), minHeight = 48.dp)
        PrimaryPill(yes, onYes, Modifier.weight(1f), minHeight = 48.dp)
    }
}

@Composable
private fun ReceiptList(receipts: List<Receipt>, onOpen: (Receipt) -> Unit) {
    val shape = RoundedCornerShape(20.dp)
    Column(Modifier.fillMaxWidth().background(Sk.Card, shape).border(1.dp, Sk.CardLine, shape)) {
        receipts.forEachIndexed { i, r ->
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(r) }.heightIn(min = 64.dp).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(r.time, Modifier.width(40.dp), fontSize = 13.sp, color = Sk.Muted, maxLines = 1)
                Text(r.title, Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Sk.Ink, maxLines = 1)
                Text("改 ${r.files.size} 个文件", fontSize = 13.sp, color = Sk.Muted)
                SkIcon(SkIcons.Chevron, Sk.Faint, size = 18.dp)
            }
            if (i < receipts.lastIndex) Box(Modifier.fillMaxWidth().height(1.dp).background(Sk.Divider))
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun TodoPreview() {
    SikeoopTheme { TodoScreen(FakeLink().state.value, { _, _ -> }, {}) }
}
