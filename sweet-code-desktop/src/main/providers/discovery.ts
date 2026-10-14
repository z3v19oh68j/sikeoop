import { createHash } from "node:crypto";
import { validOAuthToken } from "./claude-oauth.ts";
import { DefaultUserAgent, FullClaudeCodeMimicryBetas } from "./claude-mimic.ts";
import { validOAuthToken as validOpenAIToken } from "./openai-oauth.ts";
import { codexModelsRequest, parseCodexModels } from "./openai-codex.ts";

export const MODEL_CACHE_TTL = 6 * 60 * 60 * 1000;
export const MODEL_DISCOVERY_TIMEOUT = 10_000;
export interface DiscoveryProvider {
  id: string;
  kind: "openai" | "anthropic";
  baseURL: string;
  apiKey: string;
  fallback: readonly string[];
  /** Login mode: fetch the live subscription model list with the OAuth bearer (Claude, or ChatGPT for kind "openai"). */
  login?: boolean;
}

/** Preserve provider order; never treat the routing sentinel as a runnable model. */
export function modelIds(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string")
    .map(v => v.trim()).filter(v => v && v.toLowerCase() !== "auto"))];
}

/** Both protocols use data[].id; malformed/empty lists trigger static fallback. */
export function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) return [];
  return modelIds((payload as { data: unknown[] }).data.map(item =>
    item && typeof item === "object" ? (item as { id?: unknown }).id : undefined));
}

export function modelsURL(baseURL: string): string {
  const url = new URL(baseURL);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("无效的模型接口地址");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models";
  return url.href;
}

interface Entry { fingerprint: string; expires: number; ids: string[] }
interface Pending { fingerprint: string; promise: Promise<string[]> }
export class ModelDiscovery {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private request: typeof fetch;
  private now: () => number;
  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private fingerprint(p: DiscoveryProvider): string {
    // Keys are neither persisted nor returned/logged; credential changes invalidate cached ids.
    return createHash("sha256").update(JSON.stringify([p.kind, p.baseURL, p.apiKey, p.fallback, !!p.login])).digest("hex");
  }
  cached(p: DiscoveryProvider): string[] | undefined {
    const entry = this.cache.get(p.id);
    return entry && entry.fingerprint === this.fingerprint(p) && this.now() < entry.expires ? [...entry.ids] : undefined;
  }
  invalidate(id: string): void { this.cache.delete(id); this.pending.delete(id); }
  async discover(p: DiscoveryProvider): Promise<string[]> {
    const hit = this.cached(p);
    if (hit) return hit;
    const fingerprint = this.fingerprint(p);
    const running = this.pending.get(p.id);
    if (running?.fingerprint === fingerprint) return [...await running.promise];
    const promise = this.load(p, fingerprint);
    const pending = { fingerprint, promise };
    this.pending.set(p.id, pending);
    try { return [...await promise]; }
    finally { if (this.pending.get(p.id) === pending) this.pending.delete(p.id); }
  }
  private async load(p: DiscoveryProvider, fingerprint: string): Promise<string[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let success = false;
    let ids: string[];
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("模型发现超时")); }, MODEL_DISCOVERY_TIMEOUT);
    });
    try {
      ids = await Promise.race([this.pages(p, controller.signal), timeout]);
      if (!ids.length) throw new Error("模型列表为空");
      success = true;
    } catch {
      // Do not expose transport errors: they can contain addresses, headers or credentials.
      ids = modelIds(p.fallback);
    } finally { clearTimeout(timer); }
    if (this.pending.get(p.id)?.fingerprint === fingerprint)
      this.cache.set(p.id, { fingerprint, ids, expires: this.now() + (success ? MODEL_CACHE_TTL : 60_000) });
    return ids;
  }
  /** ChatGPT subscription: one unpaged list from the Codex endpoint, whatever the provider's API address is. */
  private async codexModels(signal: AbortSignal): Promise<string[]> {
    const token = await validOpenAIToken();
    if (!token) throw new Error("OpenAI OAuth 未登录");
    const { url, headers } = codexModelsRequest(token);
    const response = await this.request(url, { method: "GET", headers, signal, redirect: "error" });
    if (!response.ok) throw new Error("模型列表请求失败");
    return modelIds(parseCodexModels(await response.json()));
  }
  private async pages(p: DiscoveryProvider, signal: AbortSignal): Promise<string[]> {
    if (p.kind === "openai" && p.login) return this.codexModels(signal);
    const url = new URL(modelsURL(p.baseURL));
    let headers: Record<string, string>;
    if (p.kind === "anthropic" && p.login) {
      const token = await validOAuthToken();
      if (!token) throw new Error("Claude OAuth 未登录");
      headers = {
        Authorization: `Bearer ${token.access_token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FullClaudeCodeMimicryBetas().join(","),
        "User-Agent": DefaultUserAgent(),
      };
    } else if (p.kind === "anthropic") {
      headers = { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" };
    } else {
      headers = { Authorization: `Bearer ${p.apiKey}` };
    }
    const ids: string[] = [];
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = await this.request(url.href, { method: "GET", headers, signal, redirect: "error" });
      if (!response.ok) throw new Error("模型列表请求失败");
      const payload = await response.json();
      const batch = parseModelList(payload);
      if (!batch.length) throw new Error("无效的模型列表");
      ids.push(...batch);
      if (payload.has_more !== true) return modelIds(ids);
      const cursor = typeof payload.last_id === "string" ? payload.last_id : batch.at(-1)!;
      if (cursors.has(cursor)) throw new Error("重复的模型分页");
      cursors.add(cursor);
      url.searchParams.set("after_id", cursor);
    }
    throw new Error("模型分页过多");
  }
}
