import type {
  AgentMobileSnapshot,
  AgentSession,
} from "../agent/loop";
import type {
  AgentRespondParams,
  DiffResult,
  MobileResultMap,
  RpcFailure,
  RpcId,
  RpcSuccess,
  SessionSnapshot,
  SnapshotApproval,
} from "../../shared/protocol.ts";
import { MOBILE_ERROR, MOBILE_PROTOCOL_VERSION, MOBILE_METHODS } from "../../shared/protocol.ts";
import type { AgentSessionView, AskAnswer, MobileView } from "../../shared/types";

type RequestLike = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type DeviceIdentity = { id: string; name: string };

export interface MobileRpcDeps {
  session: Pick<AgentSession, "busy" | "send" | "cancel" | "respondApproval" | "answerQuestion" | "undoTurn" | "mobileSnapshot">;
  device: DeviceIdentity;
  computer: { id: string; name: string };
  view(snapshot: AgentMobileSnapshot): MobileView;
  getDiff?(turnId: number): Promise<DiffResult> | DiffResult;
  listAgents?(): Promise<{ sessions: AgentSessionView[]; pending: SnapshotApproval[] }> | { sessions: AgentSessionView[]; pending: SnapshotApproval[] };
  respondAgent?(input: AgentRespondParams): Promise<{ accepted: true; requestId: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is RpcId => typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
const stringParam = (params: Record<string, unknown>, name: string, max = 200_000): string => {
  const value = params[name];
  if (typeof value !== "string" || value.length > max) throw new RpcInputError(`invalid ${name}`);
  return value;
};

class RpcInputError extends Error {}

function ok<T>(id: RpcId, result: T): RpcSuccess<T> { return { jsonrpc: "2.0", id, result }; }
function fail(id: RpcId | null, code: number, message: string, data?: unknown): RpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function approvalTitle(subject: AgentMobileSnapshot["pendingApprovals"][number]["subject"]): { title: string; detail: string } {
  if (subject.kind === "command") return { title: "想运行命令", detail: subject.command.command };
  if (subject.kind === "file") return { title: "想修改文件", detail: subject.change.path };
  return { title: "想调用工具", detail: `${subject.call.server}/${subject.call.tool}` };
}

function toSnapshot(snapshot: AgentMobileSnapshot, view: MobileView): SessionSnapshot {
  const messages = snapshot.transcript.map((item, index) => {
    if (item.role === "user") {
      return {
        id: `${snapshot.sessionId}:${index}`,
        role: "user" as const,
        text: item.text,
        createdAt: item.createdAt ?? 0,
        ...(item.source ? { source: item.source } : {}),
      };
    }
    const text = item.events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : "").join("");
    return { id: `${snapshot.sessionId}:${index}`, role: "assistant" as const, text, createdAt: item.createdAt ?? 0 };
  });
  const approvals: SnapshotApproval[] = snapshot.pendingApprovals.map((pending) => {
    const detail = approvalTitle(pending.subject);
    const deadlineAt = pending.createdAt + 10 * 60_000;
    return {
      id: pending.id,
      source: "agent",
      ...detail,
      createdAt: pending.createdAt,
      deadlineAt,
      humanOnly: pending.humanOnly,
      status: "pending",
    };
  });
  return {
    cursor: snapshot.eventCursor,
    view,
    messages,
    events: snapshot.events,
    approvals,
    questions: snapshot.pendingQuestions.map((question) => ({ ...question, createdAt: question.createdAt })),
  };
}

/** Dispatches authenticated mobile calls. The relay never invokes this class; only decrypted RPCs do. */
export class MobileRpcDispatcher {
  #deps: MobileRpcDeps;

  constructor(deps: MobileRpcDeps) { this.#deps = deps; }

  async dispatch(input: unknown): Promise<RpcSuccess | RpcFailure> {
    const request = isRecord(input) ? input as RequestLike : {};
    const id = isId(request.id) ? request.id : null;
    if (request.jsonrpc !== "2.0" || id === null || typeof request.method !== "string" || !isRecord(request.params)) {
      return fail(id, -32600, "Invalid Request");
    }
    const method = request.method;
    if (!(MOBILE_METHODS as readonly string[]).includes(method)) return fail(id, -32601, "Method not allowed");
    const params = request.params;
    try {
      switch (method) {
        case "initialize": {
          if (params.protocolVersion !== MOBILE_PROTOCOL_VERSION) return fail(id, -32010, "Protocol version mismatch");
          return ok(id, {
            protocolVersion: MOBILE_PROTOCOL_VERSION,
            computer: this.#deps.computer,
            capabilities: ["snapshot", "chat", "approval", "undo", "diff", "agents"],
            presence: { online: true, since: Date.now() },
          } satisfies MobileResultMap["initialize"]);
        }
        case "session.snapshot": {
          const state = this.#deps.session.mobileSnapshot();
          return ok(id, toSnapshot(state, this.#deps.view(state)));
        }
        case "chat.send": {
          if (this.#deps.session.busy) {
            const state = this.#deps.session.mobileSnapshot();
            return fail(id, MOBILE_ERROR.BUSY, "The main conversation is busy", { activity: state.task || "正在处理上一条消息" });
          }
          const text = stringParam(params, "text", 100_000).trim();
          if (!text) throw new RpcInputError("text must not be empty");
          if (params.mode !== "lazy") throw new RpcInputError("remote tasks are fixed to lazy mode");
          const requestId = stringParam(params, "requestId", 128);
          const images = parseImages(params.images);
          const turnId = this.#deps.session.mobileSnapshot().turnId + 1;
          void this.#deps.session.send({
            text,
            editor: {},
            effort: "medium",
            lazy: true,
            ...(images.length ? { images } : {}),
            origin: { kind: "mobile", deviceId: this.#deps.device.id, deviceName: this.#deps.device.name },
          });
          return ok(id, { accepted: true, requestId, turnId } satisfies MobileResultMap["chat.send"]);
        }
        case "chat.cancel": {
          this.#deps.session.cancel();
          return ok(id, { accepted: true } satisfies MobileResultMap["chat.cancel"]);
        }
        case "approval.respond": {
          const approvalId = stringParam(params, "id", 128);
          const pending = this.#deps.session.mobileSnapshot().pendingApprovals.find((item) => item.id === approvalId);
          if (!pending) return fail(id, MOBILE_ERROR.INVALID_STATE, "Approval is no longer pending");
          if (typeof params.approved !== "boolean") throw new RpcInputError("approved must be boolean");
          this.#deps.session.respondApproval({ id: approvalId, decision: params.approved ? "approve" : "reject", ...(typeof params.feedback === "string" ? { feedback: params.feedback.slice(0, 2000) } : {}) });
          return ok(id, { accepted: true, id: approvalId, status: params.approved ? "approved" : "rejected" } satisfies MobileResultMap["approval.respond"]);
        }
        case "question.answer": {
          const questionId = stringParam(params, "id", 128);
          const pending = this.#deps.session.mobileSnapshot().pendingQuestions.find((item) => item.id === questionId);
          if (!pending) return fail(id, MOBILE_ERROR.INVALID_STATE, "Question is no longer pending");
          if (!Array.isArray(params.answers) || typeof params.usedDefaults !== "boolean") throw new RpcInputError("invalid question answer");
          this.#deps.session.answerQuestion({ id: questionId, answers: parseQuestionAnswers(params.answers), usedDefaults: params.usedDefaults });
          return ok(id, { accepted: true, id: questionId } satisfies MobileResultMap["question.answer"]);
        }
        case "turn.undo": {
          if (!Number.isSafeInteger(params.turnId) || typeof params.turnId !== "number") throw new RpcInputError("invalid turnId");
          const result = await this.#deps.session.undoTurn(params.turnId);
          return ok(id, { turnId: params.turnId, result } satisfies MobileResultMap["turn.undo"]);
        }
        case "diff.get": {
          if (!Number.isSafeInteger(params.turnId) || typeof params.turnId !== "number") throw new RpcInputError("invalid turnId");
          if (!this.#deps.getDiff) return fail(id, MOBILE_ERROR.INVALID_STATE, "Diff history unavailable");
          return ok(id, await this.#deps.getDiff(params.turnId));
        }
        case "agents.list": {
          return ok(id, this.#deps.listAgents ? await this.#deps.listAgents() : { sessions: [], pending: [] });
        }
        case "agents.respond": {
          if (!this.#deps.respondAgent) return fail(id, MOBILE_ERROR.INVALID_STATE, "Terminal agent control unavailable");
          const input: AgentRespondParams = {
            sessionId: stringParam(params, "sessionId", 128),
            requestId: stringParam(params, "requestId", 128),
            approved: params.approved === true,
            ...(typeof params.feedback === "string" ? { feedback: params.feedback.slice(0, 2000) } : {}),
          };
          if (typeof params.approved !== "boolean") throw new RpcInputError("approved must be boolean");
          return ok(id, await this.#deps.respondAgent(input));
        }
        default:
          return fail(id, -32601, "Method not allowed");
      }
    } catch (error) {
      if (error instanceof RpcInputError) return fail(id, -32602, error.message);
      return fail(id, MOBILE_ERROR.INVALID_STATE, error instanceof Error ? error.message : "Request failed");
    }
  }
}

function parseQuestionAnswers(value: unknown): AskAnswer[] {
  if (!Array.isArray(value) || value.length > 20) throw new RpcInputError("invalid question answers");
  return value.map((answer) => {
    if (!isRecord(answer) || typeof answer.id !== "string" || answer.id.length > 128 || !Array.isArray(answer.choices) || answer.choices.length > 20 || answer.choices.some((choice) => typeof choice !== "string" || choice.length > 500)) {
      throw new RpcInputError("invalid question answer item");
    }
    if (answer.other !== undefined && (typeof answer.other !== "string" || answer.other.length > 2000)) throw new RpcInputError("invalid question answer text");
    return { id: answer.id, choices: answer.choices as string[], ...(typeof answer.other === "string" ? { other: answer.other } : {}) };
  });
}

function parseImages(value: unknown): { mime: string; data: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6) throw new RpcInputError("images must contain at most six items");
  const images: { mime: string; data: string }[] = [];
  let total = 0;
  for (const image of value) {
    if (!isRecord(image) || typeof image.mime !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(image.mime) || typeof image.data !== "string" || image.data.length > 600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      throw new RpcInputError("invalid image attachment");
    }
    total += image.data.length;
    // The outer encrypted relay frame is capped at 1 MiB; leave room for JSON and base64 overhead.
    if (total > 600_000) throw new RpcInputError("image attachments exceed the mobile relay frame limit");
    images.push({ mime: image.mime, data: image.data });
  }
  return images;
}
