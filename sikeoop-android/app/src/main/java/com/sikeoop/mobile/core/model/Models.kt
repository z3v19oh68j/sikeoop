package com.sikeoop.mobile.core.model

/** 鲸鱼娘的七种表现，对应 PRD 的状态表。 */
enum class WhaleStatus {
    IDLE,       // 空闲
    WORKING,    // 干活
    WAITING,    // 等你
    DONE,       // 做完
    ERROR,      // 出错（含被拒答）
    HALTED,     // 没做完（步数用完、已停下）
    OFFLINE     // 电脑不在线
}

/** 状态旁边那句嘴毒的话，只出现在 App 里，通知栏不用。 */
val WhaleStatus.speech: String
    get() = when (this) {
        WhaleStatus.IDLE -> "没活干，快派~"
        WhaleStatus.WORKING -> "本鲸在干活，别吵~"
        WhaleStatus.WAITING -> "有事要你拍板"
        WhaleStatus.DONE -> "做完了，来夸本鲸~"
        WhaleStatus.ERROR -> "出岔子了"
        WhaleStatus.HALTED -> "还没做完"
        WhaleStatus.OFFLINE -> "电脑睡着了"
    }

val WhaleStatus.label: String
    get() = when (this) {
        WhaleStatus.IDLE -> "空闲"
        WhaleStatus.WORKING -> "干活"
        WhaleStatus.WAITING -> "等你"
        WhaleStatus.DONE -> "做完"
        WhaleStatus.ERROR -> "出错"
        WhaleStatus.HALTED -> "没做完"
        WhaleStatus.OFFLINE -> "电脑不在线"
    }

/** 计划步骤的四种状态，和桌面版的 pending / in_progress / done / skipped 对应。 */
enum class StepState { PENDING, IN_PROGRESS, DONE, SKIPPED }

/** needsConfirm：这一步是推送、发布这类撤不回的操作，轮到它时要你确认。 */
data class PlanStep(val title: String, val state: StepState, val needsConfirm: Boolean = false)

/** 终端里的 Claude Code / Codex。 */
data class AgentInfo(val name: String, val busy: Boolean)

data class TaskSnapshot(
    val instruction: String,
    val plan: List<PlanStep>,
    val current: String,
    val agents: List<AgentInfo>,
)

/**
 * 一张要你拍板的卡：AI 的审批、AI 的提问、终端 AI 的权限请求，
 * 以及推送、发布这类撤不回的操作（humanOnly）。
 */
data class ApprovalItem(
    val id: String,
    val from: String,
    val title: String,
    val detail: String,
    val where: String,
    val secondsLeft: Int,
    val humanOnly: Boolean = false,
    /** 非空 = 已经在电脑或微信上处理过，卡片置灰并写明原因。 */
    val handledReason: String? = null,
)

enum class ChangeKind { MODIFIED, ADDED, DELETED }

/** added / removed：增删的行数，电脑没给时为 null。 */
data class FileChange(val path: String, val kind: ChangeKind, val added: Int? = null, val removed: Int? = null) {
    val badge: String
        get() = when (kind) {
            ChangeKind.MODIFIED -> "M"
            ChangeKind.ADDED -> "A"
            ChangeKind.DELETED -> "D"
        }
}

/** 一张回执：做完之后说人话的那一页。 */
data class Receipt(
    val id: String,
    val time: String,
    val title: String,
    val summary: String,
    val files: List<FileChange> = emptyList(),
    /** 你拍板同意过的事，各写结果（「命令：结果」）。 */
    val approved: List<String> = emptyList(),
    /** 被懒人模式拦下的事，各写原因（「命令：原因」）。 */
    val blocked: List<String> = emptyList(),
    /** 本鲸自己做的决定。 */
    val decisions: List<String> = emptyList(),
)

/** 扫码配对走到哪一步了。 */
enum class PairingPhase { NONE, CONNECTING, WAITING_APPROVAL, APPROVED, FAILED }

/** 界面要显示的一切。连接层更新它，界面照着画。 */
data class LinkState(
    /** 已经和一台电脑配对过（重启 App 后会自动连回去）。 */
    val paired: Boolean = false,
    val pairing: PairingPhase = PairingPhase.NONE,
    /** 配对失败的原因，给人看。 */
    val pairingError: String? = null,
    /** 一句临时提示，比如「电脑那边还在忙上一件事」。 */
    val notice: String? = null,
    val online: Boolean = false,
    val computerName: String = "我的 MacBook",
    val project: String = "",
    val mode: String = "懒人",
    val status: WhaleStatus = WhaleStatus.OFFLINE,
    val lastSeen: String = "",
    val task: TaskSnapshot? = null,
    val approvals: List<ApprovalItem> = emptyList(),
    val receipts: List<Receipt> = emptyList(),
)
