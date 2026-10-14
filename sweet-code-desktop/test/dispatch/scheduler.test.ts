// Run: node --test test/dispatch/
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, type Executor } from "../../src/main/dispatch/scheduler.ts";
import type { DispatchEvent, DispatchJob } from "../../src/shared/types.ts";

/** An executor driven by the test: it finishes a job when the test says so. */
class FakeExecutor implements Executor {
  readonly kind = "cli" as const;
  busy = false;
  gone = false;
  started: DispatchJob[] = [];
  private finishers: ((text: string | null) => void)[] = [];
  readonly ref: string;
  readonly name: string;
  constructor(ref: string) {
    this.ref = ref;
    this.name = ref;
  }
  ready() {
    return !this.busy;
  }
  alive() {
    return !this.gone;
  }
  run(job: DispatchJob, signal: AbortSignal) {
    this.started.push(job);
    return new Promise<{ text: string } | null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
      this.finishers.push((t) => resolve(t === null ? null : { text: t }));
    });
  }
  finish(text: string | null = "ok") {
    this.finishers.shift()!(text);
  }
}

function setup(opts: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) {
  const events: DispatchEvent[] = [];
  const d = new Dispatcher({ emit: (e) => events.push(e), ...opts });
  return { d, events };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Waits (a bounded number of turns) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  assert.ok(cond(), "condition never held");
}

function submit(d: Dispatcher, x: Executor, extra: Partial<Parameters<Dispatcher["submit"]>[0]> = {}) {
  const r = d.submit({ executor: x, input: "做点事", origin: "chat", from: "sikeoop", ...extra });
  if ("error" in r) throw new Error(r.error);
  return r;
}

test("a busy executor gets the job queued, not typed into", async () => {
  const { d } = setup();
  const x = new FakeExecutor("a");
  x.busy = true;
  const r = submit(d, x);
  await tick();
  assert.equal(x.started.length, 0);
  assert.equal(d.jobs()[0].status, "queued");
  x.busy = false;
  d.pump();
  await tick();
  assert.equal(x.started.length, 1);
  x.finish("完成");
  const job = await r.done;
  assert.equal(job.status, "done");
  assert.equal(job.result?.text, "完成");
  d.close();
});

test("one job at a time per executor", async () => {
  const { d } = setup();
  const x = new FakeExecutor("a");
  const first = submit(d, x);
  const second = submit(d, x);
  await tick();
  assert.equal(x.started.length, 1);
  x.finish();
  await first.done;
  await tick();
  assert.equal(x.started.length, 2);
  x.finish();
  assert.equal((await second.done).status, "done");
  d.close();
});

test("the global cap holds jobs back", async () => {
  const { d } = setup({ maxRunning: 2 });
  const xs = ["a", "b", "c"].map((n) => new FakeExecutor(n));
  for (const x of xs) submit(d, x);
  await tick();
  assert.deepEqual(xs.map((x) => x.started.length), [1, 1, 0]);
  xs[0].finish();
  await tick();
  await tick();
  assert.equal(xs[2].started.length, 1);
  d.close();
});

test("a job tree stops at its budget and says so", async () => {
  const { d, events } = setup({ budget: { agent: 3 } });
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  const root = submit(d, a, { origin: "agent", from: "Claude-1" });
  const child = submit(d, b, { origin: "agent", from: "Claude-2", parentId: root.job.id });
  submit(d, a, { origin: "agent", from: "Claude-1", parentId: child.job.id });
  const refused = d.submit({ executor: b, input: "再来", origin: "agent", from: "Claude-2", parentId: child.job.id });
  assert.ok("error" in refused);
  assert.ok(events.some((e) => e.type === "budget_exhausted" && e.rootId === root.job.id));
  // A separate tree has its own budget.
  assert.ok(!("error" in d.submit({ executor: b, input: "新的", origin: "agent", from: "Claude-3" })));
  d.close();
});

test("cancelling a job cancels what it started", async () => {
  const { d } = setup();
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  b.busy = true;
  const root = submit(d, a);
  await tick();
  const child = submit(d, b, { parentId: root.job.id });
  d.cancel(root.job.id);
  assert.equal((await root.done).status, "cancelled");
  assert.equal((await child.done).status, "cancelled");
  d.close();
});

test("timeouts and vanished executors end the job", async () => {
  const { d } = setup();
  const slow = new FakeExecutor("slow");
  const r = submit(d, slow, { timeoutMs: 20 });
  assert.equal((await r.done).status, "timeout");

  const gone = new FakeExecutor("gone");
  gone.busy = true;
  const q = submit(d, gone);
  gone.gone = true;
  d.pump();
  assert.equal((await q.done).status, "exited");
  d.close();
});

test("pending() follows the running job of an executor", async () => {
  const { d } = setup();
  const x = new FakeExecutor("a");
  submit(d, x);
  await tick();
  const p = d.pending("a");
  assert.ok(p);
  x.finish("结果");
  assert.equal((await p.done).result?.text, "结果");
  assert.equal(d.pending("a"), undefined);
  d.close();
});

test("a running job's children skip the cap, so a parent waiting on them can't deadlock", async () => {
  const { d } = setup({ maxRunning: 1 });
  const parent = new FakeExecutor("parent");
  const child = new FakeExecutor("child");
  const other = new FakeExecutor("other");
  const root = submit(d, parent);
  await tick();
  const outsider = submit(d, other);
  const kid = submit(d, child, { parentId: root.job.id });
  await tick();
  assert.equal(child.started.length, 1);
  assert.equal(other.started.length, 0);
  child.finish();
  await kid.done;
  parent.finish();
  await root.done;
  await tick();
  assert.equal(other.started.length, 1);
  other.finish();
  await outsider.done;
  d.close();
});

test("a failed preflight refuses the job; acceptance checks are attached after a run", async () => {
  const { d } = setup({
    preflight: async (job) => (job.input === "坏" ? { kind: "preflight", level: "fail", summary: "派活前检查没通过", details: ["没有网络"] } : null),
    verifier: {
      before: async () => "state",
      after: async (_job, state) => [{ kind: "files", level: "pass", summary: `看过了 ${state}` }],
    },
  });
  const x = new FakeExecutor("a");
  const bad = d.submit({ executor: x, input: "坏", origin: "chat", from: "sikeoop" });
  assert.ok(!("error" in bad));
  const refused = await bad.done;
  assert.equal(refused.status, "failed");
  assert.match(refused.error ?? "", /没有网络/);
  assert.equal(x.started.length, 0);

  const good = submit(d, x);
  await until(() => x.started.length === 1);
  x.finish("好了");
  const job = await good.done;
  assert.equal(job.status, "done");
  assert.equal(job.checks?.[0].summary, "看过了 state");
  d.close();
});

test("jobs in one lane run one at a time, in order; other lanes are not held back", async () => {
  const { d } = setup();
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  const c = new FakeExecutor("c");
  const first = submit(d, a, { lane: "s1" });
  const second = submit(d, b, { lane: "s1" });
  const elsewhere = submit(d, c, { lane: "s2" });
  await tick();
  assert.equal(a.started.length, 1);
  assert.equal(b.started.length, 0, "b is free, but its lane is taken");
  assert.equal(c.started.length, 1);
  assert.equal(d.view().queued, 1);
  a.finish();
  await first.done;
  await until(() => b.started.length === 1);
  b.finish();
  c.finish();
  await Promise.all([second.done, elsewhere.done]);
  d.close();
});

test("cancelling the job that holds a lane lets the next one in", async () => {
  const { d } = setup();
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  const first = submit(d, a, { lane: "s1" });
  const second = submit(d, b, { lane: "s1" });
  await tick();
  d.cancel(first.job.id);
  assert.equal((await first.done).status, "cancelled");
  await until(() => b.started.length === 1);
  b.finish();
  await second.done;
  d.close();
});

test("a job cancelled during the checks before it runs is never handed to its executor", async () => {
  let release!: () => void;
  const { d } = setup({ verifier: { before: () => new Promise<void>((r) => (release = r)), after: async () => [] } });
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await tick();
  d.cancel(r.job.id);
  release();
  assert.equal((await r.done).status, "cancelled");
  assert.equal(x.started.length, 0);
  d.close();
});

test("an executor taken during the checks before a run is waited for, not typed into", async () => {
  let release!: () => void;
  const { d } = setup({ verifier: { before: () => new Promise<void>((r) => (release = r)), after: async () => [] } });
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await tick();
  // The user typed their own prompt into the terminal while the baseline was being taken.
  x.busy = true;
  release();
  await tick();
  await tick();
  assert.equal(x.started.length, 0);
  assert.equal(d.current("a")?.id, r.job.id, "the job keeps its place on the executor");
  x.busy = false;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(x.started.length, 1);
  x.finish();
  assert.equal((await r.done).status, "done");
  d.close();
});

test("an executor that closes during the checks before a run ends the job as exited", async () => {
  let release!: () => void;
  const { d } = setup({ verifier: { before: () => new Promise<void>((r) => (release = r)), after: async () => [] } });
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await tick();
  x.gone = true;
  release();
  assert.equal((await r.done).status, "exited");
  assert.equal(x.started.length, 0);
  d.close();
});

test("cancelling reaches a job whose parent has already finished", async () => {
  const { d } = setup();
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  const c = new FakeExecutor("c");
  const root = submit(d, a);
  await tick();
  const middle = submit(d, b, { parentId: root.job.id });
  await tick();
  const leaf = submit(d, c, { parentId: middle.job.id });
  await tick();
  b.finish();
  await middle.done;
  d.cancel(root.job.id);
  assert.equal((await leaf.done).status, "cancelled");
  assert.equal((await root.done).status, "cancelled");
  d.close();
});

test("restoring history while a job is running doesn't list it a second time", async () => {
  const { d } = setup();
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await tick();
  // What the job log gives for a job that has only its "started" line.
  const old = { ...d.jobs()[0], id: "from-last-run", status: "done" as const };
  d.restore([{ ...d.jobs()[0], status: "exited", error: "应用关闭时它还没做完" }, old]);
  assert.deepEqual(d.jobs().map((j) => [j.id, j.status]), [[r.job.id, "running"], ["from-last-run", "done"]]);
  x.finish();
  await r.done;
  assert.deepEqual(d.jobs().map((j) => [j.id, j.status]), [[r.job.id, "done"], ["from-last-run", "done"]]);
  d.close();
});

test("last() is the job an executor finished most recently", async () => {
  const { d } = setup();
  const x = new FakeExecutor("a");
  assert.equal(d.last("a"), undefined);
  const first = submit(d, x);
  await tick();
  x.finish("第一次");
  await first.done;
  const second = submit(d, x);
  await tick();
  assert.equal(d.last("a")?.result?.text, "第一次", "the running one isn't finished yet");
  x.finish("第二次");
  await second.done;
  assert.equal(d.last("a")?.result?.text, "第二次");
  assert.equal(d.last("someone-else"), undefined);
  d.close();
});

test("a job cancelled while its preflight runs ends as cancelled, even if the preflight then refuses it", async () => {
  let release!: () => void;
  const { d } = setup({
    preflight: () => new Promise((r) => (release = () => r({ kind: "preflight", level: "fail", summary: "派活前检查没通过" }))),
  });
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await tick();
  d.cancel(r.job.id);
  release();
  const job = await r.done;
  assert.equal(job.status, "cancelled");
  assert.equal(job.error, undefined);
  assert.equal(x.started.length, 0);
  d.close();
});

test("a job that waits too long in the queue is given up as timed out", async () => {
  const { d } = setup({ queueTimeoutMs: 30 });
  const x = new FakeExecutor("a");
  x.busy = true; // stuck: waiting for the user, say
  const r = submit(d, x);
  const other = submit(d, new FakeExecutor("b"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  d.pump();
  const job = await r.done;
  assert.equal(job.status, "timeout");
  assert.match(job.error ?? "", /排了 .* 分钟的队/);
  assert.equal(x.started.length, 0);
  assert.equal(d.jobs().find((j) => j.id === other.job.id)?.status, "running", "a job that got its executor is not affected");
  d.close();
});

test("a cancel that arrives during acceptance doesn't undo finished work", async () => {
  let release!: () => void;
  const ended: string[] = [];
  const { d } = setup({
    verifier: {
      before: async () => null,
      after: () => new Promise((r) => (release = () => r([{ kind: "files", level: "pass", summary: "改了 1 个文件" }]))),
      end: (job) => void ended.push(`${job.id}:${job.status}`),
    },
  });
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await until(() => x.started.length === 1);
  x.finish("做完了");
  await tick();
  d.cancel(r.job.id);
  release();
  const job = await r.done;
  assert.equal(job.status, "done");
  assert.equal(job.result?.text, "做完了");
  assert.deepEqual(job.checks?.map((c) => c.level), ["pass", "warn"]);
  assert.match(job.checks?.at(-1)?.summary ?? "", /验收中途被取消/);
  assert.deepEqual(ended, [`${r.job.id}:done`], "the verifier is told the job is over");
  d.close();
});

test("the verifier is told about jobs that never reach acceptance too", async () => {
  const ended: string[] = [];
  const { d } = setup({ verifier: { before: async () => null, after: async () => [], end: (job) => void ended.push(job.status) } });
  const x = new FakeExecutor("a");
  const running = submit(d, x);
  const queued = submit(d, x);
  await until(() => x.started.length === 1);
  d.cancel(queued.job.id);
  d.cancel(running.job.id);
  await Promise.all([running.done, queued.done]);
  assert.deepEqual(ended, ["cancelled", "cancelled"]);
  d.close();
});

test("the abort signal says whether it was a cancel or a timeout", async () => {
  const reasons: unknown[] = [];
  class Watching extends FakeExecutor {
    run(job: DispatchJob, signal: AbortSignal) {
      signal.addEventListener("abort", () => reasons.push(signal.reason), { once: true });
      return super.run(job, signal);
    }
  }
  const { d } = setup();
  const a = new Watching("a");
  const b = new Watching("b");
  const cancelled = submit(d, a);
  const timedOut = submit(d, b, { timeoutMs: 20 });
  await until(() => a.started.length === 1 && b.started.length === 1);
  d.cancel(cancelled.job.id);
  await Promise.all([cancelled.done, timedOut.done]);
  assert.deepEqual(reasons, ["cancelled", "timeout"]);
  d.close();
});

test("automatic continuation exhaustion is marked visibly on active and historical console jobs", async () => {
  const { d, events } = setup();
  const x = new FakeExecutor("a");
  const job = submit(d, x);
  await until(() => x.started.length === 1);
  d.markNeedsReview("a", "同一任务已自动续跑 3 次，已停止，需人工查看", 3);
  x.finish("还有步骤没做完");
  const result = await job.done;
  assert.equal(result.status, "failed");
  assert.equal(result.needsReview, true);
  assert.equal(result.autoResumeCount, 3);
  assert.match(result.error!, /需人工查看/);
  assert.equal(result.checks?.at(-1)?.level, "fail");
  assert.ok(events.some(e => e.type === "job" && e.job.needsReview));
  d.markNeedsReview("a", "同一任务已自动续跑 3 次，已停止，需人工查看", 3);
  assert.equal(d.jobs().length, 1);
  assert.equal(d.jobs()[0].checks?.length, 1);
  d.close();
});

test("main chat without a previous dispatch gets a persisted failed review job", async () => {
  const { d } = setup();
  const marked = d.markNeedsReview("main-chat", "已停止，需人工查看", 3);
  assert.equal(marked.status, "failed");
  assert.equal(marked.needsReview, true);
  assert.equal(d.view().running, 0);
  const history = d.jobs();
  d.close();
  const restored = setup().d;
  restored.restore(history);
  assert.equal(restored.jobs()[0].needsReview, true);
  assert.match(restored.jobs()[0].error!, /需人工查看/);
  restored.close();
});

test("a reply costs no budget and gets through when the tree's is spent", async () => {
  const { d, events } = setup({ budget: { agent: 1 } });
  const a = new FakeExecutor("a");
  const b = new FakeExecutor("b");
  const ask = submit(d, b, { origin: "agent", from: "a" });
  await tick();
  b.finish("答案");
  const asked = await ask.done;
  assert.equal(d.budget(asked.rootId)?.left, 0);
  assert.ok("error" in d.submit({ executor: b, input: "再问", origin: "agent", from: "a", parentId: asked.id }), "the tree is spent");
  const back = submit(d, a, { origin: "agent", from: "b", parentId: asked.id, reply: true, input: "答案" });
  assert.equal(back.job.reply, true);
  assert.equal(back.job.rootId, asked.rootId);
  assert.equal(d.budget(asked.rootId)?.left, 0, "nothing was spent on it");
  assert.equal(events.filter((e) => e.type === "budget_exhausted").length, 1);
  await tick();
  assert.equal(a.started[0].reply, true);
  a.finish();
  assert.equal((await back.done).status, "done");
  d.close();
});

/** An executor that can be sent back to fix what the acceptance found. */
class ReworkExecutor extends FakeExecutor {
  problems: string[] = [];
  private fixers: ((text: string | null | Error) => void)[] = [];
  rework(_job: DispatchJob, problems: string, signal: AbortSignal) {
    this.problems.push(problems);
    return new Promise<{ text: string } | null>((resolve, reject) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
      this.fixers.push((t) => (t instanceof Error ? reject(t) : resolve(t === null ? null : { text: t })));
    });
  }
  fix(text: string | null | Error = "改好了") {
    this.fixers.shift()!(text);
  }
}

/** A verifier whose n-th acceptance returns the n-th list of checks. */
function acceptance(rounds: DispatchJob["checks"][]) {
  const states: unknown[] = [];
  return {
    states,
    verifier: {
      before: async () => "baseline",
      after: async (_job: DispatchJob, state: unknown) => {
        states.push(state);
        return [...(rounds[states.length - 1] ?? [])];
      },
    },
  };
}
const TYPE_FAIL = { kind: "typecheck" as const, level: "fail" as const, summary: "类型检查新增 1 个错误", details: ["src/a.ts TS2322: Bad."] };
const TYPE_PASS = { kind: "typecheck" as const, level: "pass" as const, summary: "类型检查没有新增错误" };

test("new type errors go back to the executor once, and the second acceptance replaces the first", async () => {
  const v = acceptance([[{ kind: "files", level: "pass", summary: "改了 1 个文件" }, TYPE_FAIL], [TYPE_FAIL], [TYPE_PASS]]);
  const { d } = setup({ verifier: v.verifier, preflight: async () => ({ kind: "preflight", level: "pass", summary: "可以开工" }) });
  const x = new ReworkExecutor("a");
  const r = submit(d, x);
  await until(() => x.started.length === 1);
  x.finish("第一轮");
  await until(() => x.problems.length === 1);
  assert.deepEqual(x.problems, ["类型检查新增 1 个错误\nsrc/a.ts TS2322: Bad."]);
  const during = d.jobs()[0];
  assert.equal(during.status, "running");
  assert.equal(during.reworks, 1);
  x.fix("第二轮");
  const job = await r.done;
  assert.equal(job.status, "done");
  assert.equal(job.result?.text, "第二轮");
  assert.equal(job.reworks, 1);
  // Still failing after the rework: it is not sent back a second time.
  assert.deepEqual(job.checks, [{ kind: "preflight", level: "pass", summary: "可以开工" }, TYPE_FAIL]);
  assert.deepEqual(v.states, ["baseline", "baseline"], "both rounds are compared with the same baseline");
  assert.equal(x.problems.length, 1);
  d.close();
});

test("no rework for files outside owns, or for an executor that cannot do one", async () => {
  const owns = acceptance([[{ kind: "owns", level: "fail", summary: "改了不归它的文件" }]]);
  const one = setup({ verifier: owns.verifier });
  const x = new ReworkExecutor("a");
  const r = submit(one.d, x);
  await until(() => x.started.length === 1);
  x.finish();
  const job = await r.done;
  assert.equal(job.status, "done");
  assert.equal(job.reworks, undefined);
  assert.equal(x.problems.length, 0);
  one.d.close();

  const types = acceptance([[TYPE_FAIL]]);
  const two = setup({ verifier: types.verifier });
  const plain = new FakeExecutor("b");
  const p = submit(two.d, plain);
  await until(() => plain.started.length === 1);
  plain.finish("只有一轮");
  const kept = await p.done;
  assert.equal(kept.reworks, undefined);
  assert.equal(kept.result?.text, "只有一轮");
  assert.deepEqual(kept.checks, [TYPE_FAIL]);
  assert.equal(types.states.length, 1);
  two.d.close();
});

test("cancelled during the rework, the job ends cancelled", async () => {
  const v = acceptance([[TYPE_FAIL]]);
  const { d } = setup({ verifier: v.verifier });
  const x = new ReworkExecutor("a");
  const r = submit(d, x);
  await until(() => x.started.length === 1);
  x.finish("第一轮");
  await until(() => x.problems.length === 1);
  d.cancel(r.job.id);
  const job = await r.done;
  assert.equal(job.status, "cancelled");
  assert.equal(v.states.length, 1, "no second acceptance");
  d.close();
});

test("a rework that fails keeps the first round and says so", async () => {
  for (const outcome of [null, new Error("终端写不进去")]) {
    const v = acceptance([[TYPE_FAIL]]);
    const { d } = setup({ verifier: v.verifier });
    const x = new ReworkExecutor("a");
    const r = submit(d, x);
    await until(() => x.started.length === 1);
    x.finish("第一轮");
    await until(() => x.problems.length === 1);
    x.fix(outcome);
    const job = await r.done;
    assert.equal(job.status, "done");
    assert.equal(job.result?.text, "第一轮");
    assert.equal(job.checks?.length, 2);
    assert.deepEqual(job.checks?.[0], TYPE_FAIL);
    assert.equal(job.checks?.[1].level, "warn");
    assert.match(job.checks![1].summary, outcome ? /终端写不进去/ : /没有拿到结果/);
    assert.equal(v.states.length, 1);
    d.close();
  }
});

test("the rework runs on what is left of the job's time", async () => {
  const v = acceptance([[TYPE_FAIL]]);
  const { d } = setup({ verifier: v.verifier });
  const x = new ReworkExecutor("a");
  const r = submit(d, x, { timeoutMs: 60 });
  await until(() => x.started.length === 1);
  x.finish("第一轮");
  await until(() => x.problems.length === 1);
  const job = await r.done;
  assert.equal(job.status, "timeout");
  assert.equal(job.result?.text, "第一轮", "the first round's reply is kept");
  d.close();
});

// ---- 调度核心第一批（docs/调度核心-修改指导.md 第 3 节）----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An executor that finishes each job by itself after `ms`. */
class TimedExecutor implements Executor {
  readonly kind = "cli" as const;
  busy = false;
  started = 0;
  readonly ref: string;
  readonly name: string;
  private readonly ms: number;
  constructor(ref: string, ms: number) {
    this.ref = ref;
    this.ms = ms;
    this.name = ref;
  }
  ready() {
    return !this.busy;
  }
  alive() {
    return true;
  }
  async run() {
    this.started++;
    await sleep(this.ms);
    return { text: "ok" };
  }
}

/** Pumps every few ms, so a queue timeout would show up long before the 2 s interval. */
function pumping(d: Dispatcher) {
  const t = setInterval(() => d.pump(), 5);
  return () => clearInterval(t);
}

test("T1-1: five jobs on one executor all finish, however long they queue in total", async () => {
  const { d } = setup({ queueTimeoutMs: 100 });
  const stop = pumping(d);
  const x = new TimedExecutor("a", 40);
  const jobs = Array.from({ length: 5 }, () => submit(d, x));
  const ended = await Promise.all(jobs.map((j) => j.done));
  stop();
  assert.deepEqual(ended.map((j) => j.status), ["done", "done", "done", "done", "done"]);
  d.close();
});

test("T1-2: five jobs in one lane on different executors all finish", async () => {
  const { d } = setup({ queueTimeoutMs: 100 });
  const stop = pumping(d);
  const jobs = Array.from({ length: 5 }, (_, i) => submit(d, new TimedExecutor(`x${i}`, 40), { lane: "L" }));
  const ended = await Promise.all(jobs.map((j) => j.done));
  stop();
  assert.deepEqual(ended.map((j) => j.status), ["done", "done", "done", "done", "done"]);
  d.close();
});

test("T1-4: the unavailable-executor clock restarts once the wait is the dispatcher's own", async () => {
  const { d } = setup({ queueTimeoutMs: 80 });
  const stop = pumping(d);
  const x = new TimedExecutor("a", 100);
  x.busy = true;
  const first = submit(d, x);
  const second = submit(d, x);
  await sleep(50);
  x.busy = false; // free now, but the dispatcher's own first job takes it for 100 ms
  const ended = await Promise.all([first.done, second.done]);
  stop();
  assert.deepEqual(ended.map((j) => j.status), ["done", "done"]);
  d.close();
});

test("T2-1: with a cap of 4, a running parent's 12 children add only one overflow", async () => {
  const { d } = setup({ maxRunning: 4 });
  const parent = new FakeExecutor("parent");
  const root = submit(d, parent);
  await tick();
  const kids = Array.from({ length: 12 }, (_, i) => new FakeExecutor(`k${i}`));
  for (const k of kids) submit(d, k, { parentId: root.job.id });
  await tick();
  assert.equal(d.view().running, 5);
  assert.equal(kids.filter((k) => k.started.length).length, 4);
  assert.equal(d.jobs().filter((j) => j.overCap && j.status === "running").length, 1);
  d.close();
});

test("T2-3: cap 1, root -> child -> grandchild, each waiting on the next, all start and finish", async () => {
  const { d } = setup({ maxRunning: 1 });
  const [a, b, c] = ["root", "child", "grand"].map((n) => new FakeExecutor(n));
  const root = submit(d, a);
  await tick();
  const child = submit(d, b, { parentId: root.job.id });
  await tick();
  assert.equal(b.started.length, 1);
  const grand = submit(d, c, { parentId: child.job.id });
  await tick();
  assert.equal(c.started.length, 1);
  c.finish();
  assert.equal((await grand.done).status, "done");
  b.finish();
  assert.equal((await child.done).status, "done");
  a.finish();
  assert.equal((await root.done).status, "done");
  d.close();
});

test("T2-4: cap 1, a parent waiting for approval still lets its child start", async () => {
  const { d } = setup({ maxRunning: 1 });
  const p = new FakeExecutor("p");
  const k = new FakeExecutor("k");
  const root = submit(d, p);
  await until(() => p.started.length === 1);
  d.progress(root.job.id, { type: "permission", at: Date.now() });
  assert.equal(d.jobs().find((j) => j.id === root.job.id)?.status, "waiting_approval");
  submit(d, k, { parentId: root.job.id });
  await tick();
  assert.equal(k.started.length, 1);
  d.close();
});

test("T2-5: two children of one parent at the cap: one overflows, the other waits for it", async () => {
  const { d } = setup({ maxRunning: 1 });
  const p = new FakeExecutor("p");
  const k1 = new FakeExecutor("k1");
  const k2 = new FakeExecutor("k2");
  const root = submit(d, p);
  await tick();
  const first = submit(d, k1, { parentId: root.job.id });
  submit(d, k2, { parentId: root.job.id });
  await tick();
  assert.equal(k1.started.length, 1);
  assert.equal(k2.started.length, 0);
  k1.finish();
  await first.done;
  await until(() => k2.started.length === 1);
  d.close();
});

test("T3-1: tool progress emits progress events but no job events", async () => {
  const { d, events } = setup();
  const x = new FakeExecutor("a");
  const r = submit(d, x);
  await until(() => x.started.length === 1);
  const jobsBefore = events.filter((e) => e.type === "job").length;
  for (let i = 0; i < 300; i++) d.progress(r.job.id, { type: "tool", at: Date.now(), title: `t${i}` });
  assert.equal(events.filter((e) => e.type === "job").length, jobsBefore);
  assert.equal(events.filter((e) => e.type === "progress").length, 300);
  d.close();
});

test("T5-2: overlapping owners queue, disjoint and read-only jobs run in parallel", async (t) => {
  const { d, events } = setup();
  t.after(() => d.close());
  const xs = ["owner", "overlap", "disjoint", "reader"].map(n => new FakeExecutor(n));
  const first = submit(d, xs[0], { scope: { roots: ["/p"], owns: ["src/a/"] } });
  const second = submit(d, xs[1], { scope: { roots: ["/p"], owns: ["src/a/x.ts"] } });
  const third = submit(d, xs[2], { scope: { roots: ["/p"], owns: ["src/b/"] } });
  const reader = submit(d, xs[3], { scope: { roots: ["/p"], readOnly: true } });
  await tick();
  assert.deepEqual(xs.map(x => x.started.length), [1, 0, 1, 1]);
  assert.deepEqual(d.jobs().find(j => j.id === second.job.id)?.waiting, { reason: "conflict", detail: "owner" });
  const before = events.length;
  d.pump();
  assert.equal(events.length, before);
  xs[0].finish();
  await first.done;
  await until(() => xs[1].started.length === 1);
  xs[1].finish("完成");
  const result = await second.done;
  assert.match(result.result?.text ?? "", /完成\n说明：因文件归属冲突.*owner/);
  assert.equal(result.waiting, undefined);
  xs[2].finish();
  xs[3].finish();
  assert.equal((await third.done).result?.text, "ok");
  await reader.done;
});

test("T5-3: ancestors and descendants are exempt, siblings are not", async (t) => {
  const { d } = setup({ maxRunning: 5 });
  t.after(() => d.close());
  const parent = new FakeExecutor("parent");
  const child = new FakeExecutor("child");
  const sibling = new FakeExecutor("sibling");
  const scope = { roots: ["/p"] };
  const root = submit(d, parent, { scope });
  const c = submit(d, child, { scope, parentId: root.job.id });
  const s = submit(d, sibling, { scope, parentId: root.job.id });
  await tick();
  assert.equal(child.started.length, 1);
  assert.equal(sibling.started.length, 0);
  child.finish();
  await c.done;
  await until(() => sibling.started.length === 1);
  sibling.finish();
  await s.done;
  parent.finish();
  await root.done;

  // A descendant can already be running when its queued ancestor becomes ready.
  const ancestor = new FakeExecutor("ancestor");
  ancestor.busy = true;
  const descendant = new FakeExecutor("descendant");
  const a = submit(d, ancestor, { scope });
  const b = submit(d, descendant, { scope, parentId: a.job.id });
  await tick();
  ancestor.busy = false;
  d.pump();
  await tick();
  assert.equal(ancestor.started.length, 1);
  descendant.finish();
  ancestor.finish();
  await Promise.all([a.done, b.done]);
});

test("T5-4: strict is default; declared and off allow undeclared writes", async (t) => {
  for (const conflict of [undefined, "strict", "declared", "off"] as const) {
    const { d } = setup({ conflict });
    t.after(() => d.close());
    const x = new FakeExecutor("x"), y = new FakeExecutor("y");
    const scope = { roots: ["/p"] };
    const a = submit(d, x, { scope });
    const b = submit(d, y, { scope });
    await tick();
    assert.equal(y.started.length, conflict === "declared" || conflict === "off" ? 1 : 0);
    x.finish();
    await a.done;
    await until(() => y.started.length === 1);
    y.finish();
    await b.done;
  }
});

test("T5-5: conflict backlog clears executor timeout accounting", async (t) => {
  const { d } = setup({ queueTimeoutMs: 30 });
  t.after(() => d.close());
  const x = new FakeExecutor("x"), y = new FakeExecutor("y");
  y.busy = true;
  const scope = { roots: ["/p"] };
  const b = submit(d, y, { scope });
  await new Promise(r => setTimeout(r, 10));
  const a = submit(d, x, { scope });
  d.pump();
  assert.equal(d.jobs().find(j => j.id === b.job.id)?.waiting?.reason, "conflict");
  await new Promise(r => setTimeout(r, 50));
  d.pump();
  assert.equal(d.jobs().find(j => j.id === b.job.id)?.status, "queued");
  y.busy = false;
  x.finish();
  await a.done;
  await until(() => y.started.length === 1);
  y.finish();
  assert.equal((await b.done).status, "done");
});
