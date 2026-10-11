import type { ContextPartKey, ContextUsage } from "@shared/types";
import type { HistoryEntry, ToolDef } from "../providers/types";

// What fills the context window. Each part is estimated from its text, then all parts are
// scaled so they add up to the prompt size the provider actually measured.

/** Rough tokens: CJK characters are about one token each, other text about 3.5 characters. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk++;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

/** Blocks the app adds to user messages: overview, rules, memory, retrieved code, summaries… */
const INJECTED = /<(project|project_rules|skills|memory|relevant_memory|retrieved_code|conversation_summary|state|hook_context|hook_feedback|editor|attached_file|image_analysis|note|autopilot)\b[^>]*>[\s\S]*?<\/\1>/g;

export function contextUsage(opts: {
  system: string;
  tools: ToolDef[];
  history: HistoryEntry[];
  /** Measured prompt tokens, or 0 when there is no measurement yet. */
  measured: number;
  budget: number;
  window: number;
}): ContextUsage {
  const est: Record<ContextPartKey, number> = { system: 0, tools: 0, context: 0, messages: 0, toolResults: 0, thinking: 0 };
  est.system = estimateTokens(opts.system);
  est.tools = estimateTokens(JSON.stringify(opts.tools));
  for (const e of opts.history) {
    if (e.role === "user") {
      let rest = e.text;
      for (const m of e.text.matchAll(INJECTED)) {
        est.context += estimateTokens(m[0]);
        rest = rest.replace(m[0], "");
      }
      est.messages += estimateTokens(rest);
    } else if (e.role === "assistant") {
      est.messages += estimateTokens(e.text) + (e.calls ?? []).reduce((n, c) => n + estimateTokens(JSON.stringify(c.input) ?? ""), 0);
      // Roughly: thinking text is tokenized like prose.
      est.thinking += Math.ceil((e.thinkingChars ?? 0) / 2.5);
    } else {
      est.toolResults += estimateTokens(e.text);
    }
  }
  const total = Object.values(est).reduce((a, b) => a + b, 0) || 1;
  const used = opts.measured > 0 ? opts.measured : total;
  const scale = used / total;
  const parts = (Object.keys(est) as ContextPartKey[]).map((key) => ({ key, tokens: Math.round(est[key] * scale) }));
  return { used, budget: opts.budget, window: opts.window, estimated: opts.measured <= 0, parts };
}
