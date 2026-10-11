import type { Effort } from "@shared/types";

// The agent loop talks to every provider through this interface. Each adapter keeps
// the conversation in its provider's own message format, so provider-specific state
// (Claude's thinking blocks, OpenAI's tool_calls) is passed back exactly as received.

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or undefined when the model sent JSON that could not be parsed. */
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface StepHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
  /** A tool call has started streaming: its id and name are known. */
  onToolStart?(id: string, name: string): void;
  /** A piece of a tool call's JSON arguments. */
  onToolInput?(id: string, partialJson: string): void;
}

export interface StepUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Trimmed {
  how: "compacted" | "cleared";
  tokens?: number;
}

export interface StepResult {
  /**
   * tool_use: run the calls and step again. end_turn: the answer is complete.
   * max_tokens: the reply was cut off. refusal: the model declined.
   * continue: step again without new input (Claude's pause_turn).
   */
  stop: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "continue";
  toolCalls: ToolCall[];
  usage: StepUsage;
  /** Set when the provider shortened earlier context during this step. */
  trimmed?: Trimmed;
}

export interface StepOptions {
  effort: Effort;
  signal: AbortSignal;
}

/** A provider-neutral view of one history entry, for the compression sub-agent. */
export interface HistoryEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  /** assistant: the tool calls it made. */
  calls?: { name: string; input: unknown }[];
  /** tool: which tool produced this result. */
  tool?: string;
  /** assistant: length of its thinking / reasoning text, which stays in the history. */
  thinkingChars?: number;
}

export interface ModelAdapter {
  /** Claude-only configuration: the session owns a fixed top-level effort across handoffs. */
  setEffort?(current: Effort, top: Effort): void;
  /**
   * The provider keeps long conversations small on its own (Claude's server-side compaction).
   * Otherwise the agent loop compresses the history with the compression sub-agent.
   */
  readonly nativeCompaction: boolean;
  /** Prompt tokens of the latest request: how full the context is. */
  promptTokens(): number;
  /** The history in plain form, for the compression sub-agent. */
  history(): HistoryEntry[];
  /**
   * Replace the whole history with a summary. continueNow: it becomes a user message right away
   * (compressed mid-task, the next step carries on); otherwise it goes with the next user message.
   */
  restart(summary: string[], continueNow: boolean): void;
  /** Add a user message made of one or more text parts, to be answered at this effort. */
  addUserText(parts: string[], effort: Effort): void;
  /**
   * Call the model once on the current history, streaming as it goes. A completed
   * reply is appended to the history, except when tool calls were cut off by max_tokens.
   */
  step(opts: StepOptions, handlers: StepHandlers): Promise<StepResult>;
  /** Answer every tool call of the last step, in the order the calls were made. */
  addToolResults(results: ToolResult[]): void;
  /** History length, for rolling back a failed or cancelled turn. */
  checkpoint(): number;
  rollback(to: number): void;
  /** The provider-native history and settings, as plain JSON, for saving the conversation. */
  exportState(): unknown;
  /** Restore what exportState returned (same provider kind). */
  importState(state: unknown): void;
  /** Turn an SDK error into a short message for a beginner, or null if it is not one of ours. */
  describeError(err: unknown): string | null;
  isAbort(err: unknown): boolean;
}
