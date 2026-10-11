import OpenAI from "openai";
import type { Balance } from "@shared/types";
import type { ResolvedProvider } from "./store";

// DeepSeek features beyond chat: account balance and fill-in-the-middle completion.

/** GET /user/balance. */
export async function getBalance(p: ResolvedProvider): Promise<Balance> {
  if (!p.apiKey) throw new Error(`先填好 ${p.preset.name} 的 API Key`);
  const res = await fetch(`${p.baseURL.replace(/\/+$/, "")}/user/balance`, {
    headers: { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" },
  });
  if (res.status === 401) throw new Error("API Key 不对，查不到余额");
  if (!res.ok) throw new Error(`查询余额失败（${res.status}）`);
  const body = (await res.json()) as {
    is_available: boolean;
    balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[];
  };
  return {
    available: body.is_available,
    items: (body.balance_infos ?? []).map((b) => ({
      currency: b.currency,
      total: b.total_balance,
      granted: b.granted_balance,
      toppedUp: b.topped_up_balance,
    })),
  };
}

/** Prefix / suffix sent per completion; enough context without paying for the whole file each keystroke. */
const MAX_PREFIX = 6000;
const MAX_SUFFIX = 2000;

let inflight: AbortController | null = null;

/**
 * Fill-in-the-middle at <baseURL>/beta. Each new request cancels the previous one, so typing
 * quickly never piles up requests. Returns "" when there is nothing useful to suggest.
 */
export async function fimComplete(p: ResolvedProvider, prefix: string, suffix: string): Promise<string> {
  if (!p.apiKey || !p.preset.fimModel) return "";
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  const client = new OpenAI({ apiKey: p.apiKey, baseURL: `${p.baseURL.replace(/\/+$/, "")}/beta`, maxRetries: 0 });
  try {
    const res = await client.completions.create(
      {
        model: p.preset.fimModel,
        prompt: prefix.slice(-MAX_PREFIX),
        suffix: suffix.slice(0, MAX_SUFFIX),
        max_tokens: 128,
        // Stop at a blank line: a suggestion should finish the current thought, not write the next function.
        stop: ["\n\n\n"],
      },
      { signal: controller.signal, timeout: 15_000 },
    );
    return res.choices[0]?.text ?? "";
  } catch {
    // Autocomplete is best-effort: a cancelled or failed request just shows no suggestion.
    return "";
  } finally {
    if (inflight === controller) inflight = null;
  }
}
