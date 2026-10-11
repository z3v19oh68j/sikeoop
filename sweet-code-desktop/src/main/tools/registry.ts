import type { z } from "zod";
import type { AgentEvent, AskAnswer, AskQuestion, PlanItem } from "@shared/types";
import type { ToolDef } from "../providers/types";

/**
 * How much the user must be involved before a tool runs.
 * auto: read-only, runs right away. confirm: the tool asks for approval through
 * ToolContext.requestApproval (unless the user chose "approve all").
 * always_confirm: asks every time, whatever the user chose (commands, M3).
 */
export type Permission = "auto" | "confirm" | "always_confirm";

/** What the user is shown before a tool acts: a file change or a command. */
export type ApprovalRequest =
  | { kind: "file"; path: string; before: string; after: string; created: boolean; explanation: string }
  | { kind: "command"; command: string; explanation: string; warning?: string }
  | {
      kind: "tool";
      server: string;
      tool: string;
      description: string;
      args: string;
      /** Set = only the user may approve (not "approve all", hooks or the long-task reviewer); the reason is shown. */
      humanOnly?: string;
    };

export type ApprovalOutcome = { approved: true } | { approved: false; feedback?: string };

/** Everything a running tool may use besides its input. Created by the agent loop per call. */
export interface ToolContext {
  callId: string;
  signal: AbortSignal;
  /** Show the change or command to the user and wait for their answer. Rejects if the turn is cancelled. */
  requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome>;
  /** Stream a running command's output to its card in the chat. */
  commandOutput(chunk: string): void;
  commandDone(exitCode: number | null, timedOut: boolean): void;
  /** Note something that went wrong in this turn: the lessons of an autonomous run are made from these (agent/lessons.ts). */
  noteFailure(text: string): void;
  /** Content hashes of files as the model last saw them, for staleness checks. */
  readTracker: ReadTracker;
  /** Who holds file locks for this session (session/locks.ts); released when the turn ends. */
  lockOwner: string;
  /** The dispatch job this session is working on, if it runs one: jobs it starts become its children. */
  dispatchJobId?: string;
  /** Why this session may not write the file (its dispatch job owns other files), or null. */
  guardWrite?(abs: string): Promise<string | null> | string | null;
  /** Record a write so the whole turn can be undone, and refresh the editor. before null = new file. */
  recordWrite(path: string, before: string | null, after: string): void;
  /** Replace the agent's plan for this task (update_plan). */
  updatePlan(items: PlanItem[]): void;
  /** Show something in the chat (and keep it in the saved conversation). */
  emit(e: AgentEvent): void;
  /** Show a card of questions and wait for the user's answers. Rejects if the turn is cancelled. */
  askUser(intro: string | undefined, questions: AskQuestion[]): Promise<{ answers: AskAnswer[]; usedDefaults: boolean }>;
}

/** Remembers the content hash of each file as the model last read or wrote it. */
export class ReadTracker {
  private seen = new Map<string, string>();
  set(path: string, hash: string): void {
    this.seen.set(path, hash);
  }
  get(path: string): string | undefined {
    return this.seen.get(path);
  }
  forget(path: string): void {
    this.seen.delete(path);
  }
  clear(): void {
    this.seen.clear();
  }
  export(): [string, string][] {
    return [...this.seen];
  }
  import(entries: [string, string][]): void {
    this.seen = new Map(entries);
  }
}

export interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** JSON schema sent to the API. Kept by hand so the tool list stays byte-stable for caching. */
  inputSchema: ToolDef["inputSchema"];
  permission: Permission;
  /** Read-only tools can run concurrently within one turn. A function decides per call, from its input. */
  parallelSafe: boolean | ((input: z.infer<S>) => boolean);
  /** One short Chinese line shown in the chat while the tool runs. */
  summarize(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  constructor(specs: ToolSpec[]) {
    for (const s of specs) this.tools.set(s.name, s);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /** Definitions in a fixed order; any change here invalidates the prompt cache. */
  definitions(): ToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
