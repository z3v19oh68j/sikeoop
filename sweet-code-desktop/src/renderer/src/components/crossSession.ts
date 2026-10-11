import type { CrossSessionApi } from "@shared/types";

// 类型都在 @shared/types（规格 docs/cross-session-spec.md）；这里原样转出，面板和对话框从这里拿。
export type { CrossSession, CrossSessionState, SessionAgent, SessionAgentStatus, SessionResult, TimelineEvent, TimelineEventKind } from "@shared/types";

/** preload 把它挂在 window.sweet.session 上；老版本的壳没有它时返回 undefined。 */
export function sessionApi(): CrossSessionApi | undefined {
  return (window as unknown as { sweet?: { session?: CrossSessionApi } }).sweet?.session;
}

/**
 * 面板标签的 id，用 cs: 开头，不会和终端的 t1、t2… 冲突。只在界面里用，不发给主进程；
 * 成员自己的终端在主进程里是另一套 id：s:<sessionId>:<agentId>（SessionAgent.tab）。
 */
export const sessionTabId = (id: string) => `cs:${id}`;

export const MAX_SESSION_AGENTS = 4;
export const MIN_SESSION_ROOTS = 2;
export const SCOPE_NOTE = "Codex 只限制写入，读越界与写冲突为事后检测；这是规则限制而非系统沙盒。";
