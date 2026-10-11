import { randomUUID } from "node:crypto";
import type { DispatchBudget, DispatchCheck, DispatchEvent, DispatchView, DispatchExecutorKind, DispatchJob, DispatchOrigin, DispatchProgress } from "@shared/types";

// The dispatch core's scheduler: every "hand this to an agent" goes through here.
// - one queue: a job waits until its executor is free (never typed into a busy session)
// - a global cap on jobs running at once (a job started by a running job is exempt: its tree is
//   already admitted, and holding it back could leave the parent waiting forever)
// - jobs form trees; each tree has a budget, so two agents can't ping-pong forever
// - cancelling a job cancels everything it started
// - jobs may share a lane (a cross-project session's timeline): a lane runs one job at a time
// - optional guards around each run: a preflight that can refuse it, and acceptance checks after
// It knows nothing about terminals or models: executors (dispatch/cli.ts, …) do the work.

/** Something that can take a job: a terminal session, an AgentSession, a model. */
export interface Executor {
  readonly kind: DispatchExecutorKind;
  /** Stable id, e.g. the PeerBus session id. */
  readonly ref: string;
  readonly name: string;
  /** Free to start a job now (not starting up, not busy with the user's own work). */
  ready(): boolean;
  /** False once it is gone for good (tab closed). */
  alive(): boolean;
  /** Where it can write and whether it can reach the network, for the preflight. Unknown = not checked. */
  env?(): { writableRoots?: string[]; network?: boolean | "ask" };
  /** Do the job. Resolves with its final text, or null when it ended without one. */
  run(job: DispatchJob, signal: AbortSignal): Promise<{ text: string; outcome?: string } | null>;
  /**
   * Fix what the acceptance found in the job it just did, and resolve like `run`. Only for
   * executors that still hold the job's context (a terminal session): there it is one short turn,
   * where anyone else would have to do the whole job again.
   */
  rework?(job: DispatchJob, problems: string, signal: AbortSignal): Promise<{ text: string; outcome?: string } | null>;
}

export interface SubmitInput {
  executor: Executor;
  input: string;
  origin: DispatchOrigin;
  from: string;
  /** The job this one was started from; it then shares (and spends) that tree's budget. */
  parentId?: string;
  timeoutMs?: number;
  scope?: DispatchJob["scope"];
  needs?: DispatchJob["needs"];
  verify?: DispatchJob["verify"];
  /**
   * Jobs with the same lane run one at a time, whatever their executors. Oldest first among those
   * whose executor is free: a job waiting for a busy executor doesn't hold the lane's others back.
   */
  lane?: string;
  /** It carries a job's result back to whoever asked: it costs no budget and gets through when the tree's is spent. */
  reply?: boolean;
}

export interface Submitted {
  job: DispatchJob;
  /** Resolves with the job once it has ended, whatever the outcome. */
  done: Promise<DispatchJob>;
}

export interface DispatcherOptions {
  emit(e: DispatchEvent): void;
  /** Jobs running at once (LEGION: usually no more than 4). */
  maxRunning?: number;
  /** Jobs a tree may hold, by the origin of its root. */
  budget?: Partial<Record<DispatchOrigin, number>>;
  /** Finished jobs kept for the console. */
  keep?: number;
  defaultTimeoutMs?: number;
  /** How long a job may wait in the queue before it is given up as timed out (default an hour). */
  queueTimeoutMs?: number;
  /** Before a job runs. A "fail" check refuses it. */
  preflight?(job: DispatchJob, executor: Executor): Promise<DispatchCheck | null>;
  /** Acceptance around a run: `before` right before it starts, `after` once it has a result. */
  verifier?: {
    before(job: DispatchJob, signal: AbortSignal): Promise<unknown>;
    after(job: DispatchJob, state: unknown, signal: AbortSignal): Promise<DispatchCheck[]>;
    /** The job is over, however it ended (also when `after` was never reached). */
    end?(job: DispatchJob): void;
  };
}

const FINISHED = new Set<DispatchJob["status"]>(["done", "failed", "cancelled", "timeout", "exited"]);
/** An agent chain the user didn't start stays short; the user's own requests get room to fan out. */
const DEFAULT_BUDGET: Record<DispatchOrigin, number> = {
  agent: 5,
  user: 20,
  chat: 20,
  automation: 30,
  cluster: 20,
  session: 20,
  wechat: 20,
};

interface Entry {
  job: DispatchJob;
  executor: Executor;
  controller: AbortController;
  /** Why it was aborted, once it was. */
  abortedFor?: "cancelled" | "timeout";
  lane?: string;
  resolve(job: DispatchJob): void;
}

export class Dispatcher {
  private readonly entries = new Map<string, Entry>();
  /** Queued job ids, oldest first. */
  private queue: string[] = [];
  private readonly budgets = new Map<string, DispatchBudget>();
  private readonly finished: DispatchJob[] = [];
  private readonly maxRunning: number;
  private readonly keep: number;
  private readonly defaultTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly timer: NodeJS.Timeout;
  private readonly opts: DispatcherOptions;

  // No parameter properties: the tests run this file under Node's type stripping.
  constructor(opts: DispatcherOptions) {
    this.opts = opts;
    this.maxRunning = opts.maxRunning ?? 4;
    this.keep = opts.keep ?? 200;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30 * 60_000;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 60 * 60_000;
    // Executors also call pump() when they change; this only catches what they miss.
    this.timer = setInterval(() => this.pump(), 2000);
    this.timer.unref();
  }

  submit(input: SubmitInput): Submitted | { error: string } {
    const parent = input.parentId ? this.find(input.parentId) : undefined;
    const id = randomUUID();
    const rootId = parent?.rootId ?? id;
    let budget = this.budgets.get(rootId);
    if (!budget) {
      const total = this.opts.budget?.[input.origin] ?? DEFAULT_BUDGET[input.origin];
      budget = { rootId, left: total, total };
      this.budgets.set(rootId, budget);
    }
    // An answer is owed for a job that was already paid for.
    if (!input.reply) {
      if (budget.left <= 0) {
        this.opts.emit({ type: "budget_exhausted", rootId, refused: { from: input.from, to: input.executor.name, input: input.input } });
        return { error: `这串任务已经派了 ${budget.total} 次，先停下来等用户确认再继续。把情况告诉用户。` };
      }
      budget.left--;
    }

    const job: DispatchJob = {
      id,
      parentId: parent?.id,
      rootId,
      origin: parent?.origin ?? input.origin,
      from: input.from,
      executor: { kind: input.executor.kind, ref: input.executor.ref, name: input.executor.name },
      input: input.input,
      scope: input.scope,
      needs: input.needs,
      verify: input.verify,
      limits: { timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs },
      status: "queued",
      createdAt: Date.now(),
      ...(input.reply ? { reply: true } : {}),
    };
    let resolve!: (job: DispatchJob) => void;
    const done = new Promise<DispatchJob>((r) => (resolve = r));
    this.entries.set(id, { job, executor: input.executor, controller: new AbortController(), lane: input.lane, resolve });
    this.queue.push(id);
    this.changed(job);
    this.pump();
    return { job: { ...job }, done };
  }

  /** Bounded recent ACP data; main-process events and the throttled console share it. */
  progress(jobId: string, progress: DispatchProgress): void {
    const entry = this.entries.get(jobId);
    if (!entry || this.isQueued(entry) || entry.abortedFor) return;
    entry.job.progress = [...(entry.job.progress ?? []), progress].slice(-100);
    if (progress.type === "permission") entry.job.status = "waiting_approval";
    else if (progress.type === "status" && progress.text === "running") entry.job.status = "running";
    this.opts.emit({ type: "progress", jobId, progress });
    this.changed(entry.job);
  }

  /** Cancel a job and every job it started, queued or running. */
  cancel(jobId: string): void {
    for (const id of [jobId, ...this.descendants(jobId)]) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.job.status === "queued") {
        this.queue = this.queue.filter((q) => q !== id);
        this.finish(e, "cancelled");
      } else if (!e.abortedFor) {
        e.abortedFor = "cancelled";
        // The reason travels with the signal: an executor stops its session for a cancel, not for a timeout.
        e.controller.abort("cancelled");
      }
    }
  }

  /** The job an executor is working on for the dispatcher, if any. */
  current(ref: string): DispatchJob | undefined {
    for (const e of this.entries.values()) if (e.job.executor.ref === ref && !this.isQueued(e)) return { ...e.job };
    return undefined;
  }

  /** The newest unfinished job for an executor (running first, then queued). */
  pending(ref: string): { job: DispatchJob; done: Promise<DispatchJob> } | undefined {
    const live = [...this.entries.values()].filter((e) => e.job.executor.ref === ref);
    const e = live.find((x) => !this.isQueued(x)) ?? live.at(-1);
    if (!e) return undefined;
    return { job: { ...e.job }, done: new Promise((r) => this.whenDone(e.job.id, r)) };
  }

  jobs(): DispatchJob[] {
    return [...[...this.entries.values()].map((e) => ({ ...e.job })), ...this.finished.map((j) => ({ ...j }))];
  }

  view(): DispatchView {
    const live = [...this.entries.values()];
    const queued = live.filter((e) => this.isQueued(e)).length;
    return {
      jobs: this.jobs(),
      budgets: [...this.budgets.values()].map((b) => ({ ...b })),
      running: live.length - queued,
      queued,
      maxRunning: this.maxRunning,
    };
  }

  /** The job an executor finished most recently, while it is still listed. */
  last(ref: string): DispatchJob | undefined {
    const job = this.finished.find((j) => j.executor.ref === ref);
    return job && { ...job };
  }

  /** Stop-state marker, also visible to the existing console without a new renderer switch. */
  markNeedsReview(ref: string, reason: string, count = 3, kind: DispatchExecutorKind = "session", name = "sikeoop 内置 AI"): DispatchJob {
    const live = [...this.entries.values()].find(e => e.job.executor.ref === ref);
    let job = live?.job ?? this.finished.find(j => j.executor.ref === ref);
    if (!job) {
      const id = randomUUID();
      job = { id, rootId: id, origin: "user", from: "sikeoop", executor: { kind, ref, name },
        input: "自动续跑已停止，需人工查看", limits: { timeoutMs: 0 }, status: "failed",
        createdAt: Date.now(), endedAt: Date.now() };
      this.finished.unshift(job);
      this.finished.length = Math.min(this.finished.length, this.keep);
    }
    job.needsReview = true;
    job.autoResumeCount = count;
    job.error = reason;
    job.checks = [...(job.checks ?? []).filter(c => c.summary !== reason),
      { kind: "claims", level: "fail", summary: reason }];
    if (!live) job.status = "failed";
    this.changed(job);
    return { ...job };
  }

  /** Finished jobs from an earlier run of the app (newest first), shown in the console as history. */
  restore(jobs: DispatchJob[]): void {
    this.finished.length = 0;
    // A job still going here has only its "started" line in the log, which reads as cut off by a
    // quit: it is listed once, live, not a second time as history.
    this.finished.push(...jobs.filter((j) => !this.entries.has(j.id)).slice(0, this.keep).map((j) => ({ ...j })));
  }

  budget(rootId: string): DispatchBudget | undefined {
    const b = this.budgets.get(rootId);
    return b && { ...b };
  }

  /** Start whatever can start. Call it whenever an executor may have become free. */
  pump(): void {
    let running = [...this.entries.values()].filter((e) => !this.isQueued(e)).length;
    for (const id of [...this.queue]) {
      const e = this.entries.get(id)!;
      // Its executor never came free (stuck waiting for the user, say): it doesn't wait for ever.
      const waited = Date.now() - e.job.createdAt;
      if (waited >= this.queueTimeoutMs) {
        this.queue = this.queue.filter((q) => q !== id);
        this.finish(e, "timeout", `排了 ${Math.round(waited / 60_000)} 分钟的队，一直没轮到 ${e.executor.name}`);
        continue;
      }
      const parentRunning = !!e.job.parentId && this.entries.get(e.job.parentId)?.job.status === "running";
      if (running >= this.maxRunning && !parentRunning) continue;
      if (!e.executor.alive()) {
        this.queue = this.queue.filter((q) => q !== id);
        this.finish(e, "exited", `${e.executor.name} 已经退出`);
        continue;
      }
      if (this.current(e.executor.ref) || !e.executor.ready()) continue;
      if (e.lane !== undefined && this.laneBusy(e.lane)) continue;
      this.queue = this.queue.filter((q) => q !== id);
      running++;
      void this.start(e);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const id of [...this.entries.keys()]) this.cancel(id);
  }

  private async start(e: Entry): Promise<void> {
    e.job.status = "running";
    e.job.startedAt = Date.now();
    this.changed(e.job);
    const refused = await this.guardStart(e);
    if (refused) {
      // Cancelled while it was being checked: that is how it ended, whatever the check then said.
      this.finish(e, e.abortedFor ?? "failed", e.abortedFor ? undefined : refused);
      this.pump();
      return;
    }
    let state: unknown;
    try {
      state = await this.opts.verifier?.before({ ...e.job }, e.controller.signal);
    } catch {
      state = undefined;
    }
    const timer = setTimeout(() => {
      if (e.abortedFor) return;
      e.abortedFor = "timeout";
      e.controller.abort("timeout");
    }, e.job.limits.timeoutMs);
    timer.unref();
    try {
      // The checks above can take a while (a baseline typecheck). Meanwhile the job may have been
      // cancelled, or its executor taken or closed (the user typed into the terminal themselves):
      // it is not handed over until the executor is free again, and not at all once cancelled.
      await this.untilFree(e);
      if (e.abortedFor) return this.finish(e, e.abortedFor);
      if (!e.executor.alive()) return this.finish(e, "exited", `${e.executor.name} 已经退出`);
      const ranAt = Date.now();
      const result = await e.executor.run({ ...e.job }, e.controller.signal);
      clearTimeout(timer);
      const left = e.job.limits.timeoutMs - (Date.now() - ranAt);
      // Aborted while it ran: that is how it ended. A cancel that only arrives during the acceptance
      // below finds the work already done, and doesn't turn it into a cancelled job.
      let aborted: Entry["abortedFor"] = e.abortedFor;
      if (result) e.job.result = result;
      else if (e.executor.kind === "agent") e.job.result = { text: "" };
      if ((result && !aborted) || e.executor.kind === "agent") await this.checkAfter(e, state);
      // A rework is the executor at work again: aborted there, the job ends that way.
      if (result && !aborted) aborted = await this.rework(e, state, left);
      if (aborted) this.finish(e, aborted);
      else if (e.job.needsReview) this.finish(e, "failed", e.job.error, e.job.result);
      else if (result) this.finish(e, e.executor.kind === "agent" && result.outcome === "cancelled" ? "cancelled" : "done", undefined, e.job.result);
      else if (!e.executor.alive()) this.finish(e, "exited", `${e.executor.name} 已经退出`);
      else this.finish(e, "failed", "没有拿到结果");
    } catch (err) {
      if (e.executor.kind === "agent") {
        e.job.result ??= { text: "" };
        await this.checkAfter(e, state);
      }
      this.finish(e, e.abortedFor ?? "failed", e.abortedFor ? undefined : err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      this.pump();
    }
  }

  private async checkAfter(e: Entry, state: unknown): Promise<void> {
    if (!this.opts.verifier || state === undefined) return;
    let checks: DispatchCheck[];
    const wasAborted = !!e.abortedFor;
    try {
      checks = await this.opts.verifier.after({ ...e.job }, state, e.controller.signal);
    } catch (err) {
      checks = [{ kind: "files", level: "warn", summary: `自动验收出错：${err instanceof Error ? err.message : String(err)}` }];
    }
    if (!wasAborted && e.abortedFor) checks.push({ kind: "files", level: "warn", summary: "任务已经做完；自动验收中途被取消，结果可能不全" });
    e.job.checks = [...(e.job.checks ?? []), ...checks];
  }

  /**
   * New type errors go back to the executor once, before the coordinator has to read them and hand
   * the job out again. Only type errors: files changed outside `owns` are left as they are and
   * shown, because having them "put back" would be a rollback nobody asked for.
   * Resolves with why the job was aborted, if it was aborted during the rework.
   */
  private async rework(e: Entry, state: unknown, leftMs: number): Promise<Entry["abortedFor"]> {
    const failed = e.job.checks?.find((c) => c.kind === "typecheck" && c.level === "fail");
    if (!failed || !e.executor.rework || e.job.reworks || e.abortedFor || !e.executor.alive()) return undefined;
    e.job.reworks = 1;
    this.changed(e.job);
    const gaveUp = (why: string) => e.job.checks!.push({ kind: "typecheck", level: "warn", summary: `自动返工没做成（${why}），上面是第一轮的结果` });
    // Still the same job: the rework gets what is left of its time.
    const timer = setTimeout(() => {
      if (e.abortedFor) return;
      e.abortedFor = "timeout";
      e.controller.abort("timeout");
    }, Math.max(leftMs, 0));
    timer.unref();
    try {
      // The acceptance took a while; the user may be typing into the terminal by now.
      await this.untilFree(e);
      if (e.abortedFor) return e.abortedFor;
      if (!e.executor.alive()) return void gaveUp(`${e.executor.name} 已经退出`);
      const second = await e.executor.rework({ ...e.job }, [failed.summary, ...(failed.details ?? [])].join("\n"), e.controller.signal);
      if (e.abortedFor) return e.abortedFor;
      if (!second) return void gaveUp("没有拿到结果");
      clearTimeout(timer);
      e.job.result = second;
      // Checked against the same baseline as the first round, whose acceptance this replaces.
      e.job.checks = e.job.checks!.filter((c) => c.kind === "preflight");
      await this.checkAfter(e, state);
      return undefined;
    } catch (err) {
      if (e.abortedFor) return e.abortedFor;
      return void gaveUp(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** The preflight's verdict: a reason to refuse, or null. Its check is kept on the job either way. */
  private async guardStart(e: Entry): Promise<string | null> {
    if (!this.opts.preflight) return null;
    let check: DispatchCheck | null;
    try {
      check = await this.opts.preflight({ ...e.job }, e.executor);
    } catch (err) {
      check = { kind: "preflight", level: "fail", summary: "派活前检查出错", details: [err instanceof Error ? err.message : String(err)] };
    }
    if (!check) return null;
    e.job.checks = [check];
    return check.level === "fail" ? [check.summary, ...(check.details ?? [])].join("；") : null;
  }

  /** Resolves once the job's executor can take it, or the job was aborted, or the executor is gone. */
  private async untilFree(e: Entry): Promise<void> {
    const signal = e.controller.signal;
    while (!e.abortedFor && e.executor.alive() && !e.executor.ready()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 300);
        timer.unref();
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  private finish(e: Entry, status: DispatchJob["status"], error?: string, result?: DispatchJob["result"]): void {
    if (FINISHED.has(e.job.status)) return;
    e.job.status = status;
    e.job.endedAt = Date.now();
    if (error) e.job.error = error;
    if (result) e.job.result = result;
    this.entries.delete(e.job.id);
    this.finished.unshift({ ...e.job });
    this.finished.length = Math.min(this.finished.length, this.keep);
    this.dropIdleBudgets();
    this.opts.verifier?.end?.({ ...e.job });
    this.changed(e.job);
    e.resolve({ ...e.job });
    for (const w of this.waiters.get(e.job.id) ?? []) w({ ...e.job });
    this.waiters.delete(e.job.id);
  }

  private readonly waiters = new Map<string, Set<(job: DispatchJob) => void>>();
  private whenDone(id: string, cb: (job: DispatchJob) => void): void {
    let set = this.waiters.get(id);
    if (!set) this.waiters.set(id, (set = new Set()));
    set.add(cb);
  }

  /** Every job started from this one, directly or not. Followed through jobs that have already finished. */
  private descendants(id: string): string[] {
    const children = new Map<string, string[]>();
    for (const job of [...[...this.entries.values()].map((e) => e.job), ...this.finished]) {
      if (!job.parentId) continue;
      const list = children.get(job.parentId);
      if (list) list.push(job.id);
      else children.set(job.parentId, [job.id]);
    }
    const out: string[] = [];
    const walk = (parent: string) => {
      for (const child of children.get(parent) ?? []) {
        out.push(child);
        walk(child);
      }
    };
    walk(id);
    return out;
  }

  private find(id: string): DispatchJob | undefined {
    return this.entries.get(id)?.job ?? this.finished.find((j) => j.id === id);
  }

  private laneBusy(lane: string): boolean {
    for (const e of this.entries.values()) if (e.lane === lane && !this.isQueued(e)) return true;
    return false;
  }

  private isQueued(e: Entry): boolean {
    return e.job.status === "queued";
  }

  /** A tree's budget is kept while any of its jobs is still listed. */
  private dropIdleBudgets(): void {
    const live = new Set([...[...this.entries.values()].map((e) => e.job.rootId), ...this.finished.map((j) => j.rootId)]);
    for (const rootId of this.budgets.keys()) if (!live.has(rootId)) this.budgets.delete(rootId);
  }

  private changed(job: DispatchJob): void {
    this.opts.emit({ type: "job", job: { ...job } });
  }
}
