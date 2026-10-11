import type { ProviderHealth } from "../../shared/types.ts";
import { failoverReason } from "../agent/failover.ts";

// The last outcome of each provider's model calls, for the settings screen. In memory only: a
// restart starts every provider fresh, and a provider that has never been called has no entry.

const health = new Map<string, ProviderHealth>();

/** A 429 that talks about money or limits is an exhausted quota, not a burst. */
const QUOTA = /quota|insufficient|balance|credit|billing|exceeded your|额度|余额|用尽|用完/i;

export function classifyFailure(err: unknown): ProviderHealth["status"] | null {
  if (!failoverReason(err)) return null;
  const e = err as { status?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (e.status === 402) return "quota";
  if (e.status === 429) return QUOTA.test(message) ? "quota" : "rate_limited";
  return "error";
}

export function recordSuccess(providerId: string, now = Date.now()): void {
  health.set(providerId, { status: "ok", at: now });
}

/** Errors another model wouldn't fix (cancellations, bad requests) leave the status as it was. */
export function recordFailure(providerId: string, err: unknown, now = Date.now()): void {
  const status = classifyFailure(err);
  if (!status) return;
  health.set(providerId, { status, at: now, message: failoverReason(err) ?? undefined });
}

export function providerHealth(providerId: string): ProviderHealth | undefined {
  return health.get(providerId);
}

export function resetProviderHealth(): void {
  health.clear();
}
