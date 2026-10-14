// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliExecutor, type CliBus } from "../../src/main/dispatch/cli.ts";
import type { AgentSessionView, DispatchJob } from "../../src/shared/types.ts";

function setup() {
  const typed: string[] = [];
  const view: AgentSessionView = { id: "p1", name: "Claude-1", cli: "claude", status: "idle", detail: "", since: 0 };
  let endTurn: (text: string | null) => void = () => {};
  const interrupted: string[] = [];
  const bus: CliBus = {
    interrupt: (id) => void interrupted.push(id),
    viewOf: () => view,
    deliver: (_id, text) => {
      typed.push(text);
      return true;
    },
    waitTurn: (_id, _ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(null);
        endTurn = resolve;
        signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
  };
  const x = new CliExecutor(bus, "p1", "Claude-1", (job) => ({ text: `[sikeoop → 你] ${job.input}`, detail: "收到任务" }), { cli: "claude", root: "/p" });
  const job = { input: "修一下登录", limits: { timeoutMs: 1000 } } as DispatchJob;
  return { x, typed, view, job, interrupted, endTurn: (t: string | null) => endTurn(t) };
}

test("a job is typed in and its result is the turn's last reply", async () => {
  const t = setup();
  const run = t.x.run(t.job, new AbortController().signal);
  assert.deepEqual(t.typed, ["[sikeoop → 你] 修一下登录"]);
  t.endTurn("修好了");
  assert.deepEqual(await run, { text: "修好了" });
});

test("nothing is typed for a job that was cancelled before it began", async () => {
  const t = setup();
  const c = new AbortController();
  c.abort();
  assert.equal(await t.x.run(t.job, c.signal), null);
  assert.deepEqual(t.typed, []);
});

test("ready only when idle; alive while the session exists", () => {
  const t = setup();
  assert.ok(t.x.ready());
  for (const status of ["starting", "working", "waiting"] as const) {
    t.view.status = status;
    assert.ok(!t.x.ready(), status);
  }
  assert.ok(t.x.alive());
});

test("T9-1: a session that has only just gone idle isn't ready until it settles", () => {
  const t = setup();
  const now = 100_000;
  t.view.since = now - 1000;
  assert.ok(!t.x.ready(now));
  t.view.since = now - 2000;
  assert.ok(t.x.ready(now));
});

test("a cancel stops the session too; a timeout only stops waiting for it", async () => {
  const cancelled = setup();
  const c = new AbortController();
  const run = cancelled.x.run(cancelled.job, c.signal);
  c.abort("cancelled");
  assert.equal(await run, null);
  assert.deepEqual(cancelled.interrupted, ["p1"]);

  const late = setup();
  const t = new AbortController();
  const waiting = late.x.run(late.job, t.signal);
  t.abort("timeout");
  assert.equal(await waiting, null);
  assert.deepEqual(late.interrupted, [], "it may be nearly done: left to finish");

  // Once the turn is over there is nothing left to stop.
  const over = setup();
  const o = new AbortController();
  const finished = over.x.run(over.job, o.signal);
  over.endTurn("好了");
  await finished;
  o.abort("cancelled");
  assert.deepEqual(over.interrupted, []);
});

test("a rework is one more prompt in the same session, with only the problems", async () => {
  const t = setup();
  const run = t.x.rework(t.job, "类型检查新增 1 个错误\nsrc/a.ts TS2322: Bad.", new AbortController().signal);
  assert.equal(t.typed.length, 1);
  assert.match(t.typed[0], /^\[sikeoop → 你\] 刚才的任务自动验收没过/);
  assert.match(t.typed[0], /src\/a\.ts TS2322: Bad\./);
  assert.ok(!t.typed[0].includes("修一下登录"), "the task is not repeated");
  t.endTurn("改好了");
  assert.deepEqual(await run, { text: "改好了" });
});
