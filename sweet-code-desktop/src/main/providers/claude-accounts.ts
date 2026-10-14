import type { ClaudeAccount, ClaudeUsageResult } from "@shared/types";
import { listAccounts, validAccountToken, validOAuthToken } from "./claude-oauth.ts";
import { ClaudeUsageCache, claudeUsageWithPassiveFallback } from "./claude-usage.ts";

// The shared usage cache holds one credential. Accounts that are not in use each get their own,
// so listing them neither refetches every time nor evicts the current account's entry.
const caches = new Map<string, ClaudeUsageCache>();

async function usageOf(id: string, active: boolean): Promise<ClaudeUsageResult> {
  try {
    const token = active ? await validOAuthToken() : await validAccountToken(id);
    if (!token) return { error: "Claude OAuth 未登录" };
    if (active) return await claudeUsageWithPassiveFallback(token.access_token);
    let cache = caches.get(id);
    if (!cache) caches.set(id, cache = new ClaudeUsageCache());
    return await cache.get(token.access_token);
  } catch (err) {
    return { error: (err instanceof Error && err.message) || "Claude 用量查询失败" };
  }
}

/** Every logged-in Claude account with its usage, the one in use first. Never carries a token. */
export async function claudeAccounts(): Promise<ClaudeAccount[]> {
  const accounts = listAccounts();
  for (const id of caches.keys()) if (!accounts.some(a => a.id === id && !a.active)) caches.delete(id);
  return Promise.all(accounts.map(async a => ({ ...a, usage: await usageOf(a.id, a.active) })));
}
