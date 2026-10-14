import { mergeBuiltinFreeProviders } from "./builtin-free.ts";
import type { ProviderKind } from "../../shared/types.ts";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  /** Model selected until the user picks another. Empty means "pick one in settings first". */
  defaultModel: string;
  /** Long-lived model ids worth offering. The settings screen can also fetch the live list. */
  suggestedModels: string[];
  keyHint: string;
  /** Environment variable read when no key is saved in the app. */
  envKey?: string;
  /** Main-process-only build-injected fallback key. Never included in ProviderView. */
  builtinKey?: string;
  /** Warm live model discovery before requests, even when a fixed model is selected. */
  discoverModels?: boolean;
  /** Member of the optional build-injected free auto pool. */
  builtinFree?: boolean;
  needsKey: boolean;
  /**
   * DeepSeek-style thinking control: `thinking: {type}` plus a top-level `reasoning_effort`
   * (low / high / max), driven by the chat's thinking-depth selector.
   */
  reasoningEffort?: boolean;
  /** Context window of the usual models, in tokens (for the working budget; see contextBudget). */
  contextWindow?: number;
  /** Has a GET /user/balance endpoint (DeepSeek). */
  balance?: boolean;
  /** Supports fill-in-the-middle completion at <baseURL>/beta, used for editor autocomplete. */
  fimModel?: string;
  /** Accepts a `user_id` field, which isolates cache and rate limits per user. */
  userId?: boolean;
  /**
   * kind "anthropic" served by another company (Anthropic-compatible API): only the plain
   * Messages API is used — no betas, server-side compaction, adaptive thinking, fallbacks or
   * account login — and the key is sent as a Bearer token.
   */
  compat?: boolean;
  /** Thinking can only be switched on or off ({type: enabled/disabled}): "快速" turns it off. */
  thinkingToggle?: boolean;
  /** Also speaks the OpenAI Responses API; it is used unless the user switches to Chat Completions. */
  responses?: boolean;
}

// Every non-Claude provider here accepts the OpenAI Chat Completions format at its baseURL.
/** Providers with an account login beside the API key: Claude itself and OpenAI itself, never a compatible service. */
export const supportsLogin = (p: Pick<ProviderPreset, "id" | "kind" | "compat">): boolean =>
  (p.kind === "anthropic" && !p.compat) || (p.kind === "openai" && p.id === "openai");

export const PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Claude",
    kind: "anthropic",
    baseURL: "https://api.anthropic.com",
    defaultModel: "claude-opus-5-5",
    suggestedModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
    keyHint: "在 console.anthropic.com 的 API Keys 页面创建",
    envKey: "ANTHROPIC_API_KEY",
    needsKey: true,
    contextWindow: 1_000_000,
  },
  {
    // Xiaomi MiMo Token Plan: a monthly plan with its own endpoint and keys (tp- / ttp-),
    // reached through the Anthropic-compatible protocol, like Claude Code does.
    id: "mimo",
    name: "小米 MiMo（Token Plan）",
    kind: "anthropic",
    compat: true,
    thinkingToggle: true,
    baseURL: "https://token-plan-cn.xiaomimimo.com/anthropic",
    // From the MiMo Anthropic API docs. [1m] turns on the 1M context (Token Plan, Claude Code docs).
    defaultModel: "mimo-v2.6-pro",
    suggestedModels: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
    keyHint: "订阅 Token Plan 后在 MiMo 开放平台控制台复制专属 Key（个人 tp- 开头，团队 ttp- 开头）。海外订阅把地址里的 cn 换成 sgp（新加坡）或 ams（欧洲）",
    envKey: "MIMO_API_KEY",
    needsKey: true,
    contextWindow: 1_000_000,
  },
  {
    // Xiaomi MiMo pay-as-you-go API: standard keys from the open platform, OpenAI-compatible.
    // (The Token Plan above has its own endpoint and keys.) Chain-Centric calls this endpoint too.
    id: "mimo-api",
    name: "小米 MiMo（API）",
    kind: "openai",
    baseURL: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2-flash",
    suggestedModels: ["mimo-v2-flash", "mimo-v2.6-pro", "mimo-v2.6-flash"],
    keyHint: "在 MiMo 开放平台控制台创建 API Key（按量计费的普通 Key，不是 Token Plan 的 tp- Key）。不确定有哪些模型就点「获取模型列表」",
    needsKey: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 platform.openai.com 的 API keys 页面创建",
    envKey: "OPENAI_API_KEY",
    needsKey: true,
    responses: true,
    contextWindow: 400_000,
  },
  {
    id: "gemini",
    name: "Gemini",
    kind: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 Google AI Studio（aistudio.google.com）的 API Keys 页面创建",
    envKey: "GEMINI_API_KEY",
    needsKey: true,
    contextWindow: 1_000_000,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseURL: "https://api.deepseek.com",
    // deepseek-flash: 1M context, thinking, tools, vision, FIM. deepseek-v4-pro: stronger, no vision.
    defaultModel: "deepseek-flash",
    suggestedModels: ["deepseek-flash", "deepseek-v4-pro"],
    keyHint: "在 platform.deepseek.com 的 API keys 页面创建",
    envKey: "DEEPSEEK_API_KEY",
    needsKey: true,
    reasoningEffort: true,
    contextWindow: 1_000_000,
    balance: true,
    fimModel: "deepseek-flash",
    userId: true,
  },
  {
    id: "qwen",
    name: "通义千问",
    kind: "openai",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    suggestedModels: ["qwen-plus", "qwen-max", "qwen-turbo"],
    keyHint: "在阿里云百炼控制台的 API-KEY 页面创建",
    envKey: "DASHSCOPE_API_KEY",
    needsKey: true,
    contextWindow: 256_000,
  },
  {
    id: "moonshot",
    name: "Kimi",
    kind: "openai",
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 platform.moonshot.cn 的 API Key 管理页面创建",
    envKey: "MOONSHOT_API_KEY",
    needsKey: true,
    contextWindow: 256_000,
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    kind: "openai",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 bigmodel.cn 的 API Keys 页面创建",
    envKey: "ZHIPUAI_API_KEY",
    needsKey: true,
    contextWindow: 200_000,
  },
  {
    id: "doubao",
    name: "豆包",
    kind: "openai",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在火山方舟控制台的 API Key 管理页面创建。模型可以填模型名，也可以填推理接入点 ID（ep- 开头）",
    envKey: "ARK_API_KEY",
    needsKey: true,
    contextWindow: 256_000,
  },
  {
    id: "minimax",
    name: "MiniMax",
    kind: "openai",
    baseURL: "https://api.minimaxi.com/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 MiniMax 开放平台的接口密钥页面创建。海外账号把接口地址改成 https://api.minimax.io/v1",
    envKey: "MINIMAX_API_KEY",
    needsKey: true,
    contextWindow: 1_000_000,
  },
  {
    // OpenAI-compatible relay. Three equivalent endpoints; switch when the network is bad.
    id: "jiji",
    name: "jiji 中转站（GPT / 国模 0.19 倍率）",
    kind: "openai",
    baseURL: "https://api.jiji.cc/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint:
      "注册：https://www.jiji.cc/register?aff=S5UCBVKAH62B ，在控制台创建令牌。网络不好可以把接口地址换成 https://api-slb.jiji.cc/v1 或 https://www.jiji.cc/v1",
    envKey: "JIJI_API_KEY",
    needsKey: true,
    responses: true,
    contextWindow: 200_000,
  },
  {
    // Same relay, set up for GPT-5.5 over the Responses API (mirrors the Codex config).
    id: "jiji-gpt",
    name: "jiji GPT-5.5（Responses）",
    kind: "openai",
    baseURL: "https://www.jiji.cc/v1",
    defaultModel: "gpt-5.5",
    suggestedModels: ["gpt-5.5"],
    keyHint:
      "和 jiji 中转站用同一个令牌：https://www.jiji.cc/register?aff=S5UCBVKAH62B 。网络不好可以把接口地址换成 https://api.jiji.cc/v1 或 https://api-slb.jiji.cc/v1",
    envKey: "JIJI_API_KEY",
    needsKey: true,
    discoverModels: true,
    responses: true,
    contextWindow: 200_000,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "在 openrouter.ai 的 Keys 页面创建",
    envKey: "OPENROUTER_API_KEY",
    needsKey: true,
    contextWindow: 200_000,
  },
  {
    id: "ollama",
    name: "Ollama（本地）",
    kind: "openai",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "本地运行，不需要 Key。先用 ollama pull 下载一个支持工具调用的模型",
    needsKey: false,
    contextWindow: 32_000,
  },
  {
    id: "custom",
    name: "其他（OpenAI 兼容）",
    kind: "openai",
    baseURL: "",
    defaultModel: "",
    suggestedModels: [],
    keyHint: "填服务商文档里写的「OpenAI 兼容」接口地址和 Key",
    needsKey: true,
  },
];

/** No endpoint/key is shipped unless the build supplies valid configuration. */
export function builtinFreePresets(baseURL: string, apiKey: string, rawProviders = "[]"): ProviderPreset[] {
  return mergeBuiltinFreeProviders(rawProviders, baseURL, apiKey).map(p => ({
    id: p.id, name: p.name, kind: p.protocol,
    ...(p.protocol === "anthropic" ? { compat: true } : {}),
    baseURL: p.baseUrl, builtinKey: p.key, builtinFree: true,
    defaultModel: p.model ?? "auto", discoverModels: !p.model, suggestedModels: p.model ? [p.model] : [],
    keyHint: "可填自己的 Key 覆盖构建时配置", needsKey: true,
  }));
}

PRESETS.push(...builtinFreePresets(
  typeof __SIKEOOP_BUILTIN_FREE_BASE_URL__ === "string" ? __SIKEOOP_BUILTIN_FREE_BASE_URL__ : "",
  typeof __SIKEOOP_BUILTIN_FREE_KEY__ === "string" ? __SIKEOOP_BUILTIN_FREE_KEY__ : "",
  typeof __SIKEOOP_BUILTIN_FREE_PROVIDERS__ === "string" ? __SIKEOOP_BUILTIN_FREE_PROVIDERS__ : "[]",
));

/** The working window every conversation gets: 200K, or less when the model's window is smaller. */
export const CONTEXT_BUDGET = 200_000;
/** Unknown models (custom endpoints): assume a 128K window. */
const DEFAULT_WINDOW = 128_000;

/**
 * Tokens a conversation may fill before the compression sub-agent summarizes it: 200K, or 85% of
 * a smaller window (room for the reply and the tool output of the step that crossed the line).
 */
export function contextBudget(preset: ProviderPreset): number {
  return Math.min(CONTEXT_BUDGET, Math.floor((preset.contextWindow ?? DEFAULT_WINDOW) * 0.85));
}
