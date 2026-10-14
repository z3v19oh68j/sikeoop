import { parseBrowserFlowNode } from "./browser-flow.ts";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { powerMonitor } from "electron";
import {
  AUTOMATION_END,
  AUTOMATION_FAIL,
  AUTOMATION_OK,
  type AgentEvent,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationState,
  type AutomationStep,
  type AutomationView,
  type Effort,
} from "@shared/types";
import type { AgentSession } from "../agent/loop";
import { GIT_BASH_MISSING, findBash } from "../shell-env.ts";
import { blockedReason, execute } from "../tools/command-tools.ts";
import type { ToolSpec } from "../tools/registry";
import { nextRun, scheduleProblem } from "./schedule.ts";
import { reportOutcomeTool } from "./tools.ts";

// Automations: a small state machine the user draws (steps and where each outcome leads), started
// by a schedule or by hand. Agent steps are messages in one conversation per run, in lazy mode
// (nobody is at the computer); command steps run a bash command without the AI. Automations
// belong to a project and only run while that project is open: the agent's tools work on the
// open project folder. One run at a time, and a scheduled run waits while the chat is working.

/** How often the schedule is checked. */
const TICK_MS = 20_000;
/** A run overdue by more than this (app closed, computer asleep, other project open) is skipped, not caught up. */
const MISSED_AFTER_MS = 60 * 60_000;
/** An agent step taking longer is stopped (e.g. stuck waiting on an approval only a person can give). */
const AGENT_STEP_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const KEEP_RUNS = 50;
const MAX_AUTOMATIONS = 30;
const MAX_STATES = 20;
const MAX_TEXT = 8000;

interface Store {
  root: string;
  file: string;
  automations: Automation[];
  runs: AutomationRun[];
  /** Writes in order, so two saves never race on the temp file. */
  writing: Promise<void>;
}

/** What the running agent step has done so far, filled from its events. */
interface Live {
  step: AutomationStep | null;
  /** The text of the latest model reply (reset before each model call). */
  text: string;
  done: Extract<AgentEvent, { type: "done" }>["reason"] | null;
  error: string;
  allowed: string[];
  reported: { outcome: string; summary: string } | null;
}

export class AutomationService {
  /** The open project's store, loaded once per project. */
  private loaded: { root: string; store: Promise<Store> } | null = null;
  private current: { run: AutomationRun; controller: AbortController } | null = null;
  private ticking = false;
  private publishTimer: NodeJS.Timeout | null = null;

  private readonly opts: {
      dir: string;
      root(): string | null;
      /** The main chat is working: a scheduled run waits for it. */
      chatBusy(): boolean;
      runBrowserFlow(name:string,vars:Record<string,string>,signal:AbortSignal):Promise<import('../../shared/types.ts').BrowserFlowRunResult>;
      /**
       * Runs one step as a job of the dispatch core. Every step of a run (and whatever it hands on to
       * other agents) shares one budget, so states sending each other back and forth can't loop forever.
       */
      runStep(step: {
        runId: string;
        title: string;
        input: string;
        timeoutMs: number;
        /** The run's first job; later steps join its tree. */
        parentId?: string;
        signal: AbortSignal;
        run(jobId: string, signal: AbortSignal): Promise<{ outcome: string; summary: string }>;
      }): Promise<{ jobId: string; result: { outcome: string; summary: string } | null; why: string } | { error: string }>;
      /** A separate conversation for one run, with the extra tools. Its events don't go to the chat. */
      createSession(emit: (e: AgentEvent) => void, tools: ToolSpec[]): AgentSession;
      emit(v: AutomationView): void;
      /** Files may have changed: refresh the file tree and open files. */
      workspaceChanged(): void;
      finished(run: AutomationRun): void;
    };
  constructor(opts: AutomationService["opts"]) { this.opts=opts; }

  start(): void {
    setInterval(() => void this.tick(), TICK_MS);
    // Back from sleep: catch up right away instead of on the next tick.
    powerMonitor.on("resume", () => void this.tick());
    void this.tick();
  }

  /** The id of the conversation a run is using right now, if any. */
  get runningSession(): string | null {
    return this.current?.run.sessionId ?? null;
  }

  async view(): Promise<AutomationView> {
    const store = await this.load();
    return store ? this.viewOf(store) : { automations: [], runs: [], runningId: null };
  }

  async save(input: AutomationInput): Promise<AutomationView> {
    const store = await this.need();
    const clean = sanitize(input);
    const now = Date.now();
    const old = input.id ? store.automations.find((a) => a.id === input.id) : undefined;
    if (!old && store.automations.length >= MAX_AUTOMATIONS) throw new Error(`一个项目最多 ${MAX_AUTOMATIONS} 个自动化任务`);
    const a: Automation = {
      ...clean,
      id: old?.id ?? randomUUID(),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: clean.enabled ? nextRun(clean.schedule, now) : null,
    };
    store.automations = old ? store.automations.map((x) => (x.id === a.id ? a : x)) : [...store.automations, a];
    await this.write(store);
    return this.publish(store);
  }

  async remove(id: string): Promise<AutomationView> {
    const store = await this.need();
    if (this.current?.run.automationId === id) this.stop();
    store.automations = store.automations.filter((a) => a.id !== id);
    await this.write(store);
    return this.publish(store);
  }

  async setEnabled(id: string, on: boolean): Promise<AutomationView> {
    const store = await this.need();
    const a = store.automations.find((x) => x.id === id);
    if (!a) throw new Error("找不到这个自动化任务");
    a.enabled = on;
    a.nextRunAt = on ? nextRun(a.schedule, Date.now()) : null;
    await this.write(store);
    return this.publish(store);
  }

  async runNow(id: string): Promise<void> {
    const store = await this.need();
    const a = store.automations.find((x) => x.id === id);
    if (!a) throw new Error("找不到这个自动化任务");
    if (this.current) throw new Error("已经有一个自动化任务在运行，等它跑完或者先停下");
    if (this.opts.chatBusy()) throw new Error("AI 正在对话里工作，等它停下再运行");
    void this.execute(store, a, "manual");
  }

  /** Stop the run in progress (also before the project is switched: its tools would work on the new folder). */
  stop(): void {
    this.current?.controller.abort();
  }

  private async need(): Promise<Store> {
    const store = await this.load();
    if (!store) throw new Error("先打开一个项目，自动化任务是跟着项目走的");
    return store;
  }

  private load(): Promise<Store | null> {
    const root = this.opts.root();
    if (!root) return Promise.resolve(null);
    if (this.loaded?.root !== root) this.loaded = { root, store: this.read(root) };
    return this.loaded.store;
  }

  private async read(root: string): Promise<Store> {
    const file = path.join(this.opts.dir, createHash("sha256").update(root).digest("hex").slice(0, 16), "automations.json");
    let data: { automations?: Automation[]; runs?: AutomationRun[] } = {};
    try {
      data = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // None yet.
    }
    const runs = data.runs ?? [];
    // A run that was going when sikeoop quit can't be picked up again.
    for (const r of runs) {
      if (r.status !== "running") continue;
      r.status = "cancelled";
      r.note = "sikeoop 关掉了，这次没跑完";
      r.endedAt ??= r.steps[r.steps.length - 1]?.startedAt ?? r.startedAt;
    }
    return { root, file, automations: data.automations ?? [], runs, writing: Promise.resolve() };
  }

  private write(store: Store): Promise<void> {
    store.writing = store.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(store.file), { recursive: true });
        const tmp = `${store.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ root: store.root, automations: store.automations, runs: store.runs }), "utf8");
        await fs.rename(tmp, store.file);
      } catch (err) {
        console.error("[automation] could not save:", err);
      }
    });
    return store.writing;
  }

  private viewOf(store: Store): AutomationView {
    return { automations: store.automations, runs: store.runs, runningId: this.current?.run.automationId ?? null };
  }

  /** Send the view to the window, if the store still belongs to the open project. */
  private publish(store: Store): AutomationView {
    const v = this.viewOf(store);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    if (store.root === this.opts.root()) this.opts.emit(v);
    return v;
  }

  /** For live progress (tool names, command output): at most a few updates a second. */
  private publishSoon(store: Store): void {
    if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(store), 500);
  }

  private async tick(): Promise<void> {
    if (this.current || this.ticking) return;
    this.ticking = true;
    try {
      const store = await this.load();
      if (!store) return;
      const now = Date.now();
      for (const a of store.automations) {
        if (!a.enabled || a.nextRunAt === null || a.nextRunAt > now) continue;
        if (now - a.nextRunAt > MISSED_AFTER_MS) {
          store.runs.unshift({
            id: randomUUID(),
            automationId: a.id,
            name: a.name,
            trigger: "schedule",
            status: "missed",
            startedAt: a.nextRunAt,
            endedAt: a.nextRunAt,
            steps: [],
            note: "到点的时候 sikeoop 没开着、电脑在睡眠，或者打开的不是这个项目，这次跳过了",
          });
          store.runs.length = Math.min(store.runs.length, KEEP_RUNS);
          a.nextRunAt = nextRun(a.schedule, now);
          await this.write(store);
          this.publish(store);
          continue;
        }
        // The chat is working on this project: wait for it, the next tick tries again.
        if (this.opts.chatBusy()) return;
        void this.execute(store, a, "schedule");
        return;
      }
    } finally {
      this.ticking = false;
    }
  }

  private async execute(store: Store, a: Automation, trigger: AutomationRun["trigger"]): Promise<void> {
    const controller = new AbortController();
    const run: AutomationRun = { id: randomUUID(), automationId: a.id, name: a.name, trigger, status: "running", startedAt: Date.now(), steps: [] };
    this.current = { run, controller };
    // Rescheduled before the run, so a long run isn't started a second time.
    if (trigger === "schedule") a.nextRunAt = nextRun(a.schedule, Date.now());
    store.runs.unshift(run);
    store.runs.length = Math.min(store.runs.length, KEEP_RUNS);
    void this.write(store);
    this.publish(store);

    const live: Live = { step: null, text: "", done: null, error: "", allowed: [], reported: null };
    let session: AgentSession | null = null;
    const sessionFor = (): AgentSession => {
      if (!session) {
        session = this.opts.createSession(
          (e) => this.onAgentEvent(e, live, store),
          [
            reportOutcomeTool((outcome, summary) => {
              if (!live.allowed.includes(outcome)) return `"${outcome}" is not an outcome of this step. Use one of: ${live.allowed.join(", ")}.`;
              live.reported = { outcome, summary };
              return null;
            }),
          ],
        );
        run.sessionId = session.sessionId;
      }
      return session;
    };

    let status: AutomationRun["status"] = "ok";
    try {
      let stateId = a.start;
      let outcome = AUTOMATION_OK;
      let rootJob: string | undefined;
      while (stateId !== AUTOMATION_END) {
        if (controller.signal.aborted) {
          status = "cancelled";
          break;
        }
        const state = a.states.find((s) => s.id === stateId);
        if (!state) {
          run.note = `找不到下一步（${stateId}）`;
          status = "failed";
          break;
        }
        const step: AutomationStep = { stateId: state.id, name: state.name, kind: state.kind, startedAt: Date.now() };
        run.steps.push(step);
        this.publish(store);
        const job = await this.opts.runStep({
          runId: run.id,
          title: `${a.name} · ${state.name}`,
          input: state.kind === "command" ? state.text : state.name,
          // The step's own timer stops it first; this only backs it up.
          timeoutMs: (state.kind === "command" ? COMMAND_TIMEOUT_MS : AGENT_STEP_TIMEOUT_MS) + 60_000,
          parentId: rootJob,
          signal: controller.signal,
          run: (jobId, signal) =>
            state.kind === "command"
              ? this.runCommand(store, state, step, signal)
              : state.kind === "browser_flow"
                ? this.runBrowserFlow(state, signal)
                : this.runAgent(sessionFor(), a, state, run.steps, live, signal, jobId),
        });
        if ("error" in job) {
          run.note = `走了 ${run.steps.length - 1} 步还没结束，可能是几个步骤在互相来回跳，先停下了（${job.error}）`;
          run.steps.pop();
          status = "failed";
          break;
        }
        rootJob ??= job.jobId;
        const r = job.result ?? { outcome: AUTOMATION_FAIL, summary: job.why };
        step.outcome = r.outcome;
        step.summary = r.summary.slice(0, 2000);
        step.endedAt = Date.now();
        delete step.activity;
        if (controller.signal.aborted) {
          status = "cancelled";
          break;
        }
        outcome = r.outcome;
        stateId = state.next.find((t) => t.on === r.outcome)?.to ?? AUTOMATION_END;
      }
      // An outcome with nowhere to go ends the run; ending on "fail" means the run failed.
      if (status === "ok" && outcome === AUTOMATION_FAIL) status = "failed";
    } catch (err) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      if (status === "failed") run.note = (err as Error).message.slice(0, 500);
    } finally {
      for (const s of run.steps) {
        if (s.endedAt) continue;
        s.endedAt = Date.now();
        delete s.activity;
      }
      run.status = status;
      run.endedAt = Date.now();
      this.current = null;
      await this.write(store);
      this.publish(store);
      this.opts.finished(run);
    }
  }

  private onAgentEvent(e: AgentEvent, live: Live, store: Store): void {
    if (e.type === "status" && e.state === "thinking") live.text = "";
    else if (e.type === "text_delta") live.text = (live.text + e.text).slice(-4000);
    else if (e.type === "done") live.done = e.reason;
    else if (e.type === "error") live.error = e.message;
    else if (e.type === "tool_start" && live.step) {
      live.step.activity = e.summary;
      this.publishSoon(store);
    } else if (e.type === "file_changed" || e.type === "workspace_changed") this.opts.workspaceChanged();
  }

  private async runAgent(
    session: AgentSession,
    a: Automation,
    state: AutomationState,
    steps: AutomationStep[],
    live: Live,
    signal: AbortSignal,
    jobId: string,
  ): Promise<{ outcome: string; summary: string }> {
    const step = steps[steps.length - 1];
    Object.assign(live, { step, text: "", done: null, error: "", allowed: outcomesOf(state), reported: null });
    step.activity = "思考中";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      session.cancel();
    }, AGENT_STEP_TIMEOUT_MS);
    const onAbort = () => session.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    session.dispatchJobId = jobId;
    try {
      await session.send({ text: stepMessage(a, state, steps), editor: {}, effort: a.effort, autopilot: true, lazy: true });
    } finally {
      session.dispatchJobId = undefined;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      live.step = null;
    }
    if (live.reported) return live.reported;
    if (live.done === "end_turn") return { outcome: AUTOMATION_OK, summary: live.text.trim().slice(-600) || "（AI 做完了，没有写总结）" };
    const why = timedOut
      ? `超过 ${AGENT_STEP_TIMEOUT_MS / 60_000} 分钟还没做完，停下了`
      : live.error || { step_limit: "步数用完了，还没做完", refusal: "模型拒绝了这个请求", cancelled: "停下了" }[live.done ?? "cancelled"];
    return { outcome: AUTOMATION_FAIL, summary: why };
  }

  private async runBrowserFlow(state:AutomationState, signal:AbortSignal):Promise<{outcome:string;summary:string}> {
    try {
      const {name,vars}=parseBrowserFlowNode(state.text);
      const result=await this.opts.runBrowserFlow(name,vars,signal);
      return {outcome:result.failedStep===null?AUTOMATION_OK:AUTOMATION_FAIL, summary:JSON.stringify(result)};
    } catch(error) {return {outcome:AUTOMATION_FAIL,summary:(error as Error).message};}
  }

  private async runCommand(store: Store, state: AutomationState, step: AutomationStep, signal: AbortSignal): Promise<{ outcome: string; summary: string }> {
    const bash = findBash();
    if (!bash) return { outcome: AUTOMATION_FAIL, summary: GIT_BASH_MISSING };
    const why = blockedReason(state.text);
    if (why) return { outcome: AUTOMATION_FAIL, summary: `这条命令为了安全不能运行（${why}）` };
    step.activity = "运行中";
    let line = "";
    const res = await execute(bash, state.text, store.root, COMMAND_TIMEOUT_MS, signal, (chunk) => {
      line = (line + chunk).split("\n").filter((l) => l.trim()).pop()?.slice(-200) ?? line;
      step.activity = line;
      this.publishSoon(store);
    });
    this.opts.workspaceChanged();
    const head = res.timedOut ? `超过 ${COMMAND_TIMEOUT_MS / 60_000} 分钟，停下了` : res.cancelled ? "停下了" : `退出码 ${res.exitCode}`;
    return {
      outcome: res.exitCode === 0 && !res.timedOut && !res.cancelled ? AUTOMATION_OK : AUTOMATION_FAIL,
      summary: `${head}\n${res.output.slice(-1500)}`.trim(),
    };
  }
}

/** The outcomes an agent step may report: the built-in two plus the step's own branches. */
function outcomesOf(state: AutomationState): string[] {
  return [...new Set([AUTOMATION_OK, AUTOMATION_FAIL, ...state.next.map((t) => t.on)])];
}

function stepMessage(a: Automation, state: AutomationState, steps: AutomationStep[]): string {
  const custom = outcomesOf(state).slice(2);
  // The step before may have been a command the AI never saw: pass on how it ended.
  const prev = steps[steps.length - 2];
  const before = prev
    ? `上一步「${prev.name}」（${prev.kind === "command" ? "命令" : "AI"}）的结果是 ${prev.outcome}：\n${prev.summary ?? ""}\n\n`
    : "";
  return `⏰ 自动化「${a.name}」· 第 ${steps.length} 步：${state.name}

<automation>
这是用户设好的自动化任务，按时间表自己运行，用户不在电脑前：不要停下来提问，需要选择时按最稳妥的做法来。
${before}这一步的工作做完以后，调用 report_outcome 报告结果，自动化会按结果决定下一步。结果只能是下面之一：
- ${AUTOMATION_OK}：这一步顺利完成
- ${AUTOMATION_FAIL}：没做成，或者遇到了做不了的问题
${custom.map((o) => `- ${o}`).join("\n")}
</automation>

${state.text}`.replace(/\n\n\n+/g, "\n\n");
}

/** Builds the automation from what the window sent, checking everything; throws a message for the user. */
function sanitize(input: AutomationInput): Omit<Automation, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(input?.name, 40);
  if (!name) throw new Error("给自动化任务起个名字吧");
  const rawStates = Array.isArray(input.states) ? input.states : [];
  if (!rawStates.length) throw new Error("至少要有一个步骤");
  if (rawStates.length > MAX_STATES) throw new Error(`最多 ${MAX_STATES} 个步骤`);

  const states: AutomationState[] = rawStates.map((s, i) => {
    const id = str(s?.id, 40);
    if (!/^[a-z0-9-]+$/i.test(id) || id === AUTOMATION_END) throw new Error(`第 ${i + 1} 步的编号不对`);
    const stepName = str(s.name, 40) || `第 ${i + 1} 步`;
    const kind = s.kind === "command" ? "command" : s.kind === "browser_flow" ? "browser_flow" : "agent";
    const text = str(s.text, MAX_TEXT);
    if (!text) throw new Error(`「${stepName}」还没写${kind === "command" ? "要运行的命令" : "要 AI 做什么"}`);
    if(kind === "browser_flow") parseBrowserFlowNode(text);
    const next = (Array.isArray(s.next) ? s.next : []).slice(0, 10).map((t) => ({ on: str(t?.on, 30), to: str(t?.to, 40) }));
    const seen = new Set<string>();
    for (const t of next) {
      if (!t.on) throw new Error(`「${stepName}」有一个分支没写结果名`);
      if (seen.has(t.on)) throw new Error(`「${stepName}」的结果「${t.on}」写了两次`);
      seen.add(t.on);
      if (kind !== "agent" && t.on !== AUTOMATION_OK && t.on !== AUTOMATION_FAIL) throw new Error(`「${stepName}」是命令步骤，只能按成功 / 失败分支`);
    }
    return { id, name: stepName, kind, text, next };
  });

  const ids = new Set(states.map((s) => s.id));
  if (ids.size !== states.length) throw new Error("有两个步骤的编号一样");
  for (const s of states) {
    const bad = s.next.find((t) => t.to !== AUTOMATION_END && !ids.has(t.to));
    if (bad) throw new Error(`「${s.name}」的结果「${bad.on}」指向了不存在的步骤`);
  }
  const start = ids.has(input.start) ? input.start : states[0].id;

  const schedule = cleanSchedule(input.schedule);
  const problem = scheduleProblem(schedule);
  if (problem) throw new Error(problem);
  const effort: Effort = input.effort === "medium" || input.effort === "high" ? input.effort : "low";
  return { name, enabled: input.enabled === true, schedule, start, states, effort };
}

function cleanSchedule(s: AutomationSchedule | undefined): AutomationSchedule {
  switch (s?.kind) {
    case "interval":
      return { kind: "interval", minutes: Math.round(Number(s.minutes)) };
    case "daily":
      return {
        kind: "daily",
        time: typeof s.time === "string" ? s.time.trim() : "",
        days: [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].sort(),
      };
    case "once":
      return { kind: "once", at: Number(s.at) };
    default:
      return { kind: "manual" };
  }
}
