import Anthropic from "@anthropic-ai/sdk";
import { discoverProviderModels } from "./model-routing.ts";
import { AnthropicAdapter } from "./anthropic";
import { OpenAICompatibleAdapter } from "./openai-compatible";
import { OpenAIResponsesAdapter } from "./openai-responses";
import { installId, type ResolvedProvider } from "./store";
import type { ModelAdapter, ToolDef } from "./types";

/** Check a provider is usable before starting a conversation with it. */
export function assertReady(p: ResolvedProvider): void {
  if (p.enabled === false) throw new Error("服务商已关闭");
  if (!p.baseURL) throw new Error(`还没有填 ${p.preset.name} 的接口地址。点左下角的设置填一下吧。`);
  if (!p.model) throw new Error(`还没有选 ${p.preset.name} 的模型。点左下角的设置，选一个模型吧。`);
  // In login mode the SDK finds the account profile itself; a missing login surfaces on the first request.
  if (p.authMode === "login") return;
  if (p.preset.needsKey && !p.apiKey) throw new Error(`还没有填 ${p.preset.name} 的 API Key。点左下角的设置填一个吧。`);
}

/**
 * The Claude client for this provider. In login mode apiKey and authToken are set to
 * null on purpose: that stops a leftover ANTHROPIC_API_KEY in the environment from
 * silently taking over, and makes the SDK use the active `ant auth login` profile.
 */
export function anthropicClient(p: ResolvedProvider): Anthropic {
  // Compatible services want the key as a Bearer token (ANTHROPIC_AUTH_TOKEN in Claude Code).
  if (p.preset.compat) return new Anthropic({ apiKey: null, authToken: p.apiKey, baseURL: p.baseURL });
  const baseURL = p.baseURL === p.preset.baseURL ? undefined : p.baseURL;
  return p.authMode === "login"
    ? new Anthropic({ apiKey: null, authToken: null, baseURL })
    : new Anthropic({ apiKey: p.apiKey, baseURL });
}

export function createAdapter(p: ResolvedProvider, systemPrompt: string, tools: ToolDef[]): ModelAdapter {
  assertReady(p);
  if (p.model === "auto") throw new Error("auto 模型必须先完成动态路由");
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
