import OpenAI from "openai";
import type { Effort } from "@shared/types";
import { itemsToChat } from "./openai-responses";
import type { HistoryEntry, ModelAdapter, StepHandlers, StepOptions, StepResult, ToolCall, ToolDef, ToolResult } from "./types";

// There is no server-side compaction in the OpenAI format: the agent loop watches
// promptTokens() and has the compression sub-agent summarize the history (agent/compactor.ts).

/** The chat's thinking-depth levels in DeepSeek's terms (reasoning_effort accepts low / high / max). */
const REASONING_EFFORT: Record<Effort, string> = { low: "low", medium: "high", high: "max" };
/** When a request is still too long mid-turn, old tool output is cleared, keeping the newest few. */
const KEEP_TOOL_RESULTS = 4;
const CLEARED = "[这段工具输出已经清理，以节省上下文空间。需要的话请重新读取或运行。]";

interface SavedState {
  messages: Msg[];
  carry: string | null;
  lastInput: number;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
/** Assistant message plus the reasoning text some providers want back during tool use. */
type AssistantMsg = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string };
/** Fields that are not in the OpenAI spec but that several compatible providers stream. */
type LooseDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
};
type LooseUsage = OpenAI.Completions.CompletionUsage & {
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; prompt_cache_hit_tokens?: number } | null;
};

export interface CompatOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  /** Send DeepSeek-style `thinking` + `reasoning_effort`. */
  reasoningEffort?: boolean;
  /** Sent as `user_id` (cache and rate-limit isolation). */
  userId?: string;
}

/**
 * Any provider that speaks the OpenAI Chat Completions format:
 * OpenAI, DeepSeek, Moonshot (Kimi), Alibaba (Qwen), Zhipu (GLM), OpenRouter, Ollama…
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly providerName: string;
  private readonly system: string;
  private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  private readonly opts: CompatOptions;
  readonly nativeCompaction = false;
  private messages: Msg[] = [];
  /** Summary of earlier conversation, sent with the next user message after a compaction. */
  private carry: string | null = null;
  /** Prompt tokens of the latest request, to decide when to compact. */
  private lastInput = 0;

  constructor(opts: CompatOptions, systemPrompt: string, tools: ToolDef[]) {
    this.opts = opts;
    // Local servers such as Ollama ignore the key, but the SDK requires a non-empty one.
    this.client = new OpenAI({ apiKey: opts.apiKey || "not-needed", baseURL: opts.baseURL });
    this.model = opts.model;
    this.providerName = opts.providerName;
    this.system = systemPrompt;
    this.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  promptTokens(): number {
    return this.lastInput;
  }

  history(): HistoryEntry[] {
    const toolNames = new Map<string, string>();
    const out: HistoryEntry[] = [];
    for (const m of this.messages) {
      if (m.role === "user") out.push({ role: "user", text: textOf(m.content) });
      else if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).flatMap((c) => (c.type === "function" ? [c] : []));
        calls.forEach((c) => toolNames.set(c.id, c.function.name));
        out.push({
          role: "assistant",
          text: textOf(m.content ?? ""),
          thinkingChars: (m as AssistantMsg).reasoning_content?.length ?? 0,
          calls: calls.map((c) => ({ name: c.function.name, input: safeJson(c.function.arguments) })),
        });
      } else if (m.role === "tool") out.push({ role: "tool", tool: toolNames.get(m.tool_call_id), text: textOf(m.content) });
    }
    // A summary waiting for the next message is part of the context too.
    if (this.carry) out.push({ role: "user", text: this.carry });
    return out;
  }

  restart(summary: string[], continueNow: boolean): void {
    this.messages = [];
    this.lastInput = 0;
    const text = summary.join("\n\n");
    if (continueNow) {
      this.carry = null;
      this.messages.push({ role: "user", content: text });
    } else {
      this.carry = text;
    }
  }

  addUserText(parts: string[]): void {
    const text = [...(this.carry ? [this.carry] : []), ...parts].join("\n\n");
    this.carry = null;
    // After a mid-task compaction that was rolled back, the history ends with the summary: join it.
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && typeof last.content === "string") last.content += "\n\n" + text;
    else this.messages.push({ role: "user", content: text });
  }

  async step(opts: StepOptions, h: StepHandlers): Promise<StepResult> {
    try {
      return await this.stepOnce(opts, h);
    } catch (err) {
      // Still too long in the middle of a tool round: clear old tool output and retry once.
      if (isContextError(err) && this.clearOldToolResults()) {
        const res = await this.stepOnce(opts, h);
        return { ...res, trimmed: { how: "cleared" } };
      }
      throw err;
    }
  }

  /** Replace all but the newest tool results with a short note. Returns false if nothing changed. */
  private clearOldToolResults(): boolean {
    const toolIdx = this.messages.flatMap((m, i) => (m.role === "tool" && m.content !== CLEARED ? [i] : []));
    const old = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_TOOL_RESULTS));
    for (const i of old) this.messages[i] = { ...(this.messages[i] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam), content: CLEARED };
    return old.length > 0;
  }

  /** Provider-specific request fields beyond the OpenAI spec. */
  private extras(effort: Effort): Record<string, unknown> {
    return {
      ...(this.opts.reasoningEffort ? { thinking: { type: "enabled" }, reasoning_effort: REASONING_EFFORT[effort] } : {}),
      ...(this.opts.userId ? { user_id: this.opts.userId } : {}),
    };
  }

  private async stepOnce({ signal, effort }: StepOptions, h: StepHandlers): Promise<StepResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [{ role: "system", content: this.system }, ...this.messages],
        tools: this.tools,
        stream: true,
        stream_options: { include_usage: true },
        ...this.extras(effort),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal },
    );

    let text = "";
    let reasoning = "";
    let finish: string | null = null;
    let usage: LooseUsage | undefined;
    // Tool calls arrive in fragments, keyed by their index in the reply.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    const announced = new Set<number>();

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const d = choice.delta as LooseDelta;
      const think = d.reasoning_content ?? d.reasoning;
      if (think) {
        reasoning += think;
        h.onThinking(think);
      }
      if (d.content) {
        text += d.content;
        h.onText(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const cur = partial.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partial.set(tc.index, cur);
        // Only a call with a real id gets previews: the id must match the finished call's.
        if (cur.id && cur.name && !announced.has(tc.index)) {
          announced.add(tc.index);
          h.onToolStart?.(cur.id, cur.name);
        }
        if (cur.id && announced.has(tc.index) && tc.function?.arguments) h.onToolInput?.(cur.id, tc.function.arguments);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    // prompt_tokens includes the cached part; report it separately, like Claude does.
    // OpenAI reports cached_tokens; DeepSeek prompt_cache_hit_tokens (top level or under details).
    const cacheRead =
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.prompt_cache_hit_tokens ??
      usage?.prompt_cache_hit_tokens ??
      0;
    this.lastInput = usage?.prompt_tokens ?? this.lastInput;
    const stepUsage = {
      input: Math.max(0, (usage?.prompt_tokens ?? 0) - cacheRead),
      output: usage?.completion_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
    };

    const ordered = [...partial.entries()].sort((a, b) => a[0] - b[0]);
    const toolCalls: ToolCall[] = ordered.map(([i, c]) => ({
      // A few servers omit call ids; make one up so results can be matched.
      id: c.id || `call_${i}_${Date.now()}`,
      name: c.name,
      input: parseArgs(c.args),
    }));

    if (finish === "content_filter") return { stop: "refusal", toolCalls: [], usage: stepUsage };
    // DeepSeek ends a reply early when it runs short of capacity; the turn is rolled back and can be retried.
    if (finish === "insufficient_system_resource") throw new Error(`${this.providerName} 服务器资源紧张，这次没能回答完，过一会儿再试。`);
    if (finish === "length" && toolCalls.length) return { stop: "max_tokens", toolCalls, usage: stepUsage };

    const assistant: AssistantMsg = { role: "assistant", content: text || null };
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls.map((c, i) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: ordered[i][1].args || "{}" },
      }));
    }
    // Thinking models (DeepSeek, Kimi) need their reasoning back. DeepSeek requires every past
    // reasoning_content in any request that has tools (ours always do), not only on tool-call
    // turns; a missing one is a 400. Only providers that streamed reasoning get it back.
    if (reasoning) assistant.reasoning_content = reasoning;
    this.messages.push(assistant);

    if (finish === "length") return { stop: "max_tokens", toolCalls: [], usage: stepUsage };
    // Some providers finish with "stop" even when the reply contains tool calls.
    if (toolCalls.length) return { stop: "tool_use", toolCalls, usage: stepUsage };
    return { stop: "end_turn", toolCalls: [], usage: stepUsage };
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      this.messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content });
    }
  }

  checkpoint(): number {
    return this.messages.length;
  }

  rollback(to: number): void {
    this.messages.length = to;
  }

  exportState(): SavedState {
    return { messages: this.messages, carry: this.carry, lastInput: this.lastInput };
  }

  importState(state: unknown): void {
    const s = state as SavedState & { format?: string; items?: OpenAI.Responses.ResponseInputItem[] };
    // Saved while this provider used the Responses API: convert the history.
    this.messages = s.format === "responses" ? itemsToChat(s.items ?? []) : (s.messages ?? []);
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
    if (err instanceof OpenAI.NotFoundError) return `${who} 找不到模型「${this.model}」，或者接口地址填错了。`;
    if (err instanceof OpenAI.RateLimitError) return `${who} 说请求太频繁，或者账户余额不足。休息一下再试，或者去充值。`;
    if (isContextError(err)) return "对话太长了，超出了这个模型能记住的长度。点「新对话」重新开始吧。";
    if (err instanceof OpenAI.APIError && err.status === 402) return `${who} 账户余额不足，去充值后再试（设置里可以查看余额）。`;
    if (err instanceof OpenAI.APIError && err.status === 422) return `${who} 说请求参数不对：${err.message}`;
    if (err instanceof OpenAI.APIError && err.status === 503) return `${who} 服务器太忙了，稍等一会儿再试。`;
    if (err instanceof OpenAI.BadRequestError) {
      return /tool|function/i.test(err.message)
        ? `模型「${this.model}」好像不支持工具调用，换一个支持 function calling 的模型试试。（${err.message}）`
        : `请求格式有问题：${err.message}`;
    }
    if (err instanceof OpenAI.InternalServerError) return `${who} 那边暂时出了问题，过一会儿再试。`;
    if (err instanceof OpenAI.APIConnectionError) return `连不上 ${who}。检查一下网络、代理和接口地址。`;
    if (err instanceof OpenAI.APIError) return `${who} 出错了（${err.status ?? "?"}）：${err.message}`;
    return null;
  }
}

/** The provider says the request is longer than the model's context window. Wording varies by provider. */
function isContextError(err: unknown): boolean {
  return (
    err instanceof OpenAI.BadRequestError &&
    /context|maximum.*tokens|too (long|large)|token limit|exceeds|length/i.test(err.message)
  );
}

/** undefined means the model sent arguments that are not valid JSON. */
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
