// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelExecutor, type ModelOutcome } from "../../src/main/dispatch/model.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import type { DispatchJob } from "../../src/shared/types.ts";

const job = { id: "j", input: "问题" } as DispatchJob;

test("a streamed call: text arrives in pieces, the whole reply is the result, and it is settled once", async () => {
  const log: string[] = [];
  const x = new ModelExecutor("m1", "米朵", {
    begin: () => log.push("begin"),
    stream: async (_job, onDelta) => {
      onDelta("你");
      onDelta("好");
      return "你好";
    },
    delta: (_job, piece) => log.push(`delta:${piece}`),
    settle: (_job, outcome) => void log.push(`settle:${JSON.stringify(outcome)}`),
  });
  assert.equal(x.kind, "model");
  assert.ok(x.ready() && x.alive());
  assert.deepEqual(await x.run(job, new AbortController().signal), { text: "你好" });
  assert.deepEqual(log, ["begin", "delta:你", "delta:好", 'settle:{"text":"你好"}']);
});

test("what streamed in stands in for a call that returns nothing; an empty reply is no result", async () => {
  const pieces = new ModelExecutor("m", "m", { stream: async (_job, onDelta) => (onDelta("只有流"), "") });
  assert.deepEqual(await pieces.run(job, new AbortController().signal), { text: "只有流" });
  const outcomes: ModelOutcome[] = [];
  const empty = new ModelExecutor("m", "m", { stream: async () => "", settle: (_job, o) => void outcomes.push(o) });
  assert.equal(await empty.run(job, new AbortController().signal), null);
  assert.deepEqual(outcomes, [{ text: "" }]);
});

test("a call that fails or is stopped is settled with what had arrived and why, then the error goes on", async () => {
  const outcomes: ModelOutcome[] = [];
  const failing = new ModelExecutor("m", "m", {
    stream: async (_job, onDelta) => {
      onDelta("说到一半 ");
      throw new Error("429 限流了");
    },
    settle: (_job, o) => void outcomes.push(o),
  });
  await assert.rejects(failing.run(job, new AbortController().signal), /429/);
  assert.deepEqual(outcomes, [{ text: "说到一半", error: "429 限流了", aborted: undefined }]);

  for (const reason of ["cancelled", "timeout"] as const) {
    outcomes.length = 0;
    const c = new AbortController();
    const stopped = new ModelExecutor("m", "m", {
      stream: (_job, onDelta, signal) =>
        new Promise((_resolve, reject) => {
          onDelta("刚开口");
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      settle: (_job, o) => void outcomes.push(o),
    });
    const run = stopped.run(job, c.signal);
    c.abort(reason);
    await assert.rejects(run);
    assert.deepEqual(outcomes, [{ text: "刚开口", error: "aborted", aborted: reason }]);
  }
});

test("on the dispatcher: the reply is the job's result, and the reply is stored before the next job in the lane starts", async () => {
  const d = new Dispatcher({ emit: () => {} });
  const stored: string[] = [];
  const seenByNext: string[][] = [];
  const speaker = (name: string) =>
    new ModelExecutor(name, name, {
      stream: async () => {
        seenByNext.push([...stored]);
        return `${name} 的话`;
      },
      // Slow on purpose: storing must still be finished before the next speaker begins.
      settle: async (_job, o) => {
        await new Promise((r) => setTimeout(r, 15));
        stored.push(o.text);
      },
    });
  const a = d.submit({ executor: speaker("甲"), input: "q", origin: "user", from: "用户", lane: "g" });
  assert.ok(!("error" in a));
  const b = d.submit({ executor: speaker("乙"), input: "q", origin: "user", from: "用户", parentId: a.job.id, lane: "g" });
  assert.ok(!("error" in b));
  const [ja, jb] = await Promise.all([a.done, b.done]);
  assert.deepEqual([ja.status, ja.result?.text, ja.executor.kind], ["done", "甲 的话", "model"]);
  assert.deepEqual([jb.status, jb.rootId], ["done", ja.id]);
  assert.deepEqual(seenByNext, [[], ["甲 的话"]]);
  d.close();
});
