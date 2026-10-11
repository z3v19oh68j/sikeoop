import type {
  InitializeParams,
  InitializeResult,
  MobileRequest,
  MobileResultMap,
  MobileServerNotification,
  RpcFailure,
  RpcSuccess,
  SessionSnapshot,
} from "../sweet-code-desktop/src/shared/protocol";

export interface ProtocolFixture {
  name: string;
  frame: MobileRequest | RpcSuccess | RpcFailure | MobileServerNotification;
}

const onlineView = {
  status: "idle",
  presence: { online: true, lastSeenAt: 1_791_567_000_000 },
  computer: { id: "desktop-01", name: "MacBook" },
  project: { name: "shop-web", path: "/work/shop-web" },
  pendingApprovals: 0,
  lastReceipt: { turnId: 40, summary: "登录接口已修复。", changedFiles: 2, completedAt: 1_791_567_000_000 },
} as const;

const initParams: InitializeParams = {
  protocolVersion: 1,
  device: { id: "phone-01", name: "Pixel 9", platform: "android", appVersion: "0.1.0", signingPublicKey: "MCowBQY...", staticDhPublicKey: "MCowBQY..." },
  capabilities: ["snapshot", "notifications", "secure-approval"],
};

const initResult: InitializeResult = {
  protocolVersion: 1,
  computer: { id: "desktop-01", name: "MacBook" },
  capabilities: ["snapshot", "chat", "approval", "undo", "diff", "agents"],
  presence: { online: true, since: 1_791_567_000_000 },
};

const snapshot: SessionSnapshot = {
  cursor: 17,
  view: onlineView,
  messages: [{ id: "msg-40", role: "user", text: "修复登录接口", createdAt: 1_791_567_000_000, source: { kind: "mobile", deviceName: "Pixel 9" } }],
  events: [{ cursor: 17, event: { type: "status", state: "idle" } }],
  approvals: [],
  questions: [],
};

const approval = {
  id: "approval-55",
  source: "agent" as const,
  title: "需要确认撤不回的操作",
  detail: "准备推送代码",
  createdAt: 1_791_567_000_000,
  deadlineAt: 1_791_567_600_000,
  humanOnly: true,
  status: "pending" as const,
};

export const protocolFixtures = [
  { name: "initialize.request", frame: { jsonrpc: "2.0", id: "1", method: "initialize", params: initParams } satisfies MobileRequest },
  { name: "initialize.response", frame: { jsonrpc: "2.0", id: "1", result: initResult } satisfies RpcSuccess<InitializeResult> },
  { name: "session.snapshot.request", frame: { jsonrpc: "2.0", id: "2", method: "session.snapshot", params: { afterCursor: 4, messageLimit: 50 } } satisfies MobileRequest },
  { name: "session.snapshot.response", frame: { jsonrpc: "2.0", id: "2", result: snapshot } satisfies RpcSuccess<SessionSnapshot> },
  { name: "chat.send.request", frame: { jsonrpc: "2.0", id: "3", method: "chat.send", params: { requestId: "req-1", text: "修复登录接口", mode: "lazy" } } satisfies MobileRequest },
  { name: "chat.send.response", frame: { jsonrpc: "2.0", id: "3", result: { accepted: true, requestId: "req-1", turnId: 41 } satisfies MobileResultMap["chat.send"] } satisfies RpcSuccess<MobileResultMap["chat.send"]> },
  { name: "chat.cancel.request", frame: { jsonrpc: "2.0", id: "4", method: "chat.cancel", params: { requestId: "req-1" } } satisfies MobileRequest },
  { name: "chat.cancel.response", frame: { jsonrpc: "2.0", id: "4", result: { accepted: true } satisfies MobileResultMap["chat.cancel"] } satisfies RpcSuccess<MobileResultMap["chat.cancel"]> },
  { name: "approval.respond.request", frame: { jsonrpc: "2.0", id: "5", method: "approval.respond", params: { id: approval.id, approved: true } } satisfies MobileRequest },
  { name: "approval.respond.response", frame: { jsonrpc: "2.0", id: "5", result: { accepted: true, id: approval.id, status: "approved" } satisfies MobileResultMap["approval.respond"] } satisfies RpcSuccess<MobileResultMap["approval.respond"]> },
  { name: "question.answer.request", frame: { jsonrpc: "2.0", id: "6", method: "question.answer", params: { id: "question-1", answers: [{ id: "q1", choices: ["推荐"] }], usedDefaults: false } } satisfies MobileRequest },
  { name: "question.answer.response", frame: { jsonrpc: "2.0", id: "6", result: { accepted: true, id: "question-1" } satisfies MobileResultMap["question.answer"] } satisfies RpcSuccess<MobileResultMap["question.answer"]> },
  { name: "turn.undo.request", frame: { jsonrpc: "2.0", id: "7", method: "turn.undo", params: { turnId: 41 } } satisfies MobileRequest },
  { name: "turn.undo.response", frame: { jsonrpc: "2.0", id: "7", result: { turnId: 41, result: { restored: ["src/auth.ts"], skipped: [] } } satisfies MobileResultMap["turn.undo"] } satisfies RpcSuccess<MobileResultMap["turn.undo"]> },
  { name: "diff.get.request", frame: { jsonrpc: "2.0", id: "8", method: "diff.get", params: { turnId: 41 } } satisfies MobileRequest },
  { name: "diff.get.response", frame: { jsonrpc: "2.0", id: "8", result: { turnId: 41, files: [{ path: "src/auth.ts", before: "a", after: "b", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" }] } satisfies MobileResultMap["diff.get"] } satisfies RpcSuccess<MobileResultMap["diff.get"]> },
  { name: "agents.list.request", frame: { jsonrpc: "2.0", id: "9", method: "agents.list", params: {} } satisfies MobileRequest },
  { name: "agents.list.response", frame: { jsonrpc: "2.0", id: "9", result: { sessions: [], pending: [] } satisfies MobileResultMap["agents.list"] } satisfies RpcSuccess<MobileResultMap["agents.list"]> },
  { name: "agents.respond.request", frame: { jsonrpc: "2.0", id: "10", method: "agents.respond", params: { sessionId: "cli-1", requestId: "perm-1", approved: false, feedback: "稍后再运行" } } satisfies MobileRequest },
  { name: "agents.respond.response", frame: { jsonrpc: "2.0", id: "10", result: { accepted: true, requestId: "perm-1" } satisfies MobileResultMap["agents.respond"] } satisfies RpcSuccess<MobileResultMap["agents.respond"]> },
  { name: "busy.error", frame: { jsonrpc: "2.0", id: "11", error: { code: -32001, message: "BUSY", data: { activity: "正在运行测试" } } } satisfies RpcFailure },
  { name: "mobile.event.notification", frame: { jsonrpc: "2.0", method: "mobile.event", params: { cursor: 18, event: { type: "remote_message", text: "修复登录接口", from: "mobile", deviceName: "Pixel 9" } } } satisfies MobileServerNotification },
  { name: "mobile.status.notification", frame: { jsonrpc: "2.0", method: "mobile.status", params: onlineView } satisfies MobileServerNotification },
  { name: "mobile.ask.notification", frame: { jsonrpc: "2.0", method: "mobile.ask", params: { approval } } satisfies MobileServerNotification },
  { name: "mobile.presence.notification", frame: { jsonrpc: "2.0", method: "mobile.presence", params: { online: false, lastSeenAt: 1_791_567_000_000 } } satisfies MobileServerNotification },
  { name: "mobile.log.notification", frame: { jsonrpc: "2.0", method: "mobile.log", params: { level: "warn", message: "连接断开", at: 1_791_567_000_000 } } satisfies MobileServerNotification },
] satisfies ProtocolFixture[];
