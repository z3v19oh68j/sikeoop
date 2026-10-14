import type { CodexQuotaResult, OpenAIAccount } from "@shared/types";
import { listAccounts, validAccountToken, validOAuthToken } from "./openai-oauth.ts";
import { cachedCodexQuota, CodexQuotaCache } from "./openai-codex.ts";

// The shared quota cache holds one credential. Accounts that are not in use each get their own,
// so listing them neither refetches every time nor evicts the current account's entry.
const caches = new Map<string, CodexQuotaCache>();

async function usageOf(id: string, active: boolean): Promise<CodexQuotaResult> {
  try {
    if (active) return await cachedCodexQuota(await validOAuthToken());
    let cache = caches.get(id);
    if (!cache) caches.set(id, cache = new CodexQuotaCache());
    return await cache.get(await validAccountToken(id));
  } catch (err) {
    // The cache only lets its own fixed messages through; a login refresh failure gets a plain one.
    const message = (err instanceof Error && err.message) || "";
    return { error: /ChatGPT/.test(message) ? message : "ChatGPT 额度查询失败" };
  }
}

/** Every logged-in ChatGPT account with its quota, the one in use first. Never carries a token. */
export async function openaiAccounts(): Promise<OpenAIAccount[]> {
  const accounts = listAccounts();
  for (const id of caches.keys()) if (!accounts.some(a => a.id === id && !a.active)) caches.delete(id);
  return Promise.all(accounts.map(async a => ({ ...a, usage: await usageOf(a.id, a.active) })));
}
