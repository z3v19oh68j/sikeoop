import type { AgentPermissionCard, DispatchJobStatus, DispatchProgress } from "../../shared/types.ts";

export type RpcId = string | number;
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseAcpLine(line: string): RpcMessage {
  const m: unknown = JSON.parse(line);
  if (!object(m) || m.jsonrpc !== "2.0" || (m.id !== undefined && typeof m.id !== "string" && typeof m.id !== "number")) throw Error("Invalid ACP JSON-RPC frame");
  return m as unknown as RpcMessage;
}
export function updateProgress(message: RpcMessage, sessionId: string, at = Date.now()): DispatchProgress | null {
  const p = message.params;
  if (message.method !== "session/update" || p?.sessionId !== sessionId || !object(p.update)) return null;
  const u = p.update;
  if (u.sessionUpdate === "agent_message_chunk" && object(u.content) && u.content.type === "text" && typeof u.content.text === "string") {
    return { type: "text", at, text: u.content.text.slice(0, 16384) };
  }
  if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
    if (typeof u.toolCallId !== "string") return null;
    return { type: "tool", at, toolCallId: u.toolCallId, title: typeof u.title === "string" ? u.title : undefined, status: typeof u.status === "string" ? u.status : undefined, tool: { ...u } };
  }
  return null;
}
export function permissionCard(message: RpcMessage, jobId: string, id: string): AgentPermissionCard {
  const p = message.params;
  if (message.method !== "session/request_permission" || !p || typeof p.sessionId !== "string" || !object(p.toolCall) || !Array.isArray(p.options) || !p.options.length) throw Error("Invalid ACP permission request");
  for (const o of p.options) if (!object(o) || typeof o.optionId !== "string" || typeof o.name !== "string" || typeof o.kind !== "string") throw Error("Invalid ACP permission option");
  if (new Set(p.options.map(o => o.optionId)).size !== p.options.length) throw Error("Duplicate ACP permission optionId");
  // Preserve labels, kinds, ids, and extra protocol fields exactly, not an allow/deny translation.
  return { id, jobId, sessionId: p.sessionId, title: typeof p.toolCall.title === "string" ? p.toolCall.title : "opencode", toolCall: p.toolCall, options: p.options as AgentPermissionCard["options"] };
}
export function permissionOutcome(card: AgentPermissionCard, optionId: string | null): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  return optionId !== null && card.options.some(o => o.optionId === optionId)
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}
export function stopStatus(reason: unknown): DispatchJobStatus {
  if (reason === "end_turn") return "done";
  if (reason === "cancelled") return "cancelled";
  // Token/turn ceilings, refusals and unknown values must not be reported as success.
  return "failed";
}
