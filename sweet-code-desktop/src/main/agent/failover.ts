// Which model errors are worth moving to a backup model for, in the middle of a turn. Both SDKs
// (OpenAI, Anthropic) put the HTTP status on their errors and name connection failures alike, so
// this reads them without importing either.

/** Why switching helps, in words for the chat; null = another model wouldn't do better (or it was cancelled). */
export function failoverReason(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; name?: unknown; constructor?: { name?: string }; message?: unknown };
  const name = `${typeof e.name === "string" ? e.name : ""} ${e.constructor?.name ?? ""}`;
  if (/Abort/.test(name)) return null;
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 429) return "请求太频繁或额度用完了";
  if (status === 402) return "账户余额不足";
  if (status === 401 || status === 403) return "Key 无效或没有权限";
  if (status === 404) return "找不到这个模型";
  if (status === 408) return "请求超时";
  if (status !== undefined && status >= 500) return "服务暂时不可用";
  if (/Connection|Timeout/.test(name)) return "连不上服务";
  // fetch-level failures without a status.
  if (typeof e.message === "string" && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(e.message)) return "网络中断";
  return null;
}

/** Selected model first, then the untouched discovery order (deduplicated). */
export function orderedFailover(selected: string, models: readonly string[]): string[] {
  return [...new Set([selected, ...models].map(m => m.trim()).filter(m => m && m.toLowerCase() !== "auto"))];
}
