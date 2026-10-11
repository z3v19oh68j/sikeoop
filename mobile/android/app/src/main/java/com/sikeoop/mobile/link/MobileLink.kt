package com.sikeoop.mobile.link

import kotlinx.coroutines.flow.StateFlow

enum class WhaleStatus { IDLE, WORKING, WAITING, DONE, ERROR, INCOMPLETE }

data class PlanStep(val text: String, val status: String)
data class ComputerPresence(val online: Boolean, val lastSeenAt: Long?)
data class MobileHomeView(
    val status: WhaleStatus,
    val presence: ComputerPresence,
    val computerName: String,
    val projectName: String?,
    val currentActivity: String?,
    val plan: List<PlanStep>,
    val pendingApprovals: Int,
    val lastReceipt: String?,
)

sealed interface MobileLinkState {
    data object Unpaired : MobileLinkState
    data class Connecting(val computerName: String?) : MobileLinkState
    data class Online(val view: MobileHomeView) : MobileLinkState
    data class Offline(val computerName: String, val lastSeenAt: Long?) : MobileLinkState
    data class Failed(val reason: String) : MobileLinkState
}

/** UI-facing contract. Transport and key storage stay below this boundary in `core`. */
interface MobileLink {
    val state: StateFlow<MobileLinkState>

    suspend fun pair(qrPayload: String)
    suspend fun reconnect()
    suspend fun refreshSnapshot()
    suspend fun sendMessage(text: String)
    suspend fun cancelTurn()
    suspend fun respondToApproval(id: String, approved: Boolean, feedback: String? = null)
    suspend fun answerQuestion(id: String, answers: List<QuestionAnswer>, usedDefaults: Boolean)
    suspend fun undoTurn(turnId: Long)
    suspend fun fetchDiff(turnId: Long): List<DiffItem>
    suspend fun removePairedComputer()
}

data class QuestionAnswer(val id: String, val choices: List<String>, val other: String? = null)
data class DiffItem(val path: String, val unifiedDiff: String)
