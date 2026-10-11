import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "@shared/types";
import type { HistoryEntry, ModelAdapter, StepHandlers, StepOptions, StepResult, ToolDef, ToolResult, Trimmed } from "./types";
import { supportsClaudeEffort, supportsMessageEffort } from "./effort.ts";

const MAX_TOKENS = 64000;

/** Models that take an effort change as a system message, which keeps the prompt cache. */

/**
 * Long conversations stay within the context window through two server-side
 * edits. Neither counts as editing the history, so the cached prefix and
 * Claude's thinking blocks stay valid:
 *  - clear old tool results (file contents, command output) once the input is large,
 *    keeping the most recent ones, and only when enough can be cleared to be worth
 *    the cache reset;
 *  - if it still grows, summarize everything so far into a compaction block.
 */
const COMPACTION_INSTRUCTIONS =
  "Write the summary in the same language the user writes in. Keep: what the user is trying to build and their " +
  "preferences; every file that was created or changed and what changed in it; commands that were run and what " +
  "they showed; what was tried and did not work; decisions and open questions; and what the next step was. " +
  "Keep file paths and exact identifiers. Write the summary as text only; do not call any tools.";

const CONTEXT_MANAGEMENT: Anthropic.Beta.BetaContextManagementConfig = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 120_000 },
      keep: { type: "tool_uses", value: 5 },
      clear_at_least: { type: "input_tokens", value: 20_000 },
    },
    // The same 200K working window as every other provider (there, the compression sub-agent does it).
    { type: "compact_20260112", trigger: { type: "input_tokens", value: 200_000 }, instructions: COMPACTION_INSTRUCTIONS },
  ],
};

interface SavedState {
  messages: Anthropic.Beta.BetaMessageParam[];
  topEffort: Effort | null;
  currentEffort: Effort | null;
  /** Compatible mode: summary of the conversation before the last local compaction. */
  carry?: string | null;
}

/** An Anthropic-compatible service run by someone else (e.g. Xiaomi MiMo). */
export interface CompatOptions {
  providerName: string;
}
/** MiMo's limits: 131072 output tokens, 32768 for mimo-v2.5. */
const compatMaxTokens = (model: string) => (/^mimo-v2\.5$/.test(model) ? 32_768 : 65_536);

/** The raw stream events the tool streaming reads: a block starts, or its JSON arguments grow. */
interface RawStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id: string; name: string };
  delta?: { type: string; partial_json?: string };
}

/**
 * Passes a tool call on while the model writes it: its name when the block starts, then each piece
 * of its JSON arguments (input_json_delta). The tool itself still runs only on the complete call.
 */
function streamToolCalls(stream: { on(event: "streamEvent", listener: (ev: unknown) => void): unknown }, h: StepHandlers): void {
  const ids = new Map<number, string>();
  stream.on("streamEvent", (raw) => {
    // The SDK's event union is wider than RawStreamEvent (its delta has more shapes); the type checks below
    // only read the fields this function needs, so the narrowing is safe.
    const ev = raw as RawStreamEvent;
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && ev.index !== undefined) {
      ids.set(ev.index, ev.content_block.id);
      h.onToolStart?.(ev.content_block.id, ev.content_block.name);
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && ev.index !== undefined) {
      const id = ids.get(ev.index);
      if (id && ev.delta.partial_json) h.onToolInput?.(id, ev.delta.partial_json);
    }
  });
}

/** Claude through the official Anthropic SDK. */
export class AnthropicAdapter implements ModelAdapter {
  private readonly client: Anthropic;
  private readonly tools: Anthropic.Beta.BetaTool[];
  private readonly system: Anthropic.Beta.BetaTextBlockParam[];
  private readonly model: string;
  /** Claude Haiku 4.5 predates adaptive thinking, effort, and compaction. */
  private readonly legacy: boolean;
  private readonly perMessageEffort: boolean;
  private readonly supportsEffort: boolean;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  /** Effort sent at the top level. Fixed for the conversation where possible, so the cache holds. */
  private topEffort: Effort | null = null;
  /** Effort in force for the latest user turn. */
  private currentEffort: Effort | null = null;
  /** Effort state at each checkpoint, so a rollback also undoes an effort change. */
  private effortAt = new Map<number, { top: Effort | null; current: Effort | null; carry: string | null }>();

  /** Authenticated through an Anthropic account login rather than an API key. */
  private readonly login: boolean;
  /**
   * Set for Anthropic-compatible services: only the plain Messages API, thinking switched on or
   * off with {type}, and compaction done here by summarizing (no betas, no context_management).
   */
  private readonly compat: CompatOptions | null;
  private carry: string | null = null;
  private lastPrompt = 0;

  constructor(
    opts: { client: Anthropic; model: string; login: boolean; compat?: CompatOptions },
    systemPrompt: string,
    tools: ToolDef[],
  ) {
    this.client = opts.client;
    this.login = opts.login;
    this.compat = opts.compat ?? null;
    this.model = opts.model;
    this.legacy = opts.model.startsWith("claude-haiku-4-5");
    this.supportsEffort = !this.compat && supportsClaudeEffort(opts.model);
    this.perMessageEffort = !this.compat && supportsMessageEffort(opts.model);
    // Fixed system prompt and tool order keep the cached prefix identical across requests.
    // Compatible services cache on their own and may reject fields they don't document.
    this.system = this.compat ? [{ type: "text", text: systemPrompt }] : [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
  }

  /** Claude compacts on the server; compatible services leave it to the compression sub-agent. */
  get nativeCompaction(): boolean {
    return !this.compat;
  }

  promptTokens(): number {
    return this.lastPrompt;
  }

  history(): HistoryEntry[] {
    const names = new Map<string, string>();
    const out: HistoryEntry[] = [];
    for (const m of this.messages) {
      if ((m.role as string) === "system") continue; // effort changes
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as { type: string; [k: string]: unknown }[]);
      if (m.role === "assistant") {
        const calls = blocks.filter((b) => b.type === "tool_use") as unknown as { id: string; name: string; input: unknown }[];
        calls.forEach((c) => names.set(c.id, c.name));
        const text = blocks.flatMap((b) => (b.type === "text" ? [String(b.text)] : [])).join("\n");
        const thinkingChars = blocks.reduce((n, b) => n + (b.type === "thinking" ? String(b.thinking ?? "").length : 0), 0);
        out.push({ role: "assistant", text, thinkingChars, calls: calls.map((c) => ({ name: c.name, input: c.input })) });
        continue;
      }
      const text = blocks.flatMap((b) => (b.type === "text" ? [String(b.text)] : [])).join("\n");
      if (text) out.push({ role: "user", text });
      for (const b of blocks.filter((x) => x.type === "tool_result")) {
        const c = b.content;
        const body = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
        out.push({ role: "tool", tool: names.get(String(b.tool_use_id)), text: body });
      }
    }
    // A summary waiting for the next message is part of the context too.
    if (this.carry) out.push({ role: "user", text: this.carry });
    return out;
  }

  restart(summary: string[], continueNow: boolean): void {
    this.messages = [];
    // Message-level overrides were in the removed history; re-append on the next configuration.
    if (this.supportsEffort) this.currentEffort = this.topEffort;
    this.effortAt.clear();
    this.lastPrompt = 0;
    if (continueNow) {
      this.carry = null;
      this.messages.push({ role: "user", content: summary.map((text) => ({ type: "text", text })) });
    } else {
      this.carry = summary.join("\n\n");
    }
  }

  setEffort(effort: Effort, top: Effort): void {
    if (!this.supportsEffort) return;
    this.topEffort ??= top;
    if (this.perMessageEffort && effort !== (this.currentEffort ?? this.topEffort)) {
      this.messages.push({ role: "system", content: [], output_config: { effort } });
    }
    // Models without message-level effort keep the first top-level value, even on overrides.
    this.currentEffort = this.perMessageEffort ? effort : this.topEffort;
  }

  addUserText(parts: string[], effort: Effort): void {
    if (this.compat) {
      // Thinking is switched per request ({type}), so a change needs no extra message.
      this.topEffort = this.currentEffort = effort;
      const blocks = [...(this.carry ? [this.carry] : []), ...parts].map((text) => ({ type: "text" as const, text }));
      this.carry = null;
      // After a mid-task compaction that was rolled back, the history ends with the summary: join it.
      const last = this.messages[this.messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && !last.content.some((b) => b.type === "tool_result")) {
        last.content.push(...blocks);
      } else {
        this.messages.push({ role: "user", content: blocks });
      }
      return;
    }
    this.setEffort(effort, this.topEffort ?? effort);
    const textParts = [...(this.carry ? [this.carry] : []), ...parts];
    this.carry = null;
    this.messages.push({ role: "user", content: textParts.map((text) => ({ type: "text", text })) });
  }

  async step(opts: StepOptions, h: StepHandlers): Promise<StepResult> {
    if (this.compat) return this.stepCompat(opts, h);
    const { signal } = opts;
    const betas: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];
    if (!this.legacy) betas.push("context-management-2025-06-27", "compact-2026-01-12");
    if (this.perMessageEffort) betas.push("mid-conversation-output-config-2026-07-01");

    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        ...(this.legacy
          ? {}
          : {
              thinking: { type: "adaptive", display: "summarized" } as const,
              ...(this.supportsEffort ? { output_config: { effort: this.topEffort ?? opts.effort } } : {}),
              context_management: CONTEXT_MANAGEMENT,
            }),
        system: this.system,
        tools: this.tools,
        messages: this.messages,
        // Caches the growing conversation tail; the system block carries its own breakpoint.
        cache_control: { type: "ephemeral" },
        betas,
        // On a safety decline, let the API retry on its recommended fallback model.
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("thinking", (d) => h.onThinking(d));
    stream.on("text", (d) => h.onText(d));
    streamToolCalls(stream, h);

    const msg = await stream.finalMessage();
    const u = msg.usage;
    const usage = {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    };
    this.lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite;
    const trimmed = trimmedBy(msg);
    const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const toolCalls = toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input }));

    if (msg.stop_reason === "refusal") return { stop: "refusal", toolCalls: [], usage, trimmed };
    if (msg.stop_reason === "max_tokens") {
      // A tool call cut off mid-input must never run, so that reply is not kept.
      if (toolUses.length === 0) this.messages.push({ role: "assistant", content: msg.content });
      return { stop: "max_tokens", toolCalls, usage, trimmed };
    }

    // The full content goes back unchanged: thinking, compaction and fallback blocks included.
    this.messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "pause_turn") return { stop: "continue", toolCalls: [], usage, trimmed };
    if (msg.stop_reason === "tool_use" && toolCalls.length) return { stop: "tool_use", toolCalls, usage, trimmed };
    return { stop: "end_turn", toolCalls: [], usage, trimmed };
  }

  /** One request to an Anthropic-compatible service, with only the parameters it documents. */
  private async stepCompat({ signal }: StepOptions, h: StepHandlers): Promise<StepResult> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: compatMaxTokens(this.model),
        system: this.system as Anthropic.TextBlockParam[],
        tools: this.tools as Anthropic.Tool[],
        messages: this.messages as Anthropic.MessageParam[],
        // "快速" turns thinking off; normal and deep think. No budget: the service decides how long.
        thinking: { type: this.currentEffort === "low" ? "disabled" : "enabled" },
      } as unknown as Anthropic.MessageStreamParams,
      { signal },
    );
    stream.on("thinking", (d) => h.onThinking(d));
    stream.on("text", (d) => h.onText(d));
    streamToolCalls(stream, h);
    const msg = await stream.finalMessage();
    const u = msg.usage;
    const usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    };
    this.lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite;
    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolCalls = toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input }));
    // MiMo adds two stop reasons: content_filter (declined) and repetition_truncation (cut off for repeating itself).
    const stop = msg.stop_reason as string;
    if (stop === "refusal" || stop === "content_filter") return { stop: "refusal", toolCalls: [], usage };
    if (stop === "max_tokens" || stop === "repetition_truncation") {
      if (toolUses.length === 0) this.messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
      return { stop: "max_tokens", toolCalls, usage };
    }
    // Thinking blocks go back unchanged too: the service works best with the full history.
    this.messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (stop === "tool_use" && toolCalls.length) return { stop: "tool_use", toolCalls, usage };
    return { stop: "end_turn", toolCalls: [], usage };
  }

  addToolResults(results: ToolResult[]): void {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }

  checkpoint(): number {
    // The summary is consumed by the next user message; a rolled-back turn must not lose it.
    this.effortAt.set(this.messages.length, { top: this.topEffort, current: this.currentEffort, carry: this.carry });
    return this.messages.length;
  }

  rollback(to: number): void {
    this.messages.length = to;
    const e = this.effortAt.get(to);
    if (e) {
      this.topEffort = e.top;
      this.currentEffort = e.current;
      this.carry = e.carry;
    }
  }

  exportState(): SavedState {
    return { messages: this.messages, topEffort: this.topEffort, currentEffort: this.currentEffort, carry: this.carry };
  }

  importState(state: unknown): void {
    const s = state as SavedState;
    this.messages = s.messages ?? [];
    this.topEffort = s.topEffort ?? null;
    this.currentEffort = s.currentEffort ?? null;
    this.carry = s.carry ?? null;
    this.effortAt.clear();
  }

  isAbort(err: unknown): boolean {
    return err instanceof Anthropic.APIUserAbortError;
  }

  describeError(err: unknown): string | null {
    if (this.compat) return this.describeCompatError(err);
    if (err instanceof Anthropic.AuthenticationError) {
      return this.login
        ? "Anthropic 账号的登录已经失效了。点左下角打开设置，重新登录一次吧。"
        : "Claude 的 API Key 不对或者已经失效了。点左下角重新填一个吧。";
    }
    if (err instanceof Anthropic.PermissionDeniedError) return "这个 API Key 没有权限使用这个模型。";
    if (err instanceof Anthropic.NotFoundError) return `找不到模型「${this.model}」，检查一下模型名称。`;
    if (err instanceof Anthropic.RateLimitError) return "请求太频繁了，休息一分钟再试。";
    if (err instanceof Anthropic.BadRequestError) return `请求格式有问题：${err.message}`;
    if (err instanceof Anthropic.InternalServerError) return "Claude 那边暂时有点忙，过一会儿再试。";
    if (err instanceof Anthropic.APIConnectionError) return "连不上 Claude。检查一下网络或代理设置。";
    if (err instanceof Anthropic.APIError) return `出错了（${err.status ?? "?"}）：${err.message}`;
    // The SDK refuses a credentials file other users could read (ant itself writes it as 600).
    if (this.login && err instanceof Anthropic.AnthropicError && /chmod 600/.test(err.message)) {
      const file = err.message.match(/at (\S+) is group/)?.[1];
      return `登录文件的权限不安全，为了保护你的账号已停止使用。在终端运行 chmod 600 ${file ?? "<登录文件>"} 就能修好。`;
    }
    // Raised before any request when the SDK finds no credentials at all (a plain Error).
    if (this.login && err instanceof Error && /Could not resolve authentication method/.test(err.message)) {
      return "还没有用 Anthropic 账号登录，或者登录已经过期。点左下角打开设置，点「在终端里登录」。";
    }
    return null;
  }

  private describeCompatError(err: unknown): string | null {
    const name = this.compat!.providerName;
    if (err instanceof Anthropic.AuthenticationError) return `${name} 的 Key 不对或已经失效。Token Plan 的 Key 是 tp- 或 ttp- 开头的，地址也要用订阅时给的专属地址。`;
    if (err instanceof Anthropic.PermissionDeniedError) return `这个 Key 没有权限使用模型「${this.model}」，看看套餐里包含哪些模型。`;
    if (err instanceof Anthropic.NotFoundError) return `找不到模型「${this.model}」，或者接口地址不对。检查一下设置。`;
    if (err instanceof Anthropic.RateLimitError) return `${name} 说请求太频繁，或者套餐这个周期的额度用完了。过一会儿再试。`;
    if (err instanceof Anthropic.BadRequestError) return `${name} 没接受这个请求：${err.message}`;
    if (err instanceof Anthropic.InternalServerError) return `${name} 那边暂时有点忙，过一会儿再试。`;
    if (err instanceof Anthropic.APIConnectionError) return `连不上 ${name}。检查一下网络和接口地址（国内用 token-plan-cn，海外用 sgp 或 ams）。`;
    if (err instanceof Anthropic.APIError) return `${name} 出错了（${err.status ?? "?"}）：${err.message}`;
    return null;
  }
}


/** What the server did to keep the context small during this request, if anything. */
function trimmedBy(msg: Anthropic.Beta.BetaMessage): Trimmed | undefined {
  if (msg.content.some((b) => b.type === "compaction")) return { how: "compacted" };
  const cleared = (msg.context_management?.applied_edits ?? []).reduce(
    (sum, e) => sum + ("cleared_input_tokens" in e ? e.cleared_input_tokens : 0),
    0,
  );
  return cleared > 0 ? { how: "cleared", tokens: cleared } : undefined;
}
