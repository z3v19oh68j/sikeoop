import type { DispatchJob } from "@shared/types";
import type { Executor } from "./scheduler";

// The `model` executor: one streamed model call and nothing else (a group chat member's reply).
// No tools, no session, no terminal: text goes out, text comes back as it is written.

/** How a streamed call ended. `text` is what arrived, also when it was cut short. */
export interface ModelOutcome {
  text: string;
  /** Why it has no complete reply: the call's own error message. Absent when it finished. */
  error?: string;
  /** It was stopped from outside: "cancelled" (someone stopped it) or "timeout". */
  aborted?: "cancelled" | "timeout";
}

export interface ModelCall {
  /** Right before the call starts (the job has its turn now). */
  begin?(job: DispatchJob): void;
  /** The call itself: hands over text as it arrives and resolves with the whole reply. */
  stream(job: DispatchJob, onDelta: (text: string) => void, signal: AbortSignal): Promise<string>;
  /** Each piece of text as it arrives. */
  delta?(job: DispatchJob, text: string): void;
  /**
   * Once, however the call ended, before the job counts as over: whoever keeps the reply stores it
   * here, so the next job in the same lane starts with it already in place.
   */
  settle?(job: DispatchJob, outcome: ModelOutcome): Promise<void> | void;
}

export class ModelExecutor implements Executor {
  readonly kind = "model" as const;
  readonly ref: string;
  readonly name: string;
  private readonly call: ModelCall;

  // No parameter properties: dispatch/ is tested under Node's type stripping.
  constructor(ref: string, name: string, call: ModelCall) {
    this.ref = ref;
    this.name = name;
    this.call = call;
  }

  /** A model has no state of its own to wait for: it's free whenever the scheduler has nothing running on it. */
  ready(): boolean {
    return true;
  }

  alive(): boolean {
    return true;
  }

  async run(job: DispatchJob, signal: AbortSignal): Promise<{ text: string } | null> {
    let text = "";
    this.call.begin?.(job);
    try {
      const whole = await this.call.stream(
        job,
        (piece) => {
          text += piece;
          this.call.delta?.(job, piece);
        },
        signal,
      );
      // The call returns the whole reply; what streamed in stands in when it returns nothing.
      text = whole || text;
    } catch (err) {
      const aborted = signal.aborted ? (signal.reason === "timeout" ? "timeout" : "cancelled") : undefined;
      await this.call.settle?.(job, { text: text.trim(), error: err instanceof Error ? err.message : String(err), aborted });
      throw err;
    }
    await this.call.settle?.(job, { text });
    // An empty reply is no result: the scheduler records the job as failed.
    return text ? { text } : null;
  }
}
