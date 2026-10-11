import type { EffortPurpose, RoutingSettings } from "../../shared/types.ts";
import type { ResolvedProvider } from "./store.ts";
import { selectAutoModel } from "../agent/route.ts";
import { failoverReason, orderedFailover } from "../agent/failover.ts";
import { ModelDiscovery, modelIds, type DiscoveryProvider } from "./discovery.ts";
import { recordFailure, recordSuccess } from "./health.ts";

export const modelDiscovery = new ModelDiscovery();
interface BuiltinPoolSource {
  providers(): ResolvedProvider[];
  order(): RoutingSettings["builtinFreeOrder"];
}
// Injection keeps the routing engine independent of Electron and available to native Node tests.
let builtinSource: BuiltinPoolSource = { providers: () => [], order: () => undefined };
export function configureBuiltinFreePool(source: BuiltinPoolSource): void { builtinSource = source; }

export function builtinFreeOrder(value: unknown): RoutingSettings["builtinFreeOrder"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("builtinFreeOrder 设置无效");
  const out: NonNullable<RoutingSettings["builtinFreeOrder"]> = {};
  for (const purpose of ["chat", "coding", "hard", "compress", "subtask"] as const) {
    const ids = (value as Record<string, unknown>)[purpose];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim()))
      throw new Error(`builtinFreeOrder.${purpose} 必须是服务商 ID 数组`);
    out[purpose] = [...new Set((ids as string[]).map(id => id.trim()))];
  }
  return out;
}

function discoveryInput(p: ResolvedProvider): DiscoveryProvider {
  return { id: p.preset.id, kind: p.preset.kind, baseURL: p.baseURL, apiKey: p.apiKey,
    fallback: modelIds([...p.preset.suggestedModels, p.preset.defaultModel]) };
}
export function discoverProviderModels(p: ResolvedProvider): Promise<string[]> {
  if (p.enabled === false) return Promise.resolve([]);
  return modelDiscovery.discover(discoveryInput(p));
}
export function availableModels(p: ResolvedProvider): string[] {
  if (p.enabled === false) return [];
  const input = discoveryInput(p);
  return modelDiscovery.cached(input) ?? modelIds(input.fallback);
}

/** Disabled entries never enter discovery or retry; incomplete entries cannot run. */
function poolProviders(p: ResolvedProvider, purpose: EffortPurpose): ResolvedProvider[] {
  if (!p.preset.builtinFree || p.model !== "auto") return p.enabled === false ? [] : [p];
  const configured = builtinSource.providers();
  const entries = configured.some(x => x.preset.id === p.preset.id) ? configured : [p, ...configured];
  const ready = entries.filter(x => x.preset.builtinFree && x.enabled !== false && x.baseURL
    && (!x.preset.needsKey || x.apiKey));
  const ids = builtinSource.order()?.[purpose] ?? [];
  return [...ids.flatMap(id => ready.filter(x => x.preset.id === id)), ...ready.filter(x => !ids.includes(x.preset.id))]
    .filter((x, i, all) => all.findIndex(y => y.preset.id === x.preset.id) === i)
    .map(x => ({ ...x, model: "auto" }));
}

/** Every supplier selects for the same purpose, then preserves its own discovery fallback order. */
export function autoCandidatesCached(p: ResolvedProvider, purpose: EffortPurpose): ResolvedProvider[] {
  if (p.model !== "auto") return p.enabled === false ? [] : [p];
  return poolProviders(p, purpose).flatMap(provider => {
    const ids = availableModels(provider);
    const selected = selectAutoModel(ids, purpose);
    return selected ? orderedFailover(selected, ids).map(model => ({ ...provider, model })) : [];
  });
}

/** Only missing-model errors may be repaired by another model on the same supplier. */
export function providerWideFailure(err: unknown): boolean {
  return !!failoverReason(err) && (err as { status?: unknown }).status !== 404;
}

/** Main-session retries only go forwards across the configured supplier order. */
export function autoFailoverCandidates(p: ResolvedProvider, purpose: EffortPurpose, err?: unknown): ResolvedProvider[] {
  const candidates = autoCandidatesCached({ ...p, model: "auto" }, purpose);
  const first = candidates.findIndex(x => x.preset.id === p.preset.id);
  if (first < 0) return candidates;
  const after = candidates.slice(first);
  return p.preset.builtinFree && providerWideFailure(err) ? after.filter(x => x.preset.id !== p.preset.id) : after;
}

export function resolveAutoCached(p: ResolvedProvider, purpose: EffortPurpose = "coding"): ResolvedProvider {
  if (p.enabled === false && (!p.preset.builtinFree || p.model !== "auto")) throw new Error("服务商已关闭");
  if (p.model !== "auto") return p;
  const selected = autoCandidatesCached(p, purpose)[0];
  if (!selected) throw new Error(`服务商「${p.preset.name}」没有可用模型，请获取模型列表或手动设置模型`);
  return selected;
}
export async function prepareAutoDiscovery(p: ResolvedProvider, purpose: EffortPurpose, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (p.model === "auto") await Promise.all(poolProviders(p, purpose).map(discoverProviderModels));
  else if (p.preset.discoverModels) await discoverProviderModels(p);
  signal.throwIfAborted();
}
export async function resolveAuto(p: ResolvedProvider, purpose: EffortPurpose, signal: AbortSignal): Promise<ResolvedProvider> {
  await prepareAutoDiscovery(p, purpose, signal);
  return resolveAutoCached(p, purpose);
}

/** Side jobs and stream retries share the main-session pool and eligibility rules. */
export async function withAutoFailover<T>(p: ResolvedProvider, purpose: EffortPurpose, signal: AbortSignal,
  call: (resolved: ResolvedProvider) => Promise<T>, canRetry: () => boolean = () => true): Promise<T> {
  const selected = await resolveAuto(p, purpose, signal);
  const candidates = p.model === "auto" ? autoCandidatesCached(p, purpose) : [selected];
  const unavailable = new Set<string>();
  const allowed = (candidate: ResolvedProvider) => !unavailable.has(candidate.preset.id)
    && (!p.preset.builtinFree || p.model !== "auto" || poolProviders(p, purpose).some(x => x.preset.id === candidate.preset.id));
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!allowed(candidate)) continue;
    signal.throwIfAborted();
    try {
      const result = await call(candidate);
      recordSuccess(candidate.preset.id);
      return result;
    } catch (err) {
      lastError = err;
      if (!signal.aborted) recordFailure(candidate.preset.id, err);
      if (signal.aborted || !canRetry() || !failoverReason(err)) throw err;
      if (p.preset.builtinFree && providerWideFailure(err)) unavailable.add(candidate.preset.id);
      if (!candidates.slice(i + 1).some(allowed)) throw err;
    }
  }
  if (lastError !== undefined) throw lastError;
  throw new Error("没有可用模型");
}
