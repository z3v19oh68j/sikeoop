import type { AgentCliId, AgentSessionView, DispatchJob } from "@shared/types";
import type { Executor } from "./scheduler";

// The `cli` executor: a Claude Code / Codex session in a terminal tab (peers.ts). A job is typed in
// as a prompt once the session is idle, and its result is the session's last reply of that turn.

/** The part of PeerBus the executor needs. */
export interface CliBus {
  viewOf(id: string): AgentSessionView | null;
  deliver(id: string, text: string, detail: string): boolean;
  waitTurn(id: string, ms: number, signal: AbortSignal): Promise<string | null>;
  /** Stops what the session is doing, as Esc in its terminal would. */
  interrupt?(id: string): void;
}

/** How long a session must have stayed idle after its Stop before a job is typed in. */
export const SETTLE_MS = 1500;

export class CliExecutor implements Executor {
  readonly kind = "cli" as const;
  readonly ref: string;
  readonly name: string;
  private readonly bus: CliBus;
  /** What the receiving terminal sees for a job. */
  private readonly frame: (job: DispatchJob) => { text: string; detail: string };
  private readonly where: { cli: AgentCliId; root: string };

  // No parameter properties: dispatch/ is tested under Node's type stripping.
  constructor(bus: CliBus, ref: string, name: string, frame: (job: DispatchJob) => { text: string; detail: string }, where: { cli: AgentCliId; root: string }) {
    this.bus = bus;
    this.ref = ref;
    this.name = name;
    this.frame = frame;
    this.where = where;
  }

  /** Both CLIs run in the project folder; Codex's sandbox (workspace-write) has no network unless the user approves. */
  env(): { writableRoots: string[]; network: boolean | "ask" } {
    return { writableRoots: [this.where.root], network: this.where.cli === "codex" ? "ask" : true };
  }

  /**
   * Idle, and settled for SETTLE_MS: a session that is working or waiting for the user is never
   * typed into, and one that has only just stopped may still pick up a prompt the user queued.
   */
  ready(now = Date.now()): boolean {
    const view = this.bus.viewOf(this.ref);
    return view?.status === "idle" && now - view.since >= SETTLE_MS;
  }

  alive(): boolean {
    return this.bus.viewOf(this.ref) !== null;
  }

  run(job: DispatchJob, signal: AbortSignal): Promise<{ text: string } | null> {
    const { text, detail } = this.frame(job);
    return this.turn(job, text, detail, signal);
  }

  /** The session still has the job in its context, so the problems are all it needs to be told. */
  rework(job: DispatchJob, problems: string, signal: AbortSignal): Promise<{ text: string } | null> {
    return this.turn(job, reworkFraming(problems), "自动验收没过，返工一次", signal);
  }

  /** Types one prompt in and resolves with the session's last reply of that turn. */
  private async turn(job: DispatchJob, text: string, detail: string, signal: AbortSignal): Promise<{ text: string } | null> {
    // Cancelled before it began: nothing is typed.
    if (signal.aborted) return null;
    // Listen before typing, so a very quick turn can't end unseen.
    const turn = this.bus.waitTurn(this.ref, job.limits.timeoutMs, signal);
    if (!this.bus.deliver(this.ref, text, detail)) return null;
    // Cancelled while it works: the session is stopped as well. A timeout only stops waiting for
    // it; the session may be close to done and is left to finish.
    const onAbort = () => {
      if (signal.reason === "cancelled") this.bus.interrupt?.(this.ref);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const last = await turn;
      return last === null ? null : { text: last };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** How the acceptance's findings read in the terminal that just did the job. */
export function reworkFraming(problems: string): string {
  return `[sikeoop → 你] 刚才的任务自动验收没过，只修下面这些问题，别的不要动：\n${problems}\n（修完直接结束这一轮，最后一条回复仍按刚才的格式汇报整个任务。）`;
}
