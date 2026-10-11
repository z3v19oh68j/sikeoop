package com.sikeoop.mobile.link

import com.sikeoop.mobile.core.model.AgentInfo
import com.sikeoop.mobile.core.model.ApprovalItem
import com.sikeoop.mobile.core.model.ChangeKind
import com.sikeoop.mobile.core.model.FileChange
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.core.model.PlanStep
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.core.model.StepState
import com.sikeoop.mobile.core.model.TaskSnapshot
import com.sikeoop.mobile.core.model.WhaleStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 假数据源：中继还没接上之前，让界面先跑起来。
 * 点按钮会真的改状态——派活转圈、停下、审批消失，方便调界面。
 */
class FakeLink : LinkClient {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(sample())
    override val state: StateFlow<LinkState> = _state.asStateFlow()

    override fun send(text: String) {
        _state.update {
            it.copy(
                online = true,
                status = WhaleStatus.WORKING,
                task = TaskSnapshot(
                    instruction = text,
                    plan = samplePlan(),
                    current = "读相关代码",
                    agents = listOf(AgentInfo("Claude-1", busy = true), AgentInfo("Codex-1", busy = false)),
                ),
            )
        }
        scope.launch {
            delay(2500)
            _state.update { s ->
                s.copy(
                    status = WhaleStatus.DONE,
                    task = s.task?.copy(current = "都做完了"),
                    receipts = listOf(
                        Receipt(
                            id = "r-${System.currentTimeMillis()}",
                            time = "刚刚",
                            title = text.take(12),
                            summary = "修好了，来看看。",
                            files = listOf(
                                FileChange("src/api/login.ts", ChangeKind.MODIFIED),
                                FileChange("tests/login.test.ts", ChangeKind.ADDED),
                            ),
                            blocked = listOf("git push：要你亲自发"),
                            decisions = listOf("用了现有 jest，没装新库"),
                        ),
                    ) + s.receipts,
                )
            }
        }
    }

    override fun cancel() {
        _state.update { it.copy(status = WhaleStatus.HALTED, task = it.task?.copy(current = "已停下")) }
    }

    override fun respondApproval(id: String, allow: Boolean) {
        _state.update { s ->
            val left = s.approvals.filterNot { it.id == id }
            s.copy(approvals = left, status = if (left.isEmpty() && s.status == WhaleStatus.WAITING) WhaleStatus.WORKING else s.status)
        }
    }

    override fun undoTurn(receiptId: String) {
        _state.update { s -> s.copy(receipts = s.receipts.filterNot { it.id == receiptId }, status = WhaleStatus.IDLE) }
    }

    override fun pair(code: String) {
        _state.update { it.copy(paired = true, pairing = com.sikeoop.mobile.core.model.PairingPhase.APPROVED, online = true, status = WhaleStatus.IDLE) }
    }

    override fun unpair() {
        _state.update { it.copy(paired = false, pairing = com.sikeoop.mobile.core.model.PairingPhase.NONE, online = false, status = WhaleStatus.OFFLINE) }
    }

    override fun reconnect() {
        _state.update {
            it.copy(online = true, status = WhaleStatus.IDLE, project = "shop-web", lastSeen = "现在")
        }
    }

    private fun samplePlan() = listOf(
        PlanStep("读登录相关代码", StepState.DONE),
        PlanStep("复现报错", StepState.DONE),
        PlanStep("修配置加载顺序", StepState.IN_PROGRESS),
        PlanStep("跑测试", StepState.PENDING),
        PlanStep("推送到远程", StepState.PENDING, needsConfirm = true),
        PlanStep("更新 README", StepState.SKIPPED),
    )

    private fun sample() = LinkState(
        paired = true,
        online = true,
        computerName = "我的 MacBook",
        project = "shop-web",
        mode = "懒人",
        status = WhaleStatus.WORKING,
        task = TaskSnapshot(
            instruction = "帮我修登录接口 500",
            plan = samplePlan(),
            current = "$ npm test · 12s",
            agents = listOf(AgentInfo("Claude-1", busy = true), AgentInfo("Codex-1", busy = false)),
        ),
        approvals = listOf(
            ApprovalItem(
                id = "a1",
                from = "Claude-1",
                title = "想运行命令",
                detail = "npm install express",
                where = "shop-web",
                secondsLeft = 92,
            ),
            ApprovalItem(
                id = "a2",
                from = "本鲸",
                title = "想推送到 origin/main",
                detail = "3 个提交",
                where = "shop-web",
                secondsLeft = 552,
                humanOnly = true,
            ),
            ApprovalItem(
                id = "a3",
                from = "Codex-1",
                title = "想改文件",
                detail = "src/config.ts",
                where = "shop-web",
                secondsLeft = 0,
                handledReason = "已回电脑上询问",
            ),
        ),
        receipts = listOf(
            Receipt(
                id = "r1",
                time = "14:20",
                title = "修登录 500",
                summary = "修好了，登录不再 500。",
                files = listOf(
                    FileChange("src/api/login.ts", ChangeKind.MODIFIED, added = 12, removed = 4),
                    FileChange("src/config.ts", ChangeKind.MODIFIED, added = 3, removed = 3),
                    FileChange("tests/login.test.ts", ChangeKind.ADDED, added = 41),
                ),
                approved = listOf("git push：你同意了，已推送"),
                blocked = listOf("sudo npm i -g：要你自己来"),
                decisions = listOf("用了现有 jest，没装新库"),
            ),
            Receipt(
                id = "r2",
                time = "昨天",
                title = "加深色模式",
                summary = "加好了，设置里能切。",
                files = listOf(FileChange("src/theme.css", ChangeKind.ADDED)),
            ),
        ),
    )
}
