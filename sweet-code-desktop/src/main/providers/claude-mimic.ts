import { createHash } from "node:crypto";

/** Claude Code 2.1.296 wire constants; only used for login mode. */
export const BetaOAuth = "oauth-2025-04-20";
export const BetaClaudeCode = "claude-code-20250219";
export const BetaInterleavedThinking = "interleaved-thinking-2025-05-14";
export const BetaThinkingTokenCount = "thinking-token-count-2026-05-13";
export const BetaMidConversationSystem = "mid-conversation-system-2026-04-07";
export const BetaPerTurnControl = "per-turn-control-2026-07-01";
export const BetaAdvisorTool = "advisor-tool-2026-03-01";
export const BetaTokenCounting = "token-counting-2024-11-01";
export const BetaContext1M = "context-1m-2025-08-07";
export const BetaFastMode = "fast-mode-2026-02-01";
export const BetaStructuredOutputs = "structured-outputs-2025-11-13";
export const BetaMidConversationToolChanges = "mid-conversation-tool-changes-2026-07-01";
export const BetaInlineTools = "inline-tools-2026-09-15";
export const BetaPromptCachingScope = "prompt-caching-scope-2026-01-05";
export const BetaEffort = "effort-2025-11-24";
export const BetaRedactThinking = "redact-thinking-2026-02-12";
export const BetaContextManagement = "context-management-2025-06-27";
export const BetaThinkingBindingControls = "thinking-binding-controls-2026-08-01";
export const BetaMidConversationOutputConfig = "mid-conversation-output-config-2026-07-01";
export const BetaExtendedCacheTTL = "extended-cache-ttl-2025-04-11";
export const BetaServerSideFallback = "server-side-fallback-2026-07-01";
export const BetaFallbackCredit = "fallback-credit-2026-07-01";
export const BetaFallbackCreditLegacy = "fallback-credit-2026-06-01";

export const CLICurrentVersion = "2.1.296";
export const CLIVersionEnv = "SIKEOOP_CLAUDE_CLI_VERSION";
export function IsSupportedCLIVersion(version: string): boolean {
  const value = version.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  const parts = value.split(".").map(BigInt);
  const baseline = CLICurrentVersion.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== baseline[i]) return parts[i] > baseline[i];
  }
  return true;
}
function resolveCLIVersion(raw: string | undefined): string {
  const version = raw?.trim() ?? "";
  if (!version) return CLICurrentVersion;
  if (IsSupportedCLIVersion(version)) return version;
  console.warn("Ignoring invalid SIKEOOP_CLAUDE_CLI_VERSION; using built-in Claude CLI version");
  return CLICurrentVersion;
}
// Resolve exactly once so all outbound identity headers agree throughout the process.
const resolvedCLIVersion = resolveCLIVersion(process.env[CLIVersionEnv]);
export const CLIVersion = (): string => resolvedCLIVersion;
export const CLIEntrypoint = "sdk-cli";
export const DefaultUserAgent = (): string => `claude-cli/${CLIVersion()} (external, ${CLIEntrypoint})`;
export function FullClaudeCodeMimicryBetas(): string[] {
  return [BetaOAuth, BetaInterleavedThinking, BetaThinkingTokenCount, BetaContextManagement,
    BetaPromptCachingScope, BetaMidConversationSystem, BetaClaudeCode, BetaPerTurnControl,
    BetaMidConversationToolChanges, BetaInlineTools, BetaAdvisorTool, BetaEffort, BetaExtendedCacheTTL];
}
export function DefaultHeaders(): Record<string, string> {
  return {
    "User-Agent": DefaultUserAgent(),
    // The installed SDK supplies real platform/package/runtime and per-attempt retry/timeout headers.
    "X-App": "cli",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
  };
}

/** String indexing deliberately uses UTF-16 code units, matching the CLI's JavaScript. */
export function BillingFingerprint(firstUserText: string, version = CLIVersion()): string {
  const sample = [4, 7, 20].map(index => firstUserText[index] ?? "0").join("");
  return createHash("sha256").update(`59cf53e54c78${sample}${version}`).digest("hex").slice(0, 3);
}

/** Apply the billing system block to a serialized SDK Messages request, never to token/model calls. */
export function WithClaudeCodeBilling(body: unknown): unknown {
  if (typeof body !== "string") return body;
  let request: Record<string, unknown>;
  try { request = JSON.parse(body); } catch { return body; }
  if (!request || typeof request !== "object" || !Array.isArray(request.messages)) return body;
  const user = (request.messages as { role?: string; content?: unknown }[]).find(message => message?.role === "user");
  const firstUserText = typeof user?.content === "string" ? user.content
    : Array.isArray(user?.content) ? (user.content as ({ type?: string; text?: string } | null)[])
      .find(block => block?.type === "text" && typeof block.text === "string")?.text ?? "" : "";
  const text = `x-anthropic-billing-header: cc_version=${CLIVersion()}.${BillingFingerprint(firstUserText)}; cc_entrypoint=${CLIEntrypoint};`;
  // Preserve all original system blocks and cache controls; replace an old billing block rather than doubling it.
  const system = typeof request.system === "string" ? [{ type: "text", text: request.system }]
    : Array.isArray(request.system) ? request.system : [];
  request.system = [{ type: "text", text }, ...system.filter(block =>
    !(block?.type === "text" && typeof block.text === "string" && block.text.startsWith("x-anthropic-billing-header:")))];
  return JSON.stringify(request);
}

/** Exact short-name aliases accepted by the Claude OAuth upstream. */
export const ModelIDOverrides: Readonly<Record<string, string>> = Object.freeze({
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
});
export function NormalizeModelID(id: string): string {
  return Object.hasOwn(ModelIDOverrides, id) ? ModelIDOverrides[id] : id;
}
