import Foundation

/// 鲸鱼娘的七种表现，对应 PRD 的状态表。
enum WhaleStatus: Equatable {
    case idle       // 空闲
    case working    // 干活
    case waiting    // 等你
    case done       // 做完
    case error      // 出错（含被拒答）
    case halted     // 没做完（步数用完、已停下）
    case offline    // 电脑不在线

    /// 状态旁边那句嘴毒的话，只出现在 App 里，通知栏不用。
    var speech: String {
        switch self {
        case .idle: return "没活干，快派~"
        case .working: return "本鲸在干活，别吵~"
        case .waiting: return "有事要你拍板"
        case .done: return "做完了，来夸本鲸~"
        case .error: return "出岔子了"
        case .halted: return "还没做完"
        case .offline: return "电脑睡着了"
        }
    }

    var label: String {
        switch self {
        case .idle: return "空闲"
        case .working: return "干活"
        case .waiting: return "等你"
        case .done: return "做完"
        case .error: return "出错"
        case .halted: return "没做完"
        case .offline: return "电脑不在线"
        }
    }
}

/// 计划步骤的四种状态，和桌面版的 pending / in_progress / done / skipped 对应。
enum StepState: Equatable {
    case pending, inProgress, done, skipped
}

/// needsConfirm：这一步是推送、发布这类撤不回的操作，轮到它时要你确认。
struct PlanStep: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let state: StepState
    var needsConfirm: Bool = false
}

/// 终端里的 Claude Code / Codex。
struct AgentInfo: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let busy: Bool
}

struct TaskSnapshot: Equatable {
    let instruction: String
    let plan: [PlanStep]
    var current: String
    let agents: [AgentInfo]
}

/// 一张要你拍板的卡：AI 的审批、AI 的提问、终端 AI 的权限请求，
/// 以及推送、发布这类撤不回的操作（humanOnly）。
struct ApprovalItem: Identifiable, Equatable {
    let id: String
    let from: String
    let title: String
    let detail: String
    /// 位置（协议里的 where）。
    let location: String
    let secondsLeft: Int
    var humanOnly: Bool = false
    /// 非空 = 已经在电脑或微信上处理过，卡片置灰并写明原因。
    var handledReason: String? = nil
}

enum ChangeKind: Equatable {
    case modified, added, deleted
}

/// added / removed：增删的行数，电脑没给时为 nil。
struct FileChange: Identifiable, Equatable {
    let id = UUID()
    let path: String
    let kind: ChangeKind
    var added: Int? = nil
    var removed: Int? = nil

    var badge: String {
        switch kind {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        }
    }
}

/// 一张回执：做完之后说人话的那一页。
struct Receipt: Identifiable, Equatable {
    let id: String
    let time: String
    let title: String
    let summary: String
    var files: [FileChange] = []
    /// 你拍板同意过的事，各写结果（「命令：结果」）。
    var approved: [String] = []
    /// 被懒人模式拦下的事，各写原因（「命令：原因」）。
    var blocked: [String] = []
    /// 本鲸自己做的决定。
    var decisions: [String] = []
}

/// 扫码配对走到哪一步了。
enum PairingPhase: Equatable {
    case none, connecting, waitingApproval, approved, failed
}

/// 界面要显示的一切。连接层更新它，界面照着画。
struct LinkState: Equatable {
    /// 已经和一台电脑配对过（重启 App 后会自动连回去）。
    var paired: Bool = false
    var pairing: PairingPhase = .none
    /// 配对失败的原因，给人看。
    var pairingError: String? = nil
    /// 一句临时提示，比如「电脑那边还在忙上一件事」。
    var notice: String? = nil
    var online: Bool = false
    var computerName: String = "我的 MacBook"
    var project: String = ""
    var mode: String = "懒人"
    var status: WhaleStatus = .offline
    var lastSeen: String = ""
    var task: TaskSnapshot? = nil
    var approvals: [ApprovalItem] = []
    var receipts: [Receipt] = []
}
