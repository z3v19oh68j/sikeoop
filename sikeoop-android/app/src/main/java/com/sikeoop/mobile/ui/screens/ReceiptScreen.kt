package com.sikeoop.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.ChangeKind
import com.sikeoop.mobile.core.model.FileChange
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.link.FakeLink
import com.sikeoop.mobile.ui.components.BackHeader
import com.sikeoop.mobile.ui.components.SecondaryPill
import com.sikeoop.mobile.ui.components.SectionLabel
import com.sikeoop.mobile.ui.components.SkCard
import com.sikeoop.mobile.ui.components.WhaleImage
import com.sikeoop.mobile.ui.components.WhalePose
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/** 回执：本鲸一句话总结、改了哪些文件、你拍板的事、被拦下的事、她自己的决定、撤销。对应设计稿 Receipt。 */
@Composable
fun ReceiptScreen(receipt: Receipt, onBack: () -> Unit, onUndo: () -> Unit, onOpenDiff: () -> Unit = {}) {
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(Sk.Bg)) {
        BackHeader("回执", onBack) {
            Text(receipt.time, Modifier.padding(end = 8.dp), fontSize = 13.sp, color = Sk.Muted)
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                WhaleImage(WhalePose.LAZY, size = 84.dp, ring = 5.dp)
                val bubble = RoundedCornerShape(18.dp)
                Text(
                    receipt.summary,
                    Modifier.weight(1f).background(Sk.Card, bubble).border(1.dp, Sk.FieldLine, bubble).padding(horizontal = 14.dp, vertical = 12.dp),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 24.sp,
                    color = Sk.Ink,
                )
            }

            if (receipt.files.isNotEmpty()) {
                SkCard(padding = PaddingValues(horizontal = 16.dp, vertical = 14.dp), gap = 8.dp) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("改了 ${receipt.files.size} 个文件", Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Sk.Ink)
                        Text("看改动", Modifier.clickable(onClick = onOpenDiff).padding(4.dp), fontSize = 13.sp, color = Sk.BlueInk)
                    }
                    receipt.files.forEach { FileRow(it) }
                }
            }

            ResultSection("你拍板的事", receipt.approved, Sk.Ok2)
            ResultSection("被拦下的事", receipt.blocked, Sk.Warn)

            if (receipt.decisions.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SectionLabel("本鲸自己做的决定")
                    SkCard(radius = 16.dp, padding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), gap = 6.dp) {
                        receipt.decisions.forEach { Text(it, fontSize = 14.sp, lineHeight = 21.sp, color = Sk.Ink) }
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SecondaryPill("撤销这一轮", { confirm = true }, Modifier.fillMaxWidth(), minHeight = 50.dp, weight = FontWeight.Medium)
            Text("已推送的提交和命令做过的事撤不回", fontSize = 12.sp, color = Sk.Muted)
        }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            containerColor = Sk.Card,
            title = { Text("撤销这一轮？", color = Sk.Ink) },
            text = { Text("改过的文件回到修改前。已推送的提交和命令做过的事撤不回。", color = Sk.Ink2) },
            confirmButton = { TextButton(onClick = { confirm = false; onUndo() }) { Text("撤销", color = Sk.Warn) } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("再想想", color = Sk.Muted) } },
        )
    }
}

@Composable
private fun FileRow(f: FileChange) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(f.badge, fontSize = 13.sp, fontFamily = Sk.Mono, fontWeight = FontWeight.Medium, color = if (f.kind == ChangeKind.ADDED) Sk.Ok2 else if (f.kind == ChangeKind.DELETED) Sk.Warn else Sk.BlueInk)
        Text(f.path, Modifier.weight(1f), fontSize = 13.sp, fontFamily = Sk.Mono, color = Sk.Ink, maxLines = 1)
        val counts = listOfNotNull(f.added?.let { "+$it" }, f.removed?.takeIf { it > 0 }?.let { "−$it" }).joinToString(" ")
        if (counts.isNotEmpty()) Text(counts, fontSize = 13.sp, fontFamily = Sk.Mono, color = Sk.Muted)
    }
}

/** 「命令：说明」一条一行，命令用等宽字，说明靠右上色。 */
@Composable
private fun ResultSection(title: String, items: List<String>, color: Color) {
    if (items.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel("$title · ${items.size}")
        items.forEach { line ->
            val (what, note) = line.split("：", ":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            SkCard(radius = 16.dp, padding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(what.trim(), Modifier.weight(1f), fontSize = 14.sp, fontFamily = Sk.Mono, color = Sk.Ink)
                    if (note.isNotBlank()) Text(note.trim(), fontSize = 14.sp, color = color)
                }
            }
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun ReceiptPreview() {
    SikeoopTheme { ReceiptScreen(FakeLink().state.value.receipts.first(), {}, {}) }
}
