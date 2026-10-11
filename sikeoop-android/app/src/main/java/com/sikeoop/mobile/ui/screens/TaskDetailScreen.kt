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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.core.model.PlanStep
import com.sikeoop.mobile.core.model.StepState
import com.sikeoop.mobile.link.FakeLink
import com.sikeoop.mobile.ui.components.BackHeader
import com.sikeoop.mobile.ui.components.SecondaryPill
import com.sikeoop.mobile.ui.components.SectionLabel
import com.sikeoop.mobile.ui.components.SkCard
import com.sikeoop.mobile.ui.components.SkIcon
import com.sikeoop.mobile.ui.components.SkIcons
import com.sikeoop.mobile.ui.components.Tag
import com.sikeoop.mobile.ui.theme.SikeoopTheme
import com.sikeoop.mobile.ui.theme.Sk

/** 任务详情：计划四态、现在在跑什么、终端里的小伙伴。对应设计稿 TaskDetail。 */
@Composable
fun TaskDetailScreen(state: LinkState, onBack: () -> Unit, onStop: () -> Unit, onOpenChat: () -> Unit = {}) {
    val task = state.task
    Column(Modifier.fillMaxSize().background(Sk.Bg)) {
        BackHeader("任务详情", onBack) {
            if (task != null) SecondaryPill("停下", onStop, minHeight = 40.dp, border = Sk.Accent, color = Sk.Warn, fontSize = 14, weight = FontWeight.Medium)
        }
        if (task == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("现在没有在跑的任务", fontSize = 15.sp, color = Sk.Muted)
            }
            return
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(task.instruction, fontSize = 24.sp, fontWeight = FontWeight.Bold, lineHeight = 32.sp, color = Sk.Ink)

            SkCard(gap = 0.dp, padding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp)) {
                val done = task.plan.count { it.state == StepState.DONE }
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("计划", Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Sk.Ink)
                    Text("$done / ${task.plan.size}", fontSize = 13.sp, color = Sk.Muted)
                }
                task.plan.forEach { StepRow(it) }
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("现在")
                Text(
                    task.current,
                    Modifier.fillMaxWidth().background(Sk.Ink, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
                    fontSize = 14.sp,
                    fontFamily = Sk.Mono,
                    color = Sk.Ring,
                )
            }

            if (task.agents.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("终端里的小伙伴")
                    task.agents.chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            row.forEach { a ->
                                SkCard(Modifier.weight(1f), radius = 16.dp, padding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp), gap = 4.dp) {
                                    Text(a.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, fontFamily = Sk.Mono, color = Sk.Ink)
                                    Text(if (a.busy) "● 干活中" else "○ 空闲", fontSize = 13.sp, color = if (a.busy) Sk.Warn else Sk.Muted)
                                }
                            }
                            if (row.size == 1) Box(Modifier.weight(1f))
                        }
                    }
                }
            }

            val shape = RoundedCornerShape(16.dp)
            Row(
                Modifier.fillMaxWidth().background(Sk.Card, shape).border(1.dp, Sk.CardLine, shape).clickable(onClick = onOpenChat)
                    .heightIn(min = 56.dp).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("看完整对话", Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight.Medium, color = Sk.Ink)
                SkIcon(SkIcons.Chevron, Sk.Faint, size = 18.dp)
            }
        }
    }
}

@Composable
private fun StepRow(step: PlanStep) {
    val current = step.state == StepState.IN_PROGRESS
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (current) Modifier.padding(horizontal = 0.dp).background(Sk.AccentSoft, RoundedCornerShape(12.dp)) else Modifier)
            .heightIn(min = 44.dp)
            .padding(horizontal = if (current) 10.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (step.state) {
            StepState.DONE -> Box(Modifier.size(22.dp).background(Sk.Blue, CircleShape), contentAlignment = Alignment.Center) {
                SkIcon(SkIcons.Check, androidx.compose.ui.graphics.Color.White, size = 14.dp)
            }
            StepState.IN_PROGRESS -> Box(Modifier.size(22.dp).border(2.dp, Sk.Accent, CircleShape), contentAlignment = Alignment.Center) {
                Box(Modifier.size(8.dp).background(Sk.Accent, CircleShape))
            }
            StepState.PENDING -> Box(Modifier.size(22.dp).border(2.dp, Sk.Pending, CircleShape))
            StepState.SKIPPED -> Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) { SkIcon(SkIcons.Minus, Sk.Faint, size = 16.dp) }
        }
        Text(
            step.title + if (step.state == StepState.SKIPPED) "（跳过）" else "",
            Modifier.weight(1f),
            fontSize = 15.sp,
            fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
            color = when (step.state) {
                StepState.DONE -> Sk.Muted
                StepState.SKIPPED -> Sk.Faint
                else -> Sk.Ink
            },
            textDecoration = if (step.state == StepState.SKIPPED) TextDecoration.LineThrough else null,
        )
        if (step.needsConfirm && step.state != StepState.DONE && step.state != StepState.SKIPPED) {
            Tag("要你确认", Sk.WarnSoft, Sk.Warn, fontSize = 12)
        }
    }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun TaskPreview() {
    SikeoopTheme { TaskDetailScreen(FakeLink().state.value, {}, {}) }
}
