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
