import { randomUUID } from "node:crypto";
import { DefaultHeaders, FullClaudeCodeMimicryBetas, WithClaudeCodeBilling } from "./claude-mimic.ts";
import { oauthToken, validOAuthToken } from "./claude-oauth.ts";
import { captureClaudeUsageSampleEpoch, samplePassiveUsageFromHeaders } from "./claude-usage.ts";
import Anthropic from "@anthropic-ai/sdk";
import { discoverProviderModels } from "./model-routing.ts";
import { AnthropicAdapter } from "./anthropic";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import { OpenAIResponsesAdapter } from "./openai-responses";
import { codexInstallationId, isCodexLogin, OpenAICodexAdapter } from "./openai-codex.ts";
import { installId, type ResolvedProvider } from "./store";
import type { ModelAdapter, ToolDef } from "./types";

/** Check a provider is usable before starting a conversation with it. */
export function assertReady(p: ResolvedProvider): void {
  if (p.enabled === false) throw new Error("服务商已关闭");
  if (!p.baseURL) throw new Error(`还没有填 ${p.preset.name} 的接口地址。点左下角的设置填一下吧。`);
  if (!p.model) throw new Error(`还没有选 ${p.preset.name} 的模型。点左下角的设置，选一个模型吧。`);
  // Login uses the app OAuth token first, then the SDK account profile; missing login surfaces on request.
  if (p.authMode === "login") return;
  if (p.preset.needsKey && !p.apiKey) throw new Error(`还没有填 ${p.preset.name} 的 API Key。点左下角的设置填一个吧。`);
}

/** App OAuth uses Bearer auth with per-request refresh; CLI profiles remain the fallback. */
// INTERNAL experiment: SIKEOOP_ANTHROPIC_DIRECT=1 skips the mimic headers and the
// custom fetch entirely, letting the official SDK speak natively (own stainless
// headers, per-request betas, snapshot authToken). Default off; no UI/docs.
const directSDK = (): boolean => process.env.SIKEOOP_ANTHROPIC_DIRECT === "1";
export function anthropicClient(p: ResolvedProvider): Anthropic {
  // Compatible services want the key as a Bearer token (ANTHROPIC_AUTH_TOKEN in Claude Code).
  if (p.preset.compat) return new Anthropic({ apiKey: null, authToken: p.apiKey, baseURL: p.baseURL });
  const baseURL = p.baseURL === p.preset.baseURL ? undefined : p.baseURL;
  if (directSDK() && p.authMode === "login")
    return new Anthropic({ apiKey: null, authToken: oauthToken()?.access_token ?? null, baseURL });
  const token = p.authMode === "login" ? oauthToken() : undefined;
  const loginHeaders = p.authMode === "login" ? { ...DefaultHeaders(),
    "anthropic-beta": FullClaudeCodeMimicryBetas().join(","), Accept: "application/json",
    "X-Claude-Code-Session-Id": randomUUID() } : undefined;
  return p.authMode === "login"
    ? new Anthropic({ apiKey: null, authToken: token?.access_token ?? null, baseURL,
        defaultHeaders: loginHeaders,
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (token) {
            const current = await validOAuthToken();
            if (!current) throw new Error("Claude OAuth 已退出，请重新登录");
            headers.set("authorization", `Bearer ${current.access_token}`);
          }
          headers.delete("x-api-key");
          for (const [key, value] of Object.entries(loginHeaders!)) headers.set(key, value);
          headers.delete("x-client-request-id");
          const sampleEpoch = captureClaudeUsageSampleEpoch();
          const response = await fetch(input, { ...init, headers, body: WithClaudeCodeBilling(init?.body) as RequestInit["body"] });
          void samplePassiveUsageFromHeaders(response.headers, sampleEpoch);
          return response;
        },
      })
    : new Anthropic({ apiKey: p.apiKey, baseURL });
}

export function createAdapter(p: ResolvedProvider, systemPrompt: string, tools: ToolDef[]): ModelAdapter {
  assertReady(p);
  if (p.model === "auto") throw new Error("auto 模型必须先完成动态路由");
  // ChatGPT subscription: the model id goes straight through, and a missing login surfaces on request.
  if (isCodexLogin(p)) return new OpenAICodexAdapter({ model: p.model, installationId: codexInstallationId() }, systemPrompt, tools);
  if (p.preset.kind === "anthropic") {
    return new AnthropicAdapter(
      {
        client: anthropicClient(p),
        model: p.model,
        login: p.authMode === "login",
        compat: p.preset.compat ? { providerName: p.preset.name } : undefined,
      },
      systemPrompt,
      tools,
    );
  }
  if (p.openaiApi === "responses") {
    return new OpenAIResponsesAdapter({ apiKey: p.apiKey, baseURL: p.baseURL, model: p.model, providerName: p.preset.name }, systemPrompt, tools);
  }
  return new OpenAICompatibleAdapter(
    {
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      model: p.model,
      providerName: p.preset.name,
      reasoningEffort: p.preset.reasoningEffort,
      userId: p.preset.userId ? installId() : undefined,
    },
    systemPrompt,
    tools,
  );
}

/** Generic, cached protocol discovery; failures return preset model ids. */
export async function listModels(p: ResolvedProvider): Promise<string[]> {
  return discoverProviderModels(p);
}
