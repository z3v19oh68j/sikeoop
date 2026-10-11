package com.sikeoop.mobile.link

import com.sikeoop.mobile.core.LinkStore
import com.sikeoop.mobile.core.RelaySession
import com.sikeoop.mobile.core.crypto.DeviceIdentity
import com.sikeoop.mobile.core.crypto.MobileCrypto
import com.sikeoop.mobile.core.crypto.PairedComputer
import com.sikeoop.mobile.core.crypto.PairingQr
import com.sikeoop.mobile.core.crypto.computer
import com.sikeoop.mobile.core.long
import com.sikeoop.mobile.core.model.AgentInfo
import com.sikeoop.mobile.core.model.ApprovalItem
import com.sikeoop.mobile.core.model.ChangeKind
import com.sikeoop.mobile.core.model.FileChange
import com.sikeoop.mobile.core.model.LinkState
import com.sikeoop.mobile.core.model.PairingPhase
import com.sikeoop.mobile.core.model.PlanStep
import com.sikeoop.mobile.core.model.Receipt
import com.sikeoop.mobile.core.model.StepState
import com.sikeoop.mobile.core.model.TaskSnapshot
import com.sikeoop.mobile.core.model.WhaleStatus
import com.sikeoop.mobile.core.str
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

/**
 * 真正的连接：通过中继遥控电脑上的 sikeoop（RelaySession 管加密和握手，这里管业务）。
 * 配对过就一直尝试连着；断了按 1、2、5、10、30 秒退避重连。电脑推来的状态和事件翻译成 [LinkState]。
 */
class RelayLink(
    private val store: LinkStore,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val appVersion: String,
) : LinkClient {

    private val _state = MutableStateFlow(LinkState())
    override val state: StateFlow<LinkState> = _state.asStateFlow()

    private val identity: DeviceIdentity by lazy { store.identity(deviceName) }
    private var computer: PairedComputer? = store.computer()
    @Volatile private var session: RelaySession? = null
    private var loop: Job? = null
    private var wake: Job? = null
    private var refreshJob: Job? = null
    private val receipts = ArrayList<Receipt>()

    init {
        computer?.let {
            _state.update { s -> s.copy(paired = true, computerName = it.computerName) }
            startLoop()
        }
    }

    // ---- connection ----

    private fun startLoop() {
        loop?.cancel()
        loop = scope.launch {
            var attempt = 0
            while (true) {
                val c = computer ?: return@launch
                val s = RelaySession(http)
                session = s
                val closed = launch(start = CoroutineStart.UNDISPATCHED) { s.events.filterIsInstance<RelaySession.Event.Closed>().first() }
                val events = launch(start = CoroutineStart.UNDISPATCHED) { s.events.collect { onEvent(it) } }
                try {
                    s.open(c, identity)
                    attempt = 0
                    _state.update { it.copy(online = true, lastSeen = "现在") }
                    afterConnect(s)
                    closed.join()
                } catch (e: Exception) {
                    s.close(e.message ?: "连不上")
                }
                events.cancel()
                closed.cancel()
                if (session === s) session = null
                _state.update { it.copy(online = false, status = WhaleStatus.OFFLINE, lastSeen = it.lastSeen.takeIf { l -> l != "现在" } ?: clock(System.currentTimeMillis())) }
                val wait = BACKOFF[minOf(attempt++, BACKOFF.lastIndex)]
                // reconnect() 叫醒这里，不用等完退避
                wake = launch { delay(wait) }
                wake?.join()
            }
        }
    }

    override fun reconnect() {
        if (computer == null) return
        if (loop?.isActive != true) startLoop() else wake?.cancel()
    }

    private suspend fun afterConnect(s: RelaySession) {
        s.call(
            "initialize",
            buildJsonObject {
                put("protocolVersion", 1)
                put(
                    "device",
                    buildJsonObject {
                        put("id", identity.deviceId)
                        put("name", identity.deviceName)
                        put("platform", "android")
                        put("appVersion", appVersion)
                        put("signingPublicKey", MobileCrypto.encodeBase64Url(identity.signing.publicSpki))
                        put("staticDhPublicKey", MobileCrypto.encodeBase64Url(identity.staticDh.publicSpki))
                    },
                )
                put("capabilities", buildJsonArray { })
            },
        )
        refresh(s)
    }

    private fun onEvent(e: RelaySession.Event) {
        if (e !is RelaySession.Event.Notification) return
        when (e.method) {
            "mobile.status" -> (e.params as? JsonObject)?.let { applyView(it) }
            "mobile.event" -> {
                val type = (e.params as? JsonObject)?.get("event").str("type")
                if (type in REFRESH_ON) scheduleRefresh()
            }
        }
    }

    private fun scheduleRefresh() {
        if (refreshJob?.isActive == true) return
        refreshJob = scope.launch {
            delay(300)
            session?.let { runCatching { refresh(it) } }
        }
    }

    /** 拉一次完整快照：状态、计划、待审批，再加终端里的小伙伴和最新回执的改动文件。 */
    private suspend fun refresh(s: RelaySession) {
        val snap = s.call("session.snapshot", buildJsonObject { put("messageLimit", 20) }) as? JsonObject ?: return
        val agents = runCatching { s.call("agents.list") as? JsonObject }.getOrNull()
            ?.get("sessions").arr().map { AgentInfo(it.str("name") ?: "AI", it.str("status") == "working") }
        (snap["view"] as? JsonObject)?.let { applyView(it, agents) }
        val project = (snap["view"] as? JsonObject)?.get("project").str("name") ?: ""
        val now = System.currentTimeMillis()
        val approvals = snap["approvals"].arr().mapNotNull { a ->
            val st = a.str("status") ?: "pending"
            if (st == "approved" || st == "rejected") return@mapNotNull null
            ApprovalItem(
                id = a.str("id") ?: return@mapNotNull null,
                from = if (a.str("source") == "terminal") "终端里的 AI" else "本鲸",
                title = a.str("title") ?: "要你拍板",
                detail = a.str("detail") ?: "",
                where = project,
                secondsLeft = (((a.long("deadlineAt") ?: now) - now) / 1000).coerceAtLeast(0).toInt(),
                humanOnly = (a as? JsonObject)?.get("humanOnly")?.let { (it as? JsonPrimitive)?.booleanOrNull } == true,
                handledReason = when (st) {
                    "expired" -> "已超时，回电脑上问"
                    "handled_elsewhere" -> a.str("statusReason") ?: "已在电脑上处理"
                    else -> null
                },
            )
        }
        _state.update { it.copy(approvals = approvals) }
        loadReceipt(s, snap["view"] as? JsonObject)
    }

    private fun applyView(v: JsonObject, agents: List<AgentInfo>? = null) {
        val status = when (v.str("status")) {
            "working" -> WhaleStatus.WORKING
            "waiting" -> WhaleStatus.WAITING
            "done" -> WhaleStatus.DONE
            "error" -> WhaleStatus.ERROR
            "incomplete" -> WhaleStatus.HALTED
            else -> WhaleStatus.IDLE
        }
        val turn = v["turn"] as? JsonObject
        _state.update { s ->
            s.copy(
                online = true,
                status = status,
                computerName = v["computer"].str("name") ?: s.computerName,
                project = v["project"].str("name") ?: "",
                lastSeen = "现在",
                task = turn?.let { t ->
                    TaskSnapshot(
                        instruction = t.str("prompt") ?: "",
                        plan = t["plan"].arr().map { p ->
                            PlanStep(
                                p.str("text") ?: "",
                                when (p.str("status")) {
                                    "done" -> StepState.DONE
                                    "in_progress" -> StepState.IN_PROGRESS
                                    "skipped" -> StepState.SKIPPED
                                    else -> StepState.PENDING
                                },
                            )
                        },
                        current = t.str("currentActivity") ?: if (status == WhaleStatus.WORKING) "在想下一步" else "",
                        agents = agents ?: s.task?.agents.orEmpty(),
                    )
                } ?: s.task?.takeIf { status == WhaleStatus.WORKING },
            )
        }
    }

    /** 最新回执：电脑只给一句话和改了几个文件，文件明细用 diff.get 补上（每轮只拉一次）。 */
    private suspend fun loadReceipt(s: RelaySession, view: JsonObject?) {
        val r = view?.get("lastReceipt") as? JsonObject ?: return
        val turnId = r.long("turnId") ?: return
        val id = "turn-$turnId"
        if (receipts.any { it.id == id }) return
        val files = runCatching { s.call("diff.get", buildJsonObject { put("turnId", turnId) }) as? JsonObject }.getOrNull()
            ?.get("files").arr().map { f ->
                val diff = f.str("unifiedDiff") ?: ""
                val lines = diff.lineSequence()
                val added = lines.count { it.startsWith("+") && !it.startsWith("+++") }
                val removed = diff.lineSequence().count { it.startsWith("-") && !it.startsWith("---") }
                val before = (f as? JsonObject)?.get("before")
                val after = (f as? JsonObject)?.get("after")
                FileChange(
                    path = f.str("path") ?: "",
                    kind = when {
                        before == null || before is kotlinx.serialization.json.JsonNull -> ChangeKind.ADDED
                        after == null || after is kotlinx.serialization.json.JsonNull -> ChangeKind.DELETED
                        else -> ChangeKind.MODIFIED
                    },
                    added = added,
                    removed = removed,
                )
            }.orEmpty()
        val summary = r.str("summary")?.trim().orEmpty()
        receipts.add(
            0,
            Receipt(
                id = id,
                time = clock(r.long("completedAt")?.takeIf { it > 0 } ?: System.currentTimeMillis()),
                title = summary.lineSequence().firstOrNull()?.take(16)?.ifBlank { null } ?: "第 $turnId 轮",
                summary = summary.ifBlank { "做完了。" },
                files = files,
            ),
        )
        while (receipts.size > 20) receipts.removeAt(receipts.lastIndex)
        _state.update { it.copy(receipts = receipts.toList()) }
    }

    // ---- pairing ----

    override fun pair(code: String) {
        val qr = try {
            PairingQr.parse(code)
        } catch (e: Exception) {
            _state.update { it.copy(pairing = PairingPhase.FAILED, pairingError = e.message) }
            return
        }
        _state.update { it.copy(pairing = PairingPhase.CONNECTING, pairingError = null, computerName = qr.computerName) }
        loop?.cancel()
        session?.close("换了一台电脑")
        scope.launch {
            val s = RelaySession(http)
            val verdict = CompletableDeferred<String>()
            // 订阅要在连上之前：「等确认」的通知紧跟在握手后面到。
            val watch = launch(start = CoroutineStart.UNDISPATCHED) {
                s.events.collect { e ->
                    when {
                        e is RelaySession.Event.Closed -> verdict.complete("closed:${e.reason}")
                        e is RelaySession.Event.Notification && e.method == "mobile.pairing" -> when (val st = e.params.str("status")) {
                            "pending" -> _state.update { it.copy(pairing = PairingPhase.WAITING_APPROVAL) }
                            "approved", "rejected" -> verdict.complete(st)
                        }
                    }
                }
            }
            try {
                s.open(qr.computer(), identity, qr)
                when (val result = withTimeoutOrNull(APPROVAL_WAIT_MS) { verdict.await() }) {
                    "approved" -> {
                        computer = qr.computer()
                        store.saveComputer(qr.computer())
                        watch.cancel()
                        s.close("配对完成")
                        _state.update { it.copy(paired = true, pairing = PairingPhase.APPROVED, pairingError = null) }
                        startLoop()
                    }
                    "rejected" -> fail(s, "电脑上拒绝了这台手机")
                    null -> fail(s, "电脑上一直没点「允许」，请重新扫码")
                    else -> fail(s, result.removePrefix("closed:"))
                }
            } catch (e: Exception) {
                fail(s, e.message ?: "配对失败")
            } finally {
                watch.cancel()
            }
        }
    }

    private fun fail(s: RelaySession, reason: String) {
        s.close(reason)
        _state.update { it.copy(pairing = PairingPhase.FAILED, pairingError = reason) }
        if (computer != null) startLoop()
    }

    override fun unpair() {
        loop?.cancel()
        session?.close("已忘掉这台电脑")
        session = null
        computer = null
        store.forgetComputer()
        receipts.clear()
        _state.value = LinkState()
    }

    // ---- actions ----

    private fun act(block: suspend (RelaySession) -> Unit) {
        val s = session
        if (s == null || !_state.value.online) {
            _state.update { it.copy(notice = "电脑不在线") }
            return
        }
        scope.launch {
            try {
                block(s)
            } catch (e: RelaySession.RpcException) {
                _state.update {
                    it.copy(
                        notice = when (e.code) {
                            -32001 -> "电脑那边还在忙上一件事，等它做完再派"
                            -32006 -> "等电脑上点「允许」"
                            -32005 -> "这件事已经处理过了"
                            else -> e.message
                        },
                    )
                }
                runCatching { refresh(s) }
            } catch (e: Exception) {
                _state.update { it.copy(notice = e.message ?: "没发出去") }
            }
        }
    }

    override fun send(text: String) = act { s ->
        s.call("chat.send", buildJsonObject { put("requestId", UUID.randomUUID().toString()); put("text", text); put("mode", "lazy") })
        _state.update { it.copy(status = WhaleStatus.WORKING) }
    }

    override fun cancel() = act { s -> s.call("chat.cancel", buildJsonObject { put("requestId", UUID.randomUUID().toString()) }) }

    override fun respondApproval(id: String, allow: Boolean) = act { s ->
        s.call("approval.respond", buildJsonObject { put("id", id); put("approved", allow) })
        _state.update { st -> st.copy(approvals = st.approvals.filterNot { it.id == id }) }
        refresh(s)
    }

    override fun undoTurn(receiptId: String) = act { s ->
        val turnId = receiptId.removePrefix("turn-").toLongOrNull() ?: return@act
        s.call("turn.undo", buildJsonObject { put("turnId", turnId) })
        receipts.removeAll { it.id == receiptId }
        _state.update { it.copy(receipts = receipts.toList(), notice = "已撤销这一轮") }
        refresh(s)
    }

    override fun clearNotice() {
        _state.update { it.copy(notice = null) }
    }

    private companion object {
        val BACKOFF = longArrayOf(1_000, 2_000, 5_000, 10_000, 30_000)
        const val APPROVAL_WAIT_MS = 5 * 60_000L + 10_000L
        /** 这些事件之后重新拉快照：审批、提问、一轮结束都会改首页和待办。 */
        val REFRESH_ON = setOf("approval_request", "approval_result", "question", "question_answered", "turn_changes", "done", "error", "plan")

        fun clock(ms: Long): String = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(ms))
    }
}

private fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray)?.toList().orEmpty()
