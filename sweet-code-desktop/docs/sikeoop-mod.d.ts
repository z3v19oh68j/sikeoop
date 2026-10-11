// sikeoop mod API typings — copy into your mod for autocomplete. Generated from src/main/mods/api.ts; keep in sync.

export declare const API_VERSION = 1;

export type ModHookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export interface ModHookInput {
  prompt?: string;
  source?: "startup" | "resume" | "compact";
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: string;
  is_error?: boolean;
}

export interface ModHookContext {
  /** The open project folder ("" when none). */
  root: string;
  sessionId: string;
  signal: AbortSignal;
}

/** All optional. permission: PreToolUse only. block: UserPromptSubmit refuses the message, Stop keeps the agent working. */
export interface ModHookResult {
  context?: string;
  notice?: string;
  permission?: { decision: "allow" | "deny" | "ask"; reason: string };
  block?: string;
}

export interface ModToolContext {
  root: string;
  signal: AbortSignal;
}

export interface ModTool {
  /** [A-Za-z0-9_-]; the agent sees it as mod__<modId>__<name>. */
  name: string;
  /** For the model: what it does and when to use it. */
  description: string;
  /** JSON schema of the input (type: "object"). */
  inputSchema: Record<string, unknown>;
  /** "confirm" (default) shows the call to the user first; "auto" runs right away — only for read-only tools. */
  permission?: "auto" | "confirm";
  /** One short line shown in the chat while it runs. */
  summary?: (input: Record<string, unknown>) => string;
  run(input: Record<string, unknown>, ctx: ModToolContext): Promise<string> | string;
}

export interface SikeoopModApi {
  readonly apiVersion: number;
  readonly appVersion: string;
  readonly mod: { id: string; version: string; dir: string };

  /** Needs "tools". */
  tools: { register(tool: ModTool): void };
  /** Needs "hooks". */
  hooks: { on(event: ModHookEvent, handler: (input: ModHookInput, ctx: ModHookContext) => Promise<ModHookResult | void> | ModHookResult | void): void };
  /** Needs "model": one call to the model the user chats with. */
  model: { complete(system: string, user: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string> };
  /** Needs "notify": a note on the Dynamic Island. */
  notify(text: string, detail?: string): void;

  /** A small JSON store of this mod's own (no permission needed). */
  storage: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): Promise<void> };
  workspace: { root(): string };
  log(...args: unknown[]): void;
  /** Runs when the mod is turned off, reloaded or removed. */
  onDispose(fn: () => void | Promise<void>): void;
}

/** What the entry file exports (CommonJS: module.exports = { activate }). */
export interface ModModule {
  activate(api: SikeoopModApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
