import { createHash, randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Effort } from "@shared/types";
import { validOAuthToken, type OpenAIOAuthToken } from "./openai-oauth.ts";
import type { HistoryEntry, ModelAdapter, StepHandlers, StepOptions, StepResult, StepUsage, ToolCall, ToolDef, ToolResult } from "./types";

// ChatGPT subscription inference: the Responses wire format, served by the ChatGPT backend's Codex
// endpoint and authorised by the subscription's OAuth token instead of an API key.
// The endpoint only takes stateless streaming requests (store: false, stream: true), so the whole
// history goes along every time and reasoning travels as encrypted content. What ties the steps of
// one conversation together is the thread id, sent as prompt_cache_key and the session_id header.

export const CodexResponsesURL = "https://chatgpt.com/backend-api/codex/responses";
export const CodexModelsURL = "https://chatgpt.com/backend-api/codex/models";
/** Offered when the account's model list can't be fetched. */
export const CodexFallbackModels = [
  "gpt-5.6-sol", "gpt-6", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra",
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
];
/** Where the installation id lives in the key file. */
export const CodexInstallationKey = "openai-codex-installation";
export const CodexOriginator = "codex-tui";
/** The client version sent by default; older ones are the first to be shed when capacity is short. */
export const CodexVersion = "0.162.0";
/** The lowest client version the endpoint accepts; anything older gets a 404. */
export const CodexMinVersion = "0.144.0";
/** Fields the endpoint rejects (port-src openai_codex_transform.go: openAICodexOAuthUnsupportedFields). */
export const CodexUnsupportedFields = [
  "max_output_tokens", "max_completion_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty",
  "chat_template_kwargs", "user", "metadata", "prompt_cache_retention", "safety_identifier", "stream_options",
  "truncation", "stop_sequences",
];

type Item = OpenAI.Responses.ResponseInputItem;
type Usage = OpenAI.Responses.ResponseUsage;
type FinalResponse = Pick<OpenAI.Responses.Response, "status" | "error" | "incomplete_details" | "usage"> & {
  output: OpenAI.Responses.ResponseOutputItem[];
};

const REASONING_EFFORT: Record<Effort, string> = { low: "low", medium: "medium", high: "high" };
const ENCRYPTED = "reasoning.encrypted_content";
const VERSION = /^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z.]+)?$/;
const KEEP_TOOL_RESULTS = 4;
const CLEARED = "[这段工具输出已经清理，以节省上下文空间。需要的话请重新读取或运行。]";
const WHO = "ChatGPT 订阅";

export interface CodexIdentity {
  userAgent: string;
  originator: string;
  version: string;
}

/**
 * Full gateway mimicry (user-approved): fixed Linux UA plus a version header.
 * Recorded deviation from the genuine 0.162.0 exec capture, which reports the
 * real OS with a `(originator; version)` trailer and sends no version header.
 * The UA starts with the originator and carries the same version as the
 * version header, or the endpoint answers 404.
 */
export function codexIdentity(version: string = CodexVersion): CodexIdentity {
  const v = VERSION.test(version) && version.length <= 64 && !olderThan(version, CodexMinVersion) ? version : CodexVersion;
  return { userAgent: `${CodexOriginator}/${v} (Ubuntu 22.4.0; x86_64) xterm-256color`, originator: CodexOriginator, version: v };
}

/** Compares the numeric parts; a pre-release tag does not count. */
function olderThan(version: string, floor: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map(Number);
  const a = parts(version), b = parts(floor);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export function codexHeaders(token: OpenAIOAuthToken, threadId: string, identity: CodexIdentity): Record<string, string> {
  return {
    Authorization: `Bearer ${token.access_token}`,
    ...(token.chatgpt_account_id ? { "chatgpt-account-id": token.chatgpt_account_id } : {}),
    "User-Agent": identity.userAgent,
    originator: identity.originator,
    version: identity.version,
    "OpenAI-Beta": "responses=experimental",
    session_id: threadId,
    "x-client-request-id": threadId,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
}

/** The account's model list: the same login and client identity as inference, without the per-thread headers. */
export function codexModelsRequest(token: OpenAIOAuthToken, identity: CodexIdentity = codexIdentity()): { url: string; headers: Record<string, string> } {
  const { session_id: _s, "x-client-request-id": _r, "Content-Type": _c, Accept: _a, ...headers } = codexHeaders(token, "", identity);
  return { url: `${CodexModelsURL}?client_version=${encodeURIComponent(identity.version)}`, headers: { ...headers, Accept: "application/json" } };
}

/** Model ids from the list: {models: [{slug}]}, or the usual {data: [{id}]}. */
export function parseCodexModels(payload: unknown): string[] {
  const body = payload && typeof payload === "object" ? (payload as { models?: unknown; data?: unknown }) : {};
  const list = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  const ids = list.map((m) => (m && typeof m === "object" ? ((m as { slug?: unknown }).slug ?? (m as { id?: unknown }).id) : m));
  return [...new Set(ids.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
}

/** A provider answered through the ChatGPT subscription instead of an API key. */
export const isCodexLogin = (p: { preset: { id: string; kind: string }; authMode: string }): boolean =>
  p.preset.kind === "openai" && p.preset.id === "openai" && p.authMode === "login";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let readInstallation: () => string | undefined = () => undefined;
let writeInstallation: (id: string) => Promise<void> = async () => {};
let unsavedInstallation: string | undefined;
export function configureInstallationStorage(read: typeof readInstallation, write: typeof writeInstallation): void {
  readInstallation = read;
  writeInstallation = write;
  unsavedInstallation = undefined;
}
/**
 * This install's id for the Codex endpoint: made once, then kept in the key file. A failed save
 * keeps the same id for the rest of this run and is tried again on the next call.
 */
export function codexInstallationId(): string {
  const saved = readInstallation();
  if (saved && UUID.test(saved)) return saved;
  const id = (unsavedInstallation ??= randomUUID());
  void writeInstallation(id).catch(() => {});
  return id;
}

export interface CodexTurn {
  threadId: string;
  turnId: string;
  rootTurnId: string;
  installationId: string;
  model: string;
  effort: string;
}

/** What the client says about the turn a request belongs to; every value is a string. */
export function codexClientMetadata(t: CodexTurn): Record<string, string> {
  const ids = { thread_id: t.threadId, session_id: t.threadId, turn_id: t.turnId, root_turn_id: t.rootTurnId };
  return {
    "x-codex-installation-id": t.installationId,
    ...ids,
    "x-codex-window-id": `${t.threadId}:0`,
    "x-codex-turn-metadata": JSON.stringify({ ...ids, installation_id: t.installationId, model: t.model, reasoning_effort: t.effort }),
  };
}

/** A Responses request body in the shape the Codex endpoint takes. Changes the body in place. */
export function toCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.model === "string") body.model = body.model.trim();
  body.store = false;
  body.stream = true;
  for (const key of CodexUnsupportedFields) delete body[key];
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && Object.keys(reasoning).length) {
    if (body.include == null) body.include = [ENCRYPTED];
    else if (Array.isArray(body.include) && !body.include.includes(ENCRYPTED)) body.include.push(ENCRYPTED);
  }
  if (typeof body.input === "string") body.input = body.input.trim() ? [{ type: "message", role: "user", content: body.input }] : [];
  return body;
}

/**
 * An output item as it goes back in as input. Nothing is stored upstream, so an item id has
 * nothing to point at (a replayed rs_* id is a 404): ids are dropped, and a reasoning item keeps
 * its encrypted content plus the summary field the endpoint requires.
 */
export function toReplayItem(item: unknown): Item {
  const { id: _id, status: _status, ...rest } = item as Record<string, unknown>;
  if (rest.type === "reasoning") {
    delete rest.call_id;
    rest.summary ??= [];
  }
  return rest as unknown as Item;
}

export class CodexError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "CodexError";
    this.status = status;
    this.code = code;
  }
}

/** The JSON payloads of a server-sent event stream, one per event. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = function* (block: string): Generator<Record<string, unknown>> {
    const data = block.split("\n").flatMap((line) => (line.startsWith("data:") ? [line.slice(5).replace(/^ /, "")] : [])).join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const value: unknown = JSON.parse(data);
      if (value && typeof value === "object") yield value as Record<string, unknown>;
    } catch {
      // Not JSON: a keep-alive or a line this client does not know. Skip it.
    }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // A chunk may end between the two halves of a CRLF: leave that CR for the next chunk.
    const held = buffer.endsWith("\r") ? "\r" : "";
    buffer = buffer.slice(0, buffer.length - held.length).replace(/\r\n?/g, "\n") + held;
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      yield* parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  yield* parse((buffer + decoder.decode()).replace(/\r\n?/g, "\n"));
}

interface SavedState {
  format: "codex";
  items: Item[];
  carry: string | null;
  lastInput: number;
  threadId: string;
  turnId: string | null;
  rootTurnId: string | null;
}

export interface CodexOptions {
  model: string;
  /** Installation id (codexInstallationId() in the app); a fresh uuid when left out. */
  installationId?: string;
  /** Client version for the User-Agent; one below the endpoint's minimum is ignored. */
  version?: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  token?: () => Promise<OpenAIOAuthToken | undefined>;
}

export class OpenAICodexAdapter implements ModelAdapter {
  private readonly model: string;
  private readonly system: string;
  private readonly tools: OpenAI.Responses.FunctionTool[];
  private readonly identity: CodexIdentity;
  private readonly fetch: typeof fetch;
  private readonly token: () => Promise<OpenAIOAuthToken | undefined>;
  readonly nativeCompaction = false;
  private items: Item[] = [];
  private carry: string | null = null;
  private lastInput = 0;
  private readonly installationId: string;
  private threadId: string = randomUUID();
  /** One id per user turn, shared by its steps; the root is the thread's first turn. */
  private turnId: string | null = null;
  private rootTurnId: string | null = null;

  constructor(opts: CodexOptions, systemPrompt: string, tools: ToolDef[]) {
    this.model = opts.model.trim();
    this.installationId = opts.installationId ?? randomUUID();
    this.system = systemPrompt;
    this.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    this.identity = codexIdentity(opts.version);
    this.fetch = opts.fetch ?? fetch;
    this.token = opts.token ?? validOAuthToken;
  }

  promptTokens(): number {
    return this.lastInput;
  }

  history(): HistoryEntry[] {
    const toolNames = new Map<string, string>();
    const out: HistoryEntry[] = [];
    let thinking = 0;
    for (const it of this.items) {
      if (it.type === "reasoning") {
        thinking += it.summary.reduce((n, s) => n + s.text.length, 0);
      } else if (it.type === "function_call") {
        toolNames.set(it.call_id, it.name);
        // Calls belong to the assistant entry just before them (or start one).
        const last = out[out.length - 1];
        const call = { name: it.name, input: safeJson(it.arguments) };
        if (last?.role === "assistant") last.calls = [...(last.calls ?? []), call];
        else out.push({ role: "assistant", text: "", calls: [call], thinkingChars: thinking });
        thinking = 0;
      } else if (it.type === "function_call_output") {
        out.push({ role: "tool", tool: toolNames.get(it.call_id ?? ""), text: typeof it.output === "string" ? it.output : "" });
      } else if (it.type === "message" || it.type === undefined) {
        const m = it as { role: string; content: unknown };
        if (m.role === "user") out.push({ role: "user", text: textOf(m.content) });
        else if (m.role === "assistant") {
          out.push({ role: "assistant", text: textOf(m.content), calls: [], thinkingChars: thinking });
          thinking = 0;
        }
      }
    }
    if (this.carry) out.push({ role: "user", text: this.carry });
    return out;
  }

  restart(summary: string[], continueNow: boolean): void {
    this.items = [];
    this.lastInput = 0;
    // A compressed history shares no prefix with the old one: it starts a new thread.
    this.threadId = randomUUID();
    this.turnId = this.rootTurnId = null;
    const text = summary.join("\n\n");
    if (continueNow) {
      this.carry = null;
      this.newTurn();
      this.items.push({ role: "user", content: text });
    } else {
      this.carry = text;
    }
  }

  private newTurn(): string {
    this.turnId = randomUUID();
    this.rootTurnId ??= this.turnId;
    return this.turnId;
  }

  addUserText(parts: string[]): void {
    this.newTurn();
    const text = [...(this.carry ? [this.carry] : []), ...parts].join("\n\n");
    this.carry = null;
    const last = this.items[this.items.length - 1] as { role?: string; content?: unknown; type?: string } | undefined;
    if (last && last.role === "user" && typeof last.content === "string") last.content += "\n\n" + text;
    else this.items.push({ role: "user", content: text });
  }

  /** A user turn that shows images along with its text (for the vision helper). */
  addUserImages(images: { mime: string; data: string }[], text: string): void {
    this.newTurn();
    this.items.push({
      role: "user",
      content: [
        ...images.map((i) => ({ type: "input_image" as const, detail: "auto" as const, image_url: `data:${i.mime};base64,${i.data}` })),
        { type: "input_text" as const, text },
      ],
    });
  }

  async step(opts: StepOptions, h: StepHandlers): Promise<StepResult> {
    try {
      return await this.stepOnce(opts, h);
    } catch (err) {
      if (isContextError(err) && this.clearOldToolResults()) {
        const res = await this.stepOnce(opts, h);
        return { ...res, trimmed: { how: "cleared" } };
      }
      throw err;
    }
  }

  private clearOldToolResults(): boolean {
    const idx = this.items.flatMap((it, i) => (it.type === "function_call_output" && it.output !== CLEARED ? [i] : []));
    const old = idx.slice(0, Math.max(0, idx.length - KEEP_TOOL_RESULTS));
    for (const i of old) this.items[i] = { ...(this.items[i] as OpenAI.Responses.ResponseInputItem.FunctionCallOutput), output: CLEARED };
    return old.length > 0;
  }

  private async stepOnce({ signal, effort }: StepOptions, h: StepHandlers): Promise<StepResult> {
    const token = await this.token();
    if (!token) throw new CodexError("还没有登录 ChatGPT 订阅。", 401);
    const body = toCodexBody({
      model: this.model,
      instructions: this.system,
      input: this.items,
      tools: this.tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: REASONING_EFFORT[effort] },
      prompt_cache_key: this.threadId,
      client_metadata: codexClientMetadata({
        threadId: this.threadId,
        turnId: this.turnId ?? this.newTurn(),
        rootTurnId: this.rootTurnId ?? this.newTurn(),
        installationId: this.installationId,
        model: this.model,
        effort: REASONING_EFFORT[effort],
      }),
    });
    const res = await this.fetch(CodexResponsesURL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: codexHeaders(token, this.threadId, this.identity),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new CodexError(`${WHO} 的回复中途断了，再试一次。`);

    let final: FinalResponse | undefined;
    // Argument deltas name the output item; previews are keyed by the call id.
    const callIds = new Map<string, string>();
    // The completed event may come without the output list; the finished items rebuild it.
    const done: OpenAI.Responses.ResponseOutputItem[] = [];
    for await (const ev of sseEvents(res.body)) {
      switch (ev.type) {
        case "response.output_text.delta":
          if (typeof ev.delta === "string") h.onText(ev.delta);
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (typeof ev.delta === "string") h.onThinking(ev.delta);
          break;
        case "response.output_item.added": {
          const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.call_id && item.name) {
            if (item.id) callIds.set(item.id, item.call_id);
            h.onToolStart?.(item.call_id, item.name);
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const id = callIds.get(String(ev.item_id));
          if (id && typeof ev.delta === "string") h.onToolInput?.(id, ev.delta);
          break;
        }
        case "response.output_item.done":
          if (ev.item && typeof ev.item === "object") done.push(ev.item as OpenAI.Responses.ResponseOutputItem);
          break;
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          final = ev.response as FinalResponse;
          break;
        case "error": {
          const e = (ev.error && typeof ev.error === "object" ? ev.error : ev) as { message?: unknown; code?: unknown };
          throw new CodexError(String(e.message ?? "未知错误"), undefined, typeof e.code === "string" ? e.code : undefined);
        }
      }
    }
    if (!final) throw new CodexError(`${WHO} 的回复中途断了，再试一次。`);
    if (final.status === "failed") throw new CodexError(final.error?.message ?? "未知错误", undefined, final.error?.code);
    const output = Array.isArray(final.output) && final.output.length ? final.output : done;

    const stepUsage = toStepUsage(final.usage);
    this.lastInput = final.usage?.input_tokens ?? this.lastInput;

    const toolCalls: ToolCall[] = output.flatMap((o) =>
      o.type === "function_call" ? [{ id: o.call_id, name: o.name, input: parseArgs(o.arguments) }] : [],
    );
    const reason = final.incomplete_details?.reason;
    if (reason === "content_filter") return { stop: "refusal", toolCalls: [], usage: stepUsage };
    if (reason === "max_output_tokens" && toolCalls.length) return { stop: "max_tokens", toolCalls, usage: stepUsage };

    // Output items go back as input: messages, reasoning (encrypted) and calls, without their ids.
    this.items.push(...output.map(toReplayItem));

    if (reason === "max_output_tokens") return { stop: "max_tokens", toolCalls: [], usage: stepUsage };
    if (toolCalls.length) return { stop: "tool_use", toolCalls, usage: stepUsage };
    const refused = output.some((o) => o.type === "message" && o.content.some((c) => c.type === "refusal"));
    return { stop: refused ? "refusal" : "end_turn", toolCalls: [], usage: stepUsage };
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      this.items.push({ type: "function_call_output", call_id: r.id, output: r.isError ? `Error: ${r.content}` : r.content });
    }
  }

  checkpoint(): number {
    return this.items.length;
  }

  rollback(to: number): void {
    this.items.length = to;
  }

  exportState(): SavedState {
    return { format: "codex", items: this.items, carry: this.carry, lastInput: this.lastInput, threadId: this.threadId,
      turnId: this.turnId, rootTurnId: this.rootTurnId };
  }

  importState(state: unknown): void {
    const s = state as Partial<SavedState>;
    this.items = (s.items ?? []).map(toReplayItem);
    this.carry = s.carry ?? null;
    this.lastInput = s.lastInput ?? 0;
    if (typeof s.threadId === "string" && s.threadId) this.threadId = s.threadId;
    this.turnId = s.turnId ?? null;
    this.rootTurnId = s.rootTurnId ?? null;
  }

  isAbort(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
  }

  describeError(err: unknown): string | null {
    if (!(err instanceof CodexError)) {
      if (err instanceof TypeError && /fetch/i.test(err.message)) return `连不上 ${WHO}。检查一下网络和代理。`;
      return null;
    }
    if (isContextError(err)) return "对话太长了，超出了这个模型能记住的长度。点「新对话」重新开始吧。";
    if (err.code === "server_is_overloaded") return `${WHO} 那边现在太忙了，过一会儿再试。`;
    if (err.status === 401) return `${WHO} 的登录已经失效了，去设置里重新登录吧。`;
    if (err.status === 403) return `这个 ChatGPT 账号没有权限使用模型「${this.model}」。`;
    if (err.status === 404) return `${WHO} 找不到模型「${this.model}」，或者接口不认这个客户端版本。`;
    if (err.status === 429 || err.code === "usage_limit_reached") return `${WHO} 的额度用完了，或者请求太频繁。等额度恢复后再试。`;
    if (err.status === 400) return `请求格式有问题：${err.message}`;
    if (err.status !== undefined && err.status >= 500) return `${WHO} 那边暂时出了问题，过一会儿再试。`;
    if (err.status === undefined && err.code === undefined) return err.message;
    return `${WHO} 出错了（${err.status ?? err.code}）：${err.message}`;
  }
}

/** An error response as a CodexError carrying the upstream message and code, never the request. */
async function httpError(res: Response): Promise<CodexError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const data = JSON.parse(await res.text()) as { error?: { message?: unknown; code?: unknown; type?: unknown }; detail?: unknown };
    const text = data.error?.message ?? data.detail;
    if (typeof text === "string" && text) message = text;
    const c = data.error?.code ?? data.error?.type;
    if (typeof c === "string") code = c;
  } catch {
    // Not JSON: the status is all there is.
  }
  return new CodexError(message, res.status, code);
}

/** Responses usage in the app's terms; input_tokens includes the cached part. */
function toStepUsage(u: Usage | null | undefined): StepUsage {
  const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (u?.input_tokens ?? 0) - cacheRead), output: u?.output_tokens ?? 0, cacheRead, cacheWrite: 0 };
}

function isContextError(err: unknown): boolean {
  if (!(err instanceof CodexError)) return false;
  if (err.code === "context_length_exceeded") return true;
  return err.status === 400 && /context|maximum.*tokens|too (long|large)|token limit|exceeds/i.test(err.message);
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n");
  return "";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Subscription quota. It has its own endpoint: the inference responses do not carry it.

export const CodexUsageURL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_USAGE_TIMEOUT = 20_000;
export const CODEX_USAGE_CACHE_TTL = 3 * 60_000;
export const CODEX_USAGE_ERROR_CACHE_TTL = 60_000;

export interface CodexQuotaWindow {
  /** 0–100. */
  used_percent: number;
  /** ISO time the window starts over, when the endpoint says. */
  resets_at?: string;
  /** Length of the window in seconds (18000 = 5 hours, 604800 = 7 days), when the endpoint says. */
  window_seconds?: number;
}
export interface CodexQuotaLimit {
  limit_reached: boolean;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
}
/** Percentages and times only: no user id, account id, e-mail or raw response leaves this module. */
export interface CodexQuota extends CodexQuotaLimit {
  plan_type?: string;
  /** Limits of single features, by name. */
  additional: ({ name: string } & CodexQuotaLimit)[];
  fetched_at: string;
}
export type CodexQuotaResult = CodexQuota | { error: string };

const record = (raw: unknown): Record<string, unknown> | undefined =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;

function quotaWindow(raw: unknown, now: number): CodexQuotaWindow | undefined {
  const w = record(raw);
  if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) return undefined;
  const out: CodexQuotaWindow = { used_percent: Math.max(0, Math.min(100, w.used_percent)) };
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const at = seconds(w.reset_at), after = seconds(w.reset_after_seconds);
  const reset = at !== undefined ? at * 1000 : after !== undefined ? now + after * 1000 : undefined;
  if (reset !== undefined && reset <= 8.64e15) out.resets_at = new Date(reset).toISOString();
  const length = seconds(w.limit_window_seconds);
  if (length !== undefined) out.window_seconds = length;
  return out;
}

function quotaLimit(raw: unknown, now: number): CodexQuotaLimit {
  const limit = record(raw);
  const primary = quotaWindow(limit?.primary_window, now), secondary = quotaWindow(limit?.secondary_window, now);
  return { limit_reached: limit?.limit_reached === true, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
}

export function parseCodexQuota(raw: unknown, now = Date.now()): CodexQuota {
  const body = record(raw);
  if (!body) throw new Error("ChatGPT 额度返回无效数据");
  const additional = (Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []).flatMap((item) => {
    const entry = record(item);
    const name = typeof entry?.limit_name === "string" && entry.limit_name.trim() ? entry.limit_name.trim()
      : typeof entry?.metered_feature === "string" ? entry.metered_feature.trim() : "";
    const limit = quotaLimit(entry?.rate_limit, now);
    return name && (limit.primary || limit.secondary) ? [{ name, ...limit }] : [];
  });
  return {
    ...(typeof body.plan_type === "string" && body.plan_type ? { plan_type: body.plan_type } : {}),
    ...quotaLimit(body.rate_limit, now),
    additional,
    fetched_at: new Date(now).toISOString(),
  };
}

/** Quota-endpoint headers (port-src openai_quota_service.go buildCodexCommonHeaders):
 * this endpoint takes a browser-style set, not the inference identity triple. */
export function codexQuotaHeaders(token: OpenAIOAuthToken): Record<string, string> {
  return {
    Authorization: `Bearer ${token.access_token}`,
    ...(token.chatgpt_account_id ? { "chatgpt-account-id": token.chatgpt_account_id } : {}),
    "openai-beta": "codex-1",
    "oai-language": "zh-CN",
    originator: "Codex Desktop",
    Accept: "application/json",
    "sec-fetch-site": "none",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-dest": "empty",
    priority: "u=4, i",
  };
}

/** Query the quota with an already-valid login. Errors name the status only, never the response or the request. */
export async function fetchCodexQuota(token: OpenAIOAuthToken,
  options: { fetch?: typeof fetch; timeout?: number; now?: () => number } = {}): Promise<CodexQuota> {
  if (!token || typeof token.access_token !== "string" || !token.access_token.trim()) throw new Error("还没有登录 ChatGPT 订阅");
  const headers = codexQuotaHeaders(token);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(CodexUsageURL, { method: "GET", redirect: "error", headers,
      signal: AbortSignal.timeout(options.timeout ?? CODEX_USAGE_TIMEOUT) });
  } catch { throw new Error("ChatGPT 额度查询失败"); }
  if (!response.ok) throw new Error(`ChatGPT 额度请求失败 (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("ChatGPT 额度返回无效 JSON"); }
  return parseCodexQuota(payload, (options.now ?? Date.now)());
}

type QuotaCacheEntry = { expires: number } & ({ value: CodexQuota; error?: never } | { error: string; value?: never });
interface QuotaCacheSlot { fingerprint: string; entry?: QuotaCacheEntry; pending?: Promise<CodexQuota> }
const QUOTA_ERRORS = /^(?:还没有登录 ChatGPT 订阅|ChatGPT 额度(?:请求失败 \(HTTP \d{3}\)|返回无效 JSON|返回无效数据|查询失败))$/;

/** One login's quota, kept in memory: 3 minutes for a result, 1 minute for a failure. The login itself is never stored. */
export class CodexQuotaCache {
  private slot?: QuotaCacheSlot;
  private readonly now: () => number;
  private readonly requestOptions: { fetch?: typeof fetch; timeout?: number; now: () => number };

  constructor(options: { fetch?: typeof fetch; timeout?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.requestOptions = { fetch: options.fetch, timeout: options.timeout, now: this.now };
  }

  async get(token: OpenAIOAuthToken | undefined, fresh = false): Promise<CodexQuota> {
    // No login never reads an old entry or starts a request.
    if (!token || typeof token.access_token !== "string" || !token.access_token.trim()) throw new Error("还没有登录 ChatGPT 订阅");
    const fingerprint = createHash("sha256").update(JSON.stringify([token.access_token, token.chatgpt_account_id ?? ""])).digest("hex");
    if (this.slot?.fingerprint !== fingerprint) this.slot = { fingerprint };
    const slot = this.slot;
    if (!fresh && slot.entry && this.now() < slot.entry.expires) {
      if (slot.entry.error !== undefined) throw new Error(slot.entry.error);
      return structuredClone(slot.entry.value);
    }
    slot.pending ??= fetchCodexQuota(token, this.requestOptions).then((value) => {
      slot.entry = { value: structuredClone(value), expires: this.now() + CODEX_USAGE_CACHE_TTL };
      return value;
    }, (error) => {
      // Only this module's own messages are kept and shown again.
      const message = error instanceof Error && QUOTA_ERRORS.test(error.message) ? error.message : "ChatGPT 额度查询失败";
      slot.entry = { error: message, expires: this.now() + CODEX_USAGE_ERROR_CACHE_TTL };
      throw new Error(message);
    }).finally(() => { slot.pending = undefined; });
    return structuredClone(await slot.pending);
  }
}

const quotaCache = new CodexQuotaCache();
export const cachedCodexQuota = (token: OpenAIOAuthToken | undefined): Promise<CodexQuota> => quotaCache.get(token);
