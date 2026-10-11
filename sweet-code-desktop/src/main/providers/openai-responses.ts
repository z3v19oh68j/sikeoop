import OpenAI from "openai";
import type { Effort } from "@shared/types";
import type { HistoryEntry, ModelAdapter, StepHandlers, StepOptions, StepResult, ToolCall, ToolDef, ToolResult } from "./types";

// The OpenAI Responses API (POST /responses), the format newer GPT models are served through.
// Requests are stateless (store: false): the whole history goes along every time, and reasoning
// items are kept with their encrypted content so the model can pick its thinking back up.
// Like Chat Completions there is no server-side compaction here; the agent loop handles that.

type Item = OpenAI.Responses.ResponseInputItem;
type Usage = OpenAI.Responses.ResponseUsage;

/** The chat's thinking-depth levels as Responses `reasoning.effort`. */
const REASONING_EFFORT: Record<Effort, OpenAI.ReasoningEffort> = { low: "low", medium: "medium", high: "high" };
const KEEP_TOOL_RESULTS = 4;
const CLEARED = "[这段工具输出已经清理，以节省上下文空间。需要的话请重新读取或运行。]";

interface SavedState {
  format: "responses";
  items: Item[];
  carry: string | null;
  lastInput: number;
}

export interface ResponsesOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly providerName: string;
  private readonly system: string;
  private readonly tools: OpenAI.Responses.FunctionTool[];
  readonly nativeCompaction = false;
  private items: Item[] = [];
  private carry: string | null = null;
  private lastInput = 0;

  constructor(opts: ResponsesOptions, systemPrompt: string, tools: ToolDef[]) {
    this.client = new OpenAI({ apiKey: opts.apiKey || "not-needed", baseURL: opts.baseURL });
    this.model = opts.model;
    this.providerName = opts.providerName;
    this.system = systemPrompt;
    this.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
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
    const text = summary.join("\n\n");
    if (continueNow) {
      this.carry = null;
      this.items.push({ role: "user", content: text });
    } else {
      this.carry = text;
    }
  }

  addUserText(parts: string[]): void {
    const text = [...(this.carry ? [this.carry] : []), ...parts].join("\n\n");
    this.carry = null;
    const last = this.items[this.items.length - 1] as { role?: string; content?: unknown; type?: string } | undefined;
    if (last && last.role === "user" && typeof last.content === "string") last.content += "\n\n" + text;
    else this.items.push({ role: "user", content: text });
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
    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions: this.system,
        input: this.items,
        tools: this.tools,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: REASONING_EFFORT[effort], summary: "auto" },
      },
      { signal },
    );

    let final: OpenAI.Responses.Response | undefined;
    // Argument deltas name the output item; previews are keyed by the call id.
    const callIds = new Map<string, string>();
    for await (const ev of stream) {
      switch (ev.type) {
        case "response.output_text.delta":
          h.onText(ev.delta);
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          h.onThinking(ev.delta);
          break;
        case "response.output_item.added":
          if (ev.item.type === "function_call") {
            if (ev.item.id) callIds.set(ev.item.id, ev.item.call_id);
            h.onToolStart?.(ev.item.call_id, ev.item.name);
          }
          break;
        case "response.function_call_arguments.delta": {
          const id = callIds.get(ev.item_id);
          if (id) h.onToolInput?.(id, ev.delta);
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          final = ev.response;
          break;
        case "error":
          throw new Error(`${this.providerName} 出错了：${ev.message}`);
      }
    }
    if (!final) throw new Error(`${this.providerName} 的回复中途断了，再试一次。`);
    if (final.status === "failed") throw new Error(`${this.providerName} 出错了：${final.error?.message ?? "未知错误"}`);

    const stepUsage = toStepUsage(final.usage);
    this.lastInput = final.usage?.input_tokens ?? this.lastInput;

    const toolCalls: ToolCall[] = final.output.flatMap((o) =>
      o.type === "function_call" ? [{ id: o.call_id, name: o.name, input: parseArgs(o.arguments) }] : [],
    );
    const reason = final.incomplete_details?.reason;
    if (reason === "content_filter") return { stop: "refusal", toolCalls: [], usage: stepUsage };
    if (reason === "max_output_tokens" && toolCalls.length) return { stop: "max_tokens", toolCalls, usage: stepUsage };

    // Output items go back as input unchanged: messages, reasoning (encrypted) and calls.
    this.items.push(...(final.output as Item[]));

    if (reason === "max_output_tokens") return { stop: "max_tokens", toolCalls: [], usage: stepUsage };
    if (toolCalls.length) return { stop: "tool_use", toolCalls, usage: stepUsage };
    const refused = final.output.some((o) => o.type === "message" && o.content.some((c) => c.type === "refusal"));
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
    return { format: "responses", items: this.items, carry: this.carry, lastInput: this.lastInput };
  }

  importState(state: unknown): void {
    const s = state as Partial<SavedState> & { messages?: ChatMsg[] };
    // Saved while this provider used Chat Completions: convert the history.
    this.items = s.format === "responses" ? (s.items ?? []) : chatToItems(s.messages ?? []);
    this.carry = s.carry ?? null;
    this.lastInput = s.lastInput ?? 0;
  }

  isAbort(err: unknown): boolean {
    return err instanceof OpenAI.APIUserAbortError;
  }

  describeError(err: unknown): string | null {
    const who = this.providerName;
    if (err instanceof OpenAI.AuthenticationError) return `${who} 的 API Key 不对或者已经失效了。点左下角重新填一个吧。`;
    if (err instanceof OpenAI.PermissionDeniedError) return `这个 ${who} Key 没有权限使用模型「${this.model}」。`;
    if (err instanceof OpenAI.NotFoundError) {
      return `${who} 找不到模型「${this.model}」，或者这个接口地址不支持 Responses API。可以在设置里把调用方式换成 Chat Completions 试试。`;
    }
    if (err instanceof OpenAI.RateLimitError) return `${who} 说请求太频繁，或者账户余额不足。休息一下再试，或者去充值。`;
    if (isContextError(err)) return "对话太长了，超出了这个模型能记住的长度。点「新对话」重新开始吧。";
    if (err instanceof OpenAI.APIError && err.status === 402) return `${who} 账户余额不足，去充值后再试。`;
    if (err instanceof OpenAI.BadRequestError) {
      if (/reasoning/i.test(err.message)) return `模型「${this.model}」不支持思考深度设置，换一个 GPT 推理模型，或者在设置里把调用方式换成 Chat Completions。（${err.message}）`;
      return `请求格式有问题：${err.message}`;
    }
    if (err instanceof OpenAI.InternalServerError) return `${who} 那边暂时出了问题，过一会儿再试。`;
    if (err instanceof OpenAI.APIConnectionError) return `连不上 ${who}。检查一下网络、代理和接口地址。`;
    if (err instanceof OpenAI.APIError) return `${who} 出错了（${err.status ?? "?"}）：${err.message}`;
    return null;
  }
}

/** Responses usage in the app's terms; input_tokens includes the cached part. */
export function toStepUsage(u: Usage | null | undefined) {
  const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (u?.input_tokens ?? 0) - cacheRead), output: u?.output_tokens ?? 0, cacheRead, cacheWrite: 0 };
}

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Chat Completions history → Responses input items. Reasoning text is dropped (it can't be sent back). */
export function chatToItems(messages: ChatMsg[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: textOf(m.content) });
    else if (m.role === "assistant") {
      const text = textOf(m.content ?? "");
      if (text) out.push({ role: "assistant", content: text });
      for (const c of m.tool_calls ?? []) {
        if (c.type === "function") out.push({ type: "function_call", call_id: c.id, name: c.function.name, arguments: c.function.arguments || "{}" });
      }
    } else if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
  }
  return out;
}

/** Responses input items → Chat Completions history, for switching a provider back. */
export function itemsToChat(items: Item[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const it of items) {
    if (it.type === "function_call") {
      const call = { id: it.call_id, type: "function" as const, function: { name: it.name, arguments: it.arguments } };
      const last = out[out.length - 1];
      if (last?.role === "assistant") last.tool_calls = [...(last.tool_calls ?? []), call];
      else out.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (it.type === "function_call_output") {
      out.push({ role: "tool", tool_call_id: it.call_id ?? "", content: typeof it.output === "string" ? it.output : "" });
    } else if (it.type === "message" || it.type === undefined) {
      const m = it as { role: string; content: unknown };
      if (m.role === "user") out.push({ role: "user", content: textOf(m.content) });
      else if (m.role === "assistant") out.push({ role: "assistant", content: textOf(m.content) });
    }
  }
  return out;
}

function isContextError(err: unknown): boolean {
  return err instanceof OpenAI.BadRequestError && /context|maximum.*tokens|too (long|large)|token limit|exceeds/i.test(err.message);
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
