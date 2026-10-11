import type { DispatchJob } from "@shared/types";
import type { Executor } from "./scheduler";

// The `session` executor: work done inside sikeoop itself, by one of its own AgentSessions (a
// cluster role, an automation step). The caller supplies how to run the job; the scheduler only
// needs it to be ready, alive, and to resolve with a result.

export type SessionRun = (job: DispatchJob, signal: AbortSignal) => Promise<{ text: string; outcome?: string } | null>;

export class SessionExecutor implements Executor {
  readonly kind = "session" as const;
  readonly ref: string;
  readonly name: string;
  private readonly runJob: SessionRun;

  // No parameter properties: dispatch/ is tested under Node's type stripping.
  constructor(ref: string, name: string, run: SessionRun) {
    this.ref = ref;
    this.name = name;
    this.runJob = run;
  }

  /** It is created for its work, so it's free whenever the scheduler has nothing running on it. */
  ready(): boolean {
    return true;
  }

  alive(): boolean {
    return true;
  }

  run(job: DispatchJob, signal: AbortSignal): Promise<{ text: string; outcome?: string } | null> {
    return this.runJob(job, signal);
  }
}
