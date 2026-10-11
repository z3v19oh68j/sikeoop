import { randomUUID } from "node:crypto";
import type {
  AgentSessionView, DispatchJob, RegressBaseline, RegressCandidate, RegressDiffRow, RegressItem, RegressRun, RegressSettings, RegressVerdict, RegressView,
} from "@shared/types";
import type { Dispatcher, Executor } from "../dispatch/scheduler.ts";
import { cleanCandidate, excerptOf, generatePrompt, LIMITS, parseCandidates, parseVerdict, runPrompt, stripAnsi } from "./parse.ts";
import { validId } from "./store.ts";
import type { RegressStore } from "./store.ts";
import { clampSettings, conflictsOf, DEFAULT_SETTINGS, diffRows, latestRuns, runStatus, snapshotResults } from "./view.ts";

// The regression panel (.claude/regress-plan.md): a terminal session proposes checks, the user
// keeps the good ones, and any Claude Code / Codex session runs them and answers PASS or FAIL.
//
// Every check handed to a session is a job on the dispatch core. The dispatcher owns the waiting:
// a session takes one job at a time, a busy one gets its jobs queued, and a run's status is its
// job's status. Nothing here keeps a lock of its own.
// No Electron: the project root, the sessions and the window are handed in.

export interface RegressDeps {
  /** The open project, or null. The only place a path comes from. */
  root(): string | null;
  store: RegressStore;
  dispatcher: Pick<Dispatcher, "submit" | "cancel">;
  /** The terminal session the panel calls by this name. */
  findSession(name: string): AgentSessionView | null;
  /** What types a job into that session and waits for its reply. */
  executorFor(session: AgentSessionView): Executor;
  /** Something the panel shows changed. */
  changed(view: RegressView): void;
}

type Failed = { error: string };
const fail = (error: string): Failed => ({ error });
const NO_PROJECT = "未打开项目";
const FROM = "回归面板";
const MAX_ADD = 200;

export class RegressService {
  private readonly deps: RegressDeps;
  /** Runs whose job is queued or running, by job id. */
  private readonly live = new Map<string, { run: RegressRun; root: string }>();
  /** The one generate a project may have going. */
  private readonly generating = new Map<string, { session: string; startedAt: number; jobId: string }>();

  constructor(deps: RegressDeps) {
    this.deps = deps;
  }

  // ---- what the window calls (arguments arrive unchecked; nothing here throws) ----

  async view(): Promise<RegressView> {
    const root = this.deps.root();
    if (!root) return { root: null, items: [], latest: {}, conflicts: [], baselines: [], busy: { sessions: [], runs: [] }, settings: { ...DEFAULT_SETTINGS } };
    try {
      return await this.viewOf(root);
    } catch {
      // The folder can't be read safely (a symlink in the way): shown as empty rather than failing the panel.
      return { root, items: [], latest: {}, conflicts: [], baselines: [], busy: this.busy(root), settings: { ...DEFAULT_SETTINGS } };
    }
  }

  generate(session: unknown, focus?: unknown): Promise<{ candidates: RegressCandidate[]; rawExcerpt: string } | { error: string; rawExcerpt?: string }> {
    return this.safely(async (root) => {
      if (focus !== undefined && typeof focus !== "string") return fail("重点范围必须是文字");
      const target = this.session(session);
      if ("error" in target) return target;
      if (this.generating.has(root)) return fail("已经有一个生成任务在跑");
      const settings = await this.deps.store.settings(root);
      const items = await this.deps.store.items(root);
      const sub = this.deps.dispatcher.submit({
        executor: this.deps.executorFor(target),
        input: generatePrompt(typeof focus === "string" ? focus.slice(0, LIMITS.focus) : undefined, settings.maxCandidates),
        origin: "user",
        from: FROM,
        timeoutMs: settings.generateTimeoutSec * 1000,
      });
      if ("error" in sub) return sub;
      this.generating.set(root, { session: target.name, startedAt: Date.now(), jobId: sub.job.id });
      await this.push(root);
      let job: DispatchJob;
      try {
        job = await sub.done;
      } finally {
        this.generating.delete(root);
        await this.push(root);
      }
      if (job.status !== "done") return fail(ENDED[runStatus(job.status)] ?? job.error ?? "没有拿到回复");
      // Titles may have been added while it was thinking.
      const now = await this.deps.store.items(root).catch(() => items);
      return parseCandidates(job.result?.text ?? "", now.map((i) => i.title), settings.maxCandidates);
    });
  }

  addItems(candidates: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      if (!Array.isArray(candidates) || candidates.length > MAX_ADD) return fail(`一次最多加入 ${MAX_ADD} 条`);
      const items = await this.deps.store.items(root);
      const titles = new Set(items.map((i) => i.title));
      const now = Date.now();
      for (const raw of candidates) {
        const c = cleanCandidate(raw);
        if (!c || titles.has(c.title)) continue;
        titles.add(c.title);
        items.push({ id: randomUUID(), ...c, createdAt: now, updatedAt: now });
      }
      await this.deps.store.saveItems(root, items);
      return this.push(root);
    });
  }

  updateItem(id: unknown, patch: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      const items = await this.deps.store.items(root);
      const item = validId(id) ? items.find((i) => i.id === id) : undefined;
      if (!item) return fail("找不到这个条目");
      if (typeof patch !== "object" || patch === null) return fail("没有要改的内容");
      // The fields left out keep their value; the ones given are checked like a new item's.
      const next = cleanCandidate({ title: item.title, detail: item.detail, owner: item.owner, criteria: item.criteria, ...(patch as object) });
      if (!next) return fail("标题不能为空，各项都必须是文字");
      if (items.some((i) => i !== item && i.title === next.title)) return fail("已经有一条同名的了");
      Object.assign(item, next, { updatedAt: Date.now() });
      await this.deps.store.saveItems(root, items);
      return this.push(root);
    });
  }

  /** The item goes; the runs it had stay in the log. */
  deleteItem(id: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      const items = await this.deps.store.items(root);
      if (validId(id) && items.some((i) => i.id === id)) await this.deps.store.saveItems(root, items.filter((i) => i.id !== id));
      return this.push(root);
    });
  }

  /** Hands the items to a session, one job each; returns at once. A busy session gets them queued. */
  run(itemIds: unknown, session: unknown): Promise<{ runIds: string[] } | Failed> {
    return this.safely(async (root) => {
      if (!Array.isArray(itemIds) || !itemIds.every(validId)) return fail("条目无效");
      const settings = await this.deps.store.settings(root);
      if (itemIds.length > settings.maxPerBatch) return fail(`一次最多执行 ${settings.maxPerBatch} 条`);
      const target = this.session(session);
      if ("error" in target) return target;
      const items = await this.deps.store.items(root);
      const mine = [...new Set(itemIds)].map((id) => items.find((i) => i.id === id)).filter((i): i is RegressItem => !!i);
      if (!mine.length) return fail("找不到要运行的条目");
      const executor = this.deps.executorFor(target);
      const runIds: string[] = [];
      for (const item of mine) {
        const run: RegressRun = {
          id: randomUUID(), itemId: item.id, session: target.name, cli: target.cli as RegressRun["cli"],
          startedAt: Date.now(), endedAt: null, status: "queued", auto: "pending", verdict: "pending", overridden: false, reason: "", excerpt: "",
        };
        const sub = this.deps.dispatcher.submit({ executor, input: runPrompt(item), origin: "user", from: FROM, timeoutMs: settings.runTimeoutSec * 1000 });
        if ("error" in sub) {
          await this.deps.store.appendRun(root, { ...run, status: "error", endedAt: Date.now(), error: sub.error });
        } else {
          // A free session takes it at once: by the time submit returns it is already running.
          if (runStatus(sub.job.status) === "running") Object.assign(run, { status: "running", startedAt: sub.job.startedAt ?? run.startedAt });
          this.live.set(sub.job.id, { run, root });
          await this.deps.store.appendRun(root, run);
          void sub.done.then((job) => this.finished(job));
        }
        runIds.push(run.id);
      }
      await this.push(root);
      return { runIds };
    });
  }

  /** Stops waiting for one run, or for every queued and running one of this project. */
  async cancel(runId?: unknown): Promise<void> {
    const root = this.deps.root();
    for (const [jobId, entry] of [...this.live]) {
      if (runId !== undefined ? entry.run.id !== runId : entry.root !== root) continue;
      this.deps.dispatcher.cancel(jobId);
    }
  }

  override(runId: unknown, verdict: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      if (verdict !== "pass" && verdict !== "fail" && verdict !== "pending") return fail("结论只能是通过、不通过或待定");
      const run = validId(runId) ? (await this.runs(root)).find((r) => r.id === runId) : undefined;
      if (!run) return fail("找不到这条运行记录");
      if (run.status === "queued" || run.status === "running") return fail("它还没跑完");
      await this.deps.store.appendRun(root, { ...run, verdict: verdict as RegressVerdict, overridden: true });
      return this.push(root);
    });
  }

  snapshot(name: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      if (typeof name !== "string") return fail("基线名字必须是文字");
      const view = await this.viewOf(root);
      const baseline: RegressBaseline = { id: randomUUID(), name: name.trim().slice(0, LIMITS.name) || "基线", createdAt: Date.now(), results: snapshotResults(view.latest) };
      await this.deps.store.saveBaseline(root, baseline);
      return this.push(root);
    });
  }

  diff(baselineId: unknown): Promise<RegressDiffRow[] | Failed> {
    return this.safely(async (root) => {
      const baseline = validId(baselineId) ? (await this.deps.store.baselines(root)).find((b) => b.id === baselineId) : undefined;
      if (!baseline) return fail("找不到这个基线");
      return diffRows(baseline, (await this.viewOf(root)).latest);
    });
  }

  deleteBaseline(id: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      if (!validId(id)) return fail("找不到这个基线");
      await this.deps.store.deleteBaseline(root, id);
      return this.push(root);
    });
  }

  reply(runId: unknown): Promise<string | Failed> {
    return this.safely(async (root) => {
      const text = validId(runId) ? await this.deps.store.reply(root, runId) : null;
      return text ?? fail("没有找到这次运行的原文");
    });
  }

  setSettings(patch: unknown): Promise<RegressView | Failed> {
    return this.safely(async (root) => {
      await this.deps.store.saveSettings(root, clampSettings(patch, await this.deps.store.settings(root)));
      return this.push(root);
    });
  }

  // ---- from the dispatcher ----

  /** A job changed (the dispatcher's event): a queued run that got its session is now running. */
  jobChanged(job: DispatchJob): void {
    const entry = this.live.get(job.id);
    if (!entry || entry.run.status !== "queued" || runStatus(job.status) !== "running") return;
    entry.run = { ...entry.run, status: "running", startedAt: job.startedAt ?? Date.now() };
    void this.deps.store.appendRun(entry.root, entry.run).then(() => this.push(entry.root)).catch(() => {});
  }

  /** A run's job is over: its status is the job's, and a finished one is read for its verdict. */
  private async finished(job: DispatchJob): Promise<void> {
    const entry = this.live.get(job.id);
    if (!entry) return;
    const { root } = entry;
    let run: RegressRun = { ...entry.run, status: runStatus(job.status), endedAt: job.endedAt ?? Date.now() };
    try {
      if (job.status === "done") {
        const reply = job.result?.text ?? "";
        const { auto, reason, excerpt } = parseVerdict(reply);
        run = { ...run, auto, verdict: auto, reason, excerpt };
        await this.deps.store.saveReply(root, run.id, stripAnsi(reply));
      } else if (job.status === "failed") {
        run = { ...run, error: (job.error ?? "没有拿到回复").slice(0, 300), excerpt: excerptOf(job.result?.text ?? "") };
      }
      await this.deps.store.appendRun(root, run);
    } catch {
      // The project folder went away meanwhile: the run is still shown as over.
    } finally {
      this.live.delete(job.id);
      await this.push(root).catch(() => {});
    }
  }

  // ---- internals ----

  /** A session the panel may use: there, started, and one of the two CLIs a run records. */
  private session(name: unknown): AgentSessionView | Failed {
    const s = typeof name === "string" ? this.deps.findSession(name) : null;
    if (!s) return fail("找不到这个会话");
    if (s.cli !== "claude" && s.cli !== "codex") return fail("回归面板只能用 Claude Code 或 Codex 会话");
    if (s.status === "starting") return fail("这个会话还在启动");
    return s;
  }

  /** The stored runs, with the ones still going as they are now. */
  private async runs(root: string): Promise<RegressRun[]> {
    const going = new Map([...this.live.values()].filter((e) => e.root === root).map((e) => [e.run.id, e.run]));
    return (await this.deps.store.runs(root)).map((r) => {
      const now = going.get(r.id);
      if (now) return now;
      // Logged as going but nothing is running it: sikeoop closed meanwhile, and its session with it.
      return r.status === "queued" || r.status === "running" ? { ...r, status: "gone" as const, endedAt: r.endedAt ?? r.startedAt } : r;
    });
  }

  private busy(root: string): RegressView["busy"] {
    const going = [...this.live.values()].filter((e) => e.root === root);
    const generate = this.generating.get(root);
    return {
      ...(generate ? { generate: { session: generate.session, startedAt: generate.startedAt } } : {}),
      sessions: [...new Set([...going.map((e) => e.run.session), ...(generate ? [generate.session] : [])])],
      runs: going.map((e) => e.run.id),
    };
  }

  private async viewOf(root: string): Promise<RegressView> {
    const { store } = this.deps;
    const [items, runs, baselines, settings] = await Promise.all([store.items(root), this.runs(root), store.baselines(root), store.settings(root)]);
    const latest = latestRuns(items, runs);
    return {
      root,
      items,
      latest,
      conflicts: conflictsOf(items, latest),
      baselines: baselines.map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt })),
      busy: this.busy(root),
      settings,
    };
  }

  /** The view after a change, sent to the window when that project is still the open one. */
  private async push(root: string): Promise<RegressView> {
    const view = await this.viewOf(root);
    if (this.deps.root() === root) this.deps.changed(view);
    return view;
  }

  /** Runs an action on the open project; a missing project or any failure becomes { error }. */
  private async safely<T>(action: (root: string) => Promise<T | Failed>): Promise<T | Failed> {
    const root = this.deps.root();
    if (!root) return fail(NO_PROJECT);
    try {
      return await action(root);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Why a generate that didn't finish has no candidates. */
const ENDED: Partial<Record<RegressRun["status"], string>> = {
  timeout: "会话没有在限定时间内回复",
  gone: "会话已关闭",
  cancelled: "已取消",
};
