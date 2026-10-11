import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import { DECISION_MODELS, type AuthMode, type OpenAIApi, type DecisionState, type DecisionUpdate, type ProviderUpdate, type ProvidersState, type ProviderView, type ReviewerSetting, type RoutingSettings, type ModelRef, type VisionSetting, type WebSearchState } from "@shared/types";
import { loginStatus } from "./anthropic-login";
import { PRESETS, type ProviderPreset } from "./presets";
import { effortOverrides } from "../agent/route.ts";
import { modelDiscovery, availableModels, configureBuiltinFreePool, builtinFreeOrder } from "./model-routing.ts";
import { providerHealth } from "./health.ts";
import { supportsClaudeEffort } from "./effort.ts";

// Provider settings live in two files under the app's userData folder:
//   providers.json      — active provider, edited base URLs and models (plain JSON)
//   provider-keys.bin   — API keys, encrypted with the OS keychain via safeStorage
// Keys stay in the main process. The renderer can set or clear them, never read them.

/** A provider the user added: any OpenAI- or Anthropic-compatible endpoint (a relay, a company gateway…). */
interface CustomProvider {
  id: string;
  name: string;
  kind: "openai" | "anthropic";
}

interface Settings {
  activeId: string;
  overrides: Record<
    string,
    {
      enabled?: boolean;
      baseURL?: string;
      model?: string;
      authMode?: AuthMode;
      /** More models this key can use, offered as group-chat members (a relay serves many). */
      models?: string[];
      /** Only stored when the user picked Chat Completions over the Responses API. */
      openaiApi?: OpenAIApi;
    }
  >;
  /** Providers the user added, beside the built-in ones. */
  customs?: CustomProvider[];
  /** The web_search engine. "auto": whichever key is set (Tavily, then Brave), else DuckDuckGo. */
  webSearch?: { engine: WebSearchEngine };
  vision?: VisionSetting;
  /** Long-task reviewer. Absent = the conversation's own provider and model. */
  reviewer?: ReviewerSetting;
  /** Editor autocomplete (DeepSeek FIM). */
  completion?: boolean;
  /** Decision model (Jev via TokenDance). Its key is keys[DECISION_KEY]. */
  decision?: { model: string };
  /** Anonymous, stable id sent as `user_id` where supported (cache and rate-limit isolation). */
  installId?: string;
  routing?: RoutingSettings;
}

type WebSearchEngine = "auto" | "duckduckgo" | "tavily" | "brave";
/** Web search keys live in the key file under these names. */
const SEARCH_KEY = { tavily: "search-tavily", brave: "search-brave" } as const;

/** Where the TokenDance key lives in the key file; the env var is the fallback. */
const DECISION_KEY = "tokendance";
const DECISION_ENV = "TOKENDANCE_API_KEY";

/** Images are read by DeepSeek's vision model unless the user picks another one. */
const DEFAULT_VISION: VisionSetting = { providerId: "deepseek", model: "deepseek-flash" };

const settingsFile = () => path.join(app.getPath("userData"), "providers.json");
const keysFile = () => path.join(app.getPath("userData"), "provider-keys.bin");
/** Written by the first version, which only knew about Claude. */
const legacyKeyFile = () => path.join(app.getPath("userData"), "api-key.bin");

/** New installs start on MiMo, which works without a key thanks to the built-in one. */
const DEFAULT_PROVIDER = "mimo";
let settings: Settings = { activeId: DEFAULT_PROVIDER, overrides: {} };
let keys: Record<string, string> = {};

export async function load(): Promise<void> {
  try {
    settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile(), "utf8")) };
  } catch {
    // First run: keep defaults.
  }
  if (!allPresets().some((p) => p.id === settings.activeId)) settings.activeId = DEFAULT_PROVIDER;
  if (!settings.installId) {
    settings.installId = `sweet-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveSettings();
  }
  try {
    keys = JSON.parse(safeStorage.decryptString(await fs.readFile(keysFile())));
  } catch {
    keys = {};
  }
  try {
    const legacy = safeStorage.decryptString(await fs.readFile(legacyKeyFile()));
    if (legacy && !keys.anthropic) {
      keys.anthropic = legacy;
      await saveKeys();
    }
    await fs.rm(legacyKeyFile(), { force: true });
  } catch {
    // No legacy key.
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

async function saveKeys() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("这台电脑的系统钥匙串不可用，没法安全保存 Key");
  await fs.mkdir(path.dirname(keysFile()), { recursive: true });
  await fs.writeFile(keysFile(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
}

function customPreset(c: CustomProvider): ProviderPreset {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    // Anthropic-compatible endpoints from others get the plain Messages API only.
    ...(c.kind === "anthropic" ? { compat: true } : {}),
    baseURL: "",
    defaultModel: "",
    suggestedModels: [],
    keyHint: c.kind === "anthropic" ? "填服务商给的「Anthropic 兼容」接口地址和 Key" : "填服务商给的「OpenAI 兼容」接口地址和 Key（一般以 /v1 结尾）",
    needsKey: true,
  };
}

/** Built-in providers, then the ones the user added. */
function allPresets(): ProviderPreset[] {
  return [...PRESETS, ...(settings.customs ?? []).map(customPreset)];
}

/** The provider is still known (built in, or a custom one not removed). */
export function exists(id: string): boolean {
  return allPresets().some((p) => p.id === id);
}

function preset(id: string): ProviderPreset {
  const p = allPresets().find((x) => x.id === id);
  if (!p) throw new Error(`未知的服务商：${id}`);
  return p;
}

/** Everything needed to build an adapter, including the key. Main process only. */
export interface ResolvedProvider {
  /** Explicitly false only for disabled built-in free providers. */
  enabled?: boolean;
  preset: ProviderPreset;
  baseURL: string;
  model: string;
  apiKey: string;
  /** "login": authenticate with the Anthropic account profile instead of a key. */
  authMode: AuthMode;
  openaiApi: OpenAIApi;
}

export function resolve(id: string): ResolvedProvider {
  const p = preset(id);
  const o = settings.overrides[id] ?? {};
  const baseURL = o.baseURL ?? p.baseURL;
  return {
    preset: p,
    enabled: p.builtinFree ? o.enabled !== false : true,
    baseURL,
    model: o.model ?? p.defaultModel,
    // The user's own key first, then the environment.
    apiKey: keys[id] || (p.envKey ? process.env[p.envKey] : undefined) || p.builtinKey || "",
    authMode: p.kind === "anthropic" && !p.compat ? (o.authMode ?? "api_key") : "api_key",
    openaiApi: p.responses ? (o.openaiApi ?? "responses") : "chat",
  };
}

/** The vision model's provider, with the vision model in place of the provider's chat model. */
export function resolveVision(): ResolvedProvider {
  const v = settings.vision ?? DEFAULT_VISION;
  return { ...resolve(allPresets().some((p) => p.id === v.providerId) ? v.providerId : DEFAULT_VISION.providerId), model: v.model };
}

export async function setVision(v: VisionSetting): Promise<ProvidersState> {
  preset(v.providerId);
  settings.vision = { providerId: v.providerId, model: v.model.trim() };
  await saveSettings();
  return state();
}

/**
 * The reviewer's provider and model. null = review with the conversation's own provider, which
 * the caller resolves (it may differ from the active one in a reopened conversation).
 */
export function resolveReviewer(): ResolvedProvider | null {
  const r = settings.reviewer;
  if (!r?.providerId || !allPresets().some((p) => p.id === r.providerId)) return null;
  const p = resolve(r.providerId);
  return { ...p, model: r.model || p.model };
}

export async function setReviewer(r: ReviewerSetting): Promise<ProvidersState> {
  if (r.providerId) preset(r.providerId);
  settings.reviewer = r.providerId ? { providerId: r.providerId, model: r.model.trim() } : undefined;
  await saveSettings();
  return state();
}

/** Shipped with the app so everyone can use the decision model for free; the user's own key wins. */
const BUILTIN_DECISION_KEY = typeof __SIKEOOP_JEV_KEY__ === "string" ? __SIKEOOP_JEV_KEY__ : "";

/** The decision model and its key: the user's own, else the environment's, else the built-in one. Main process only. */
export function resolveDecision(): { model: string; apiKey: string } {
  return { model: settings.decision?.model || DECISION_MODELS[0].id, apiKey: keys[DECISION_KEY] || process.env[DECISION_ENV] || BUILTIN_DECISION_KEY };
}

function decisionState(): DecisionState {
  return {
    model: resolveDecision().model,
    hasKey: Boolean(resolveDecision().apiKey),
    keySource: keys[DECISION_KEY] ? "saved" : process.env[DECISION_ENV] ? "env" : BUILTIN_DECISION_KEY ? "builtin" : "none",
  };
}

export async function setDecision(u: DecisionUpdate): Promise<ProvidersState> {
  if (u.model !== undefined) {
    const m = u.model.trim();
    if (!m) throw new Error("请选一个决策模型");
    settings.decision = { model: m };
    await saveSettings();
  }
  if (u.apiKey?.trim()) {
    keys[DECISION_KEY] = u.apiKey.trim();
    await saveKeys();
  }
  return state();
}

export async function clearDecisionKey(): Promise<ProvidersState> {
  delete keys[DECISION_KEY];
  await saveKeys();
  return state();
}

const isReady = (r: ResolvedProvider) => Boolean(r.enabled !== false && r.model && r.baseURL && (r.authMode === "login" || !r.preset.needsKey || r.apiKey));

export function installId(): string {
  return settings.installId ?? "sweet-app";
}

export function completionEnabled(): boolean {
  return settings.completion ?? false;
}

export async function setCompletion(enabled: boolean): Promise<ProvidersState> {
  settings.completion = enabled;
  await saveSettings();
  return state();
}

export function activeId(): string {
  return settings.activeId;
}

async function view(p: ProviderPreset): Promise<ProviderView> {
  const r = resolve(p.id);
  const keySource = keys[p.id] ? "saved" : (p.envKey && process.env[p.envKey]) || p.builtinKey ? "env" : "none";
  return {
    authMode: r.authMode,
    supportsEffort: (p.kind === "anthropic" && !p.compat && supportsClaudeEffort(r.model)) || !!p.reasoningEffort || !!p.thinkingToggle,
    hasBalance: !!p.balance,
    ...(p.kind === "anthropic" && !p.compat ? { login: await loginStatus() } : {}),
    id: p.id,
    ...(p.builtinFree ? { builtinFree: true, enabled: r.enabled !== false } : {}),
    ...(providerHealth(p.id) ? { health: providerHealth(p.id) } : {}),
    name: p.name,
    kind: p.kind,
    baseURL: r.baseURL,
    model: r.model,
    suggestedModels: ["auto", ...availableModels(r)],
    keyHint: p.keyHint,
    needsKey: p.needsKey,
    hasKey: keySource !== "none",
    keySource,
    models: settings.overrides[p.id]?.models ?? [],
    custom: p.id.startsWith("custom-"),
    ...(p.responses ? { openaiApi: r.openaiApi } : {}),
  };
}

export async function state(): Promise<ProvidersState> {
  const v = settings.vision ?? DEFAULT_VISION;
  const reviewer = resolveReviewer();
  return {
    providers: await Promise.all(allPresets().map(view)),
    activeId: settings.activeId,
    vision: { ...v, ready: isReady(resolveVision()) },
    reviewer: {
      providerId: reviewer ? reviewer.preset.id : "",
      model: reviewer ? reviewer.model : "",
      ready: reviewer ? isReady(reviewer) : true,
    },
    completion: { enabled: settings.completion ?? false, ready: Boolean(resolve("deepseek").apiKey) },
    canEncrypt: safeStorage.isEncryptionAvailable(),
    decision: decisionState(),
    routing: routingState(),
  };
}

const NO_ROUTING: RoutingSettings = { failover: [], difficulty: { enabled: false }, purposes: {} };

export function routing(): RoutingSettings {
  return settings.routing ?? NO_ROUTING;
}

configureBuiltinFreePool({
  providers: () => allPresets().filter(p => p.builtinFree).map(p => resolve(p.id)),
  order: () => routing().builtinFreeOrder,
});

/** A model reference that can run now (its provider exists and has a key or login). */
export function refReady(ref: ModelRef): boolean {
  return exists(ref.providerId) && isReady({ ...resolve(ref.providerId), model: ref.model });
}

function routingState(): ProvidersState["routing"] {
  const r = routing();
  const refs = [...allPresets().filter(p => p.builtinFree).map(p => ({ providerId: p.id, model: "auto" })), ...r.failover, r.difficulty.light, r.difficulty.heavy, r.purposes.compress, r.purposes.subtask].filter((x): x is ModelRef => !!x);
  return { ...r, ready: Object.fromEntries(refs.map((x) => [`${x.providerId}:${x.model}`, refReady(x)])) };
}

export async function setRouting(r: RoutingSettings): Promise<ProvidersState> {
  const clean = (x?: ModelRef): ModelRef | undefined => (x?.providerId && exists(x.providerId) ? { providerId: x.providerId, model: (x.model ?? "").trim() || resolve(x.providerId).model } : undefined);
  settings.routing = {
    failover: (r.failover ?? []).map(clean).filter((x): x is ModelRef => !!x).slice(0, 5),
    difficulty: { enabled: !!r.difficulty?.enabled, light: clean(r.difficulty?.light), heavy: clean(r.difficulty?.heavy) },
    purposes: { compress: clean(r.purposes?.compress), subtask: clean(r.purposes?.subtask) },
    effort: effortOverrides(r.effort ?? settings.routing?.effort),
    builtinFreeOrder: builtinFreeOrder(r.builtinFreeOrder ?? settings.routing?.builtinFreeOrder),
  };
  await saveSettings();
  return state();
}

export async function update(u: ProviderUpdate): Promise<ProvidersState> {
  const p = preset(u.id);
  const o = { ...settings.overrides[u.id] };
  if (u.enabled !== undefined) {
    if (!p.builtinFree || typeof u.enabled !== "boolean") throw new Error("只能设置内置免费供应商的开关");
    o.enabled = u.enabled ? undefined : false;
  }
  if (u.baseURL !== undefined) {
    const url = u.baseURL.trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//.test(url)) throw new Error("接口地址要以 http:// 或 https:// 开头");
    o.baseURL = url === p.baseURL ? undefined : url;
  }
  if (u.model !== undefined) {
    const m = u.model.trim();
    o.model = m === p.defaultModel ? undefined : m;
  }
  if (u.authMode !== undefined && p.kind === "anthropic" && !p.compat) o.authMode = u.authMode === "api_key" ? undefined : u.authMode;
  if (u.openaiApi !== undefined && p.responses) o.openaiApi = u.openaiApi === "responses" ? undefined : u.openaiApi;
  if (u.models !== undefined) {
    const list = [...new Set(u.models.map((m) => m.trim()).filter(Boolean))].slice(0, 50);
    o.models = list.length ? list : undefined;
  }
  const custom = settings.customs?.find((c) => c.id === u.id);
  if (custom) {
    if (u.name !== undefined && u.name.trim()) custom.name = u.name.trim().slice(0, 40);
    if (u.kind === "openai" || u.kind === "anthropic") custom.kind = u.kind;
  }
  modelDiscovery.invalidate(u.id);
  settings.overrides[u.id] = o;
  await saveSettings();
  if (u.apiKey !== undefined && u.apiKey.trim()) {
    keys[u.id] = u.apiKey.trim();
    await saveKeys();
  }
  return state();
}

export async function setBuiltinFreeProviderEnabled(id: string, enabled: boolean): Promise<ProvidersState> {
  if (typeof enabled !== "boolean" || !preset(id).builtinFree) throw new Error("无效的内置免费供应商开关");
  return update({ id, enabled });
}

export async function clearKey(id: string): Promise<ProvidersState> {
  modelDiscovery.invalidate(id);
  delete keys[id];
  await saveKeys();
  return state();
}

export async function setActive(id: string): Promise<ProvidersState> {
  if (preset(id).builtinFree && resolve(id).enabled === false) throw new Error("这个免费模型已关闭，先打开再选用");
  settings.activeId = id;
  await saveSettings();
  return state();
}

/** Adds an empty custom provider and returns its id with the new state. */
export async function addCustom(kind: "openai" | "anthropic" = "openai"): Promise<{ id: string; state: ProvidersState }> {
  const customs = (settings.customs ??= []);
  if (customs.length >= 20) throw new Error("自定义服务商最多 20 个");
  const id = `custom-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  customs.push({ id, name: `自定义服务商 ${customs.length + 1}`, kind });
  await saveSettings();
  return { id, state: await state() };
}

/** Removes a custom provider with its settings and key. */
export async function removeCustom(id: string): Promise<ProvidersState> {
  if (!settings.customs?.some((c) => c.id === id)) throw new Error("只能删除自己添加的服务商");
  modelDiscovery.invalidate(id);
  settings.customs = settings.customs.filter((c) => c.id !== id);
  delete settings.overrides[id];
  if (settings.activeId === id) settings.activeId = DEFAULT_PROVIDER;
  if (settings.vision?.providerId === id) settings.vision = undefined;
  if (settings.reviewer?.providerId === id) settings.reviewer = undefined;
  await saveSettings();
  if (keys[id]) {
    delete keys[id];
    await saveKeys();
  }
  return state();
}

/** Every ready provider × model it can use: the people a group chat can be made of. */
export function groupCandidates(): { providerId: string; providerName: string; model: string }[] {
  const out: { providerId: string; providerName: string; model: string }[] = [];
  for (const p of allPresets()) {
    const r = resolve(p.id);
    if (!isReady(r)) continue;
    for (const model of new Set([...(r.model === "auto" ? availableModels(r) : [r.model]), ...(settings.overrides[p.id]?.models ?? []).filter(m => m !== "auto")])) {
      if (model) out.push({ providerId: p.id, providerName: p.name, model });
    }
  }
  return out;
}

/** The engine and key web_search uses now. Main process only. */
export function resolveWebSearch(): { engine: "duckduckgo" | "tavily" | "brave"; apiKey: string } {
  const engine = settings.webSearch?.engine ?? "auto";
  const tavily = keys[SEARCH_KEY.tavily] || process.env.TAVILY_API_KEY || "";
  const brave = keys[SEARCH_KEY.brave] || process.env.BRAVE_API_KEY || "";
  if (engine === "tavily" && tavily) return { engine, apiKey: tavily };
  if (engine === "brave" && brave) return { engine, apiKey: brave };
  if (engine === "auto") {
    if (tavily) return { engine: "tavily", apiKey: tavily };
    if (brave) return { engine: "brave", apiKey: brave };
  }
  return { engine: "duckduckgo", apiKey: "" };
}

export function webSearchState(): WebSearchState {
  return {
    engine: settings.webSearch?.engine ?? "auto",
    using: resolveWebSearch().engine,
    hasKey: { tavily: !!(keys[SEARCH_KEY.tavily] || process.env.TAVILY_API_KEY), brave: !!(keys[SEARCH_KEY.brave] || process.env.BRAVE_API_KEY) },
  };
}

export async function setWebSearch(u: { engine?: string; tavilyKey?: string; braveKey?: string; clear?: "tavily" | "brave" }): Promise<WebSearchState> {
  if (u.engine === "auto" || u.engine === "duckduckgo" || u.engine === "tavily" || u.engine === "brave") {
    settings.webSearch = { engine: u.engine };
    await saveSettings();
  }
  let changed = false;
  if (u.tavilyKey?.trim()) (keys[SEARCH_KEY.tavily] = u.tavilyKey.trim()), (changed = true);
  if (u.braveKey?.trim()) (keys[SEARCH_KEY.brave] = u.braveKey.trim()), (changed = true);
  if (u.clear) delete keys[SEARCH_KEY[u.clear]], (changed = true);
  if (changed) await saveKeys();
  return webSearchState();
}
