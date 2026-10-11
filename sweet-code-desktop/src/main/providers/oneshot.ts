import OpenAI from "openai";
import { withAutoFailover } from "./model-routing.ts";
import type { EffortPurpose } from "../../shared/types.ts";
import { selectEffort } from "../agent/route.ts";
import { claudeEffortParams } from "./effort.ts";
import { anthropicClient } from "./index";
import { installId, routing, type ResolvedProvider } from "./store";
import { fromAnthropic, fromOpenAI, reportUsage } from "../usage/ledger";
import { toStepUsage } from "./openai-responses";

const source = (p: ResolvedProvider) => ({ providerId: p.preset.id, providerName: p.preset.name, model: p.model });

/**
 * One plain request (system + one user message → text), for helpers that work beside the main
 * conversation: the compression sub-agent. Thinking is turned off where the provider allows it.
 */
async function completeRequest(
  p: ResolvedProvider,
  system: string,
  user: string,
  opts: { maxTokens: number; signal: AbortSignal; purpose?: EffortPurpose },
): Promise<string> {
  if (p.preset.kind === "anthropic") {
    const res = await anthropicClient(p).messages.create(
      {
        model: p.model,
        max_tokens: opts.maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...claudeEffortParams(p.preset.kind, p.model, p.preset.compat, selectEffort(opts.purpose ?? "subtask", routing().effort)),
        ...(p.preset.compat ? { thinking: { type: "disabled" as const } } : {}),
      },
      { signal: opts.signal },
    );
    reportUsage(source(p), fromAnthropic(res.usage));
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  }
  const client = new OpenAI({ apiKey: p.apiKey || "not-needed", baseURL: p.baseURL });
  if (p.openaiApi === "responses") {
    const res = await client.responses.create(
      { model: p.model, max_output_tokens: opts.maxTokens, instructions: system, input: user, store: false, reasoning: { effort: "low" } },
      { signal: opts.signal },
    );
    reportUsage(source(p), toStepUsage(res.usage));
    return res.output_text.trim();
  }
  const res = await client.chat.completions.create(
    {
      model: p.model,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(p.preset.reasoningEffort ? { thinking: { type: "disabled" } } : {}),
      ...(p.preset.userId ? { user_id: installId() } : {}),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming,
    { signal: opts.signal },
  );
  reportUsage(source(p), fromOpenAI(res.usage as unknown as Record<string, unknown>));
  return res.choices[0]?.message?.content?.trim() ?? "";
}

/** Like complete(), but hands over the text as it arrives. Returns the whole reply. */
async function streamRequest(
  p: ResolvedProvider,
  system: string,
  user: string,
  onDelta: (text: string) => void,
  opts: { maxTokens: number; signal: AbortSignal; purpose?: EffortPurpose },
): Promise<string> {
  let out = "";
  if (p.preset.kind === "anthropic") {
    const s = anthropicClient(p).messages.stream(
      {
        model: p.model,
        max_tokens: opts.maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...claudeEffortParams(p.preset.kind, p.model, p.preset.compat, selectEffort(opts.purpose ?? "subtask", routing().effort)),
        ...(p.preset.compat ? { thinking: { type: "disabled" as const } } : {}),
      },
      { signal: opts.signal },
    );
    try {
      for await (const ev of s) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          out += ev.delta.text;
          onDelta(ev.delta.text);
        }
      }
    } finally {
      // Counted even when stopped part-way: those tokens were used.
      reportUsage(source(p), fromAnthropic(s.currentMessage?.usage));
    }
    return out.trim();
  }
  const client = new OpenAI({ apiKey: p.apiKey || "not-needed", baseURL: p.baseURL });
  if (p.openaiApi === "responses") {
    const rs = await client.responses.create(
      { model: p.model, max_output_tokens: opts.maxTokens, instructions: system, input: user, store: false, stream: true, reasoning: { effort: "low" } },
      { signal: opts.signal },
    );
    let ru: OpenAI.Responses.ResponseUsage | undefined;
    try {
      for await (const ev of rs) {
        if (ev.type === "response.output_text.delta") {
          out += ev.delta;
          onDelta(ev.delta);
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") ru = ev.response.usage ?? undefined;
      }
    } finally {
      reportUsage(source(p), toStepUsage(ru));
    }
    return out.trim();
  }
  const s = await client.chat.completions.create(
    {
      model: p.model,
      max_tokens: opts.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(p.preset.reasoningEffort ? { thinking: { type: "disabled" } } : {}),
      ...(p.preset.userId ? { user_id: installId() } : {}),
    } as OpenAI.ChatCompletionCreateParamsStreaming,
    { signal: opts.signal },
  );
  let usage: Record<string, unknown> | undefined;
  try {
    for await (const chunk of s) {
      if (chunk.usage) usage = chunk.usage as unknown as Record<string, unknown>;
      const d = chunk.choices[0]?.delta?.content;
      if (d) {
        out += d;
        onDelta(d);
      }
    }
  } finally {
    reportUsage(source(p), fromOpenAI(usage));
  }
  return out.trim();
}

export async function complete(p: ResolvedProvider, system: string, user: string,
  opts: { maxTokens: number; signal: AbortSignal; purpose?: EffortPurpose }): Promise<string> {
  // Built-in free providers sit behind relays that drop a long silent request (a big prompt
  // without streaming is cut after ~17 s); streaming keeps bytes flowing, and nothing is shown yet,
  // so a failure can still move to the next model.
  return withAutoFailover(p, opts.purpose ?? "subtask", opts.signal,
    resolved => resolved.preset.builtinFree
      ? streamRequest(resolved, system, user, () => {}, opts)
      : completeRequest(resolved, system, user, opts));
}

export async function stream(p: ResolvedProvider, system: string, user: string, onDelta: (text: string) => void,
  opts: { maxTokens: number; signal: AbortSignal; purpose?: EffortPurpose }): Promise<string> {
  let emitted = false;
  return withAutoFailover(p, opts.purpose ?? "subtask", opts.signal,
    resolved => streamRequest(resolved, system, user, text => { emitted = true; onDelta(text); }, opts),
    () => !emitted);
}
