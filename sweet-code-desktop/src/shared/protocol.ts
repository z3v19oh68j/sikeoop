/**
 * sikeoop Mobile JSON-RPC contract, version 1.
 * This file is the canonical desktop-side wire contract; the Kotlin DTOs mirror it.
 */
import type {
  AgentEvent,
  AgentSessionView,
  AskAnswer,
  AskQuestion,
  ImageInput,
  MobileView,
  PlanItem,
  UndoResult,
} from "./types";

export const MOBILE_PROTOCOL_VERSION = 1 as const;
export const MOBILE_MAX_FRAME_BYTES = 1_048_576;
export const MOBILE_METHODS = [
  "initialize",
  "session.snapshot",
  "chat.send",
  "chat.cancel",
  "approval.respond",
  "question.answer",
  "turn.undo",
  "diff.get",
  "agents.list",
  "agents.respond",
] as const;

export type RpcId = string | number;
export interface RpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params: P;
}
export interface RpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}
export interface RpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: RpcId;
  result: T;
}
export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: { code: number; message: string; data?: unknown };
}
export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcFailure;

export interface InitializeParams {
  protocolVersion: typeof MOBILE_PROTOCOL_VERSION;
  device: { id: string; name: string; platform: "android"; appVersion: string; signingPublicKey: string; staticDhPublicKey: string };
  capabilities: string[];
}
export interface InitializeResult {
  protocolVersion: typeof MOBILE_PROTOCOL_VERSION;
  computer: { id: string; name: string };
  capabilities: string[];
  presence: { online: true; since: number };
}

export interface SnapshotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  source?: { kind: "desktop" | "mobile" | "wechat"; deviceName?: string };
}
export interface SnapshotApproval {
  id: string;
  source: "agent" | "terminal";
  title: string;
  detail: string;
  createdAt: number;
  deadlineAt: number;
  humanOnly: boolean;
  status: "pending" | "approved" | "rejected" | "expired" | "handled_elsewhere";
  statusReason?: string;
}
export interface SnapshotQuestion {
  id: string;
  intro?: string;
  questions: AskQuestion[];
  createdAt: number;
}
export interface SessionSnapshot {
  cursor: number;
  view: MobileView;
  messages: SnapshotMessage[];
  events: { cursor: number; event: AgentEvent }[];
  approvals: SnapshotApproval[];
  questions: SnapshotQuestion[];
}

export interface DiffFile {
  path: string;
  before: string | null;
  after: string | null;
  unifiedDiff: string;
}
export interface DiffResult { turnId: number; files: DiffFile[] }
export interface AgentRespondParams { sessionId: string; requestId: string; approved: boolean; feedback?: string }

export interface MobileRequestMap {
  initialize: InitializeParams;
  "session.snapshot": { afterCursor?: number; beforeMessageId?: string; messageLimit?: number };
  "chat.send": { requestId: string; text: string; mode: "lazy"; images?: ImageInput[] };
  "chat.cancel": { requestId: string };
  "approval.respond": { id: string; approved: boolean; feedback?: string };
  "question.answer": { id: string; answers: AskAnswer[]; usedDefaults: boolean };
  "turn.undo": { turnId: number };
  "diff.get": { turnId: number };
  "agents.list": Record<string, never>;
  "agents.respond": AgentRespondParams;
}

export interface MobileResultMap {
  initialize: InitializeResult;
  "session.snapshot": SessionSnapshot;
  "chat.send": { accepted: true; requestId: string; turnId: number };
  "chat.cancel": { accepted: true };
  "approval.respond": { accepted: true; id: string; status: "approved" | "rejected" };
  "question.answer": { accepted: true; id: string };
  "turn.undo": { turnId: number; result: UndoResult };
  "diff.get": DiffResult;
  "agents.list": { sessions: AgentSessionView[]; pending: SnapshotApproval[] };
  "agents.respond": { accepted: true; requestId: string };
}

export type MobileRequest = {
  [M in keyof MobileRequestMap]: RpcRequest<M, MobileRequestMap[M]>;
}[keyof MobileRequestMap];
export type MobileSuccess = {
  [M in keyof MobileResultMap]: RpcSuccess<MobileResultMap[M]>;
}[keyof MobileResultMap];

export type MobileServerNotification =
  | RpcNotification<"mobile.event", { cursor: number; event: AgentEvent }>
  | RpcNotification<"mobile.status", MobileView>
  | RpcNotification<"mobile.ask", { approval?: SnapshotApproval; question?: SnapshotQuestion }>
  | RpcNotification<"mobile.presence", { online: boolean; lastSeenAt?: number }>
  /** Right after a first-pairing handshake: pending until the person at the desktop decides. */
  | RpcNotification<"mobile.pairing", { status: "pending" | "approved" | "rejected" }>
  | RpcNotification<"mobile.log", { level: "info" | "warn" | "error"; message: string; at: number }>;

/** Methods callable in the opposite direction by a future local-core host; not enabled in A-line MVP. */
export interface MobileClientRequestMap {
  "client.preview_page": { projectId: string; path: string };
  "client.model_config.import": { providerId: string; model: string; encryptedConfig: string };
}

export const MOBILE_ERROR = {
  BUSY: -32001,
  DEVICE_REVOKED: -32002,
  REQUEST_EXPIRED: -32003,
  POLICY_BLOCKED: -32004,
  INVALID_STATE: -32005,
  /** The device paired but the person at the desktop hasn't allowed it yet. */
  PAIRING_PENDING: -32006,
} as const;
