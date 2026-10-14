// Run: node --test test/dispatch/view.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, listed, type Executor } from "../../src/main/dispatch/scheduler.ts";
import type { DispatchEvent, DispatchJob, DispatchProgress } from "../../src/shared/types.ts";

/** An executor that runs until the test finishes it. */
class FakeExecutor implements Executor {
  readonly kind = "agent" as const;
  readonly ref: string;
  readonly name: string;
  private finishers: (() => void)[] = [];
  constructor(ref: string) {
    this.ref = ref;
    this.name = ref;
  }
  ready() {
    return true;
  }
  alive() {
    return true;
  }
  run(_job: DispatchJob, signal: AbortSignal) {
    return new Promise<{ text: string }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ text: "" }), { once: true });
      this.finishers.push(() => resolve({ text: "完成。".repeat(200) }));
    });
  }
  finish() {
    this.finishers.shift()!();
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const tool = (i: number): DispatchProgress => ({ type: "tool", at: i, title: `读 src/file${i}.ts` });

test("progress lines are their own events; the whole job goes out only when its status moves", async () => {
  const events: DispatchEvent[] = [];
  const d = new Dispatcher({ emit: (e) => events.push(e) });
  const x = new FakeExecutor("a");
  const r = d.submit({ executor: x, input: "做事", origin: "chat", from: "sikeoop" });
  assert.ok(!("error" in r));
  await tick();
  events.length = 0;
  for (let i = 0; i < 300; i++) d.progress(r.job.id, tool(i));
  assert.equal(events.filter((e) => e.type === "progress").length, 300);
  assert.equal(events.filter((e) => e.type === "job").length, 0, "300 tool lines, no whole-job events");
  d.progress(r.job.id, { type: "permission", at: 300, permission: { id: "p1", jobId: r.job.id, sessionId: "", title: "改文件", toolCall: {}, options: [] } });
  d.progress(r.job.id, { type: "status", at: 301, text: "running" });
  const statuses = events.flatMap((e) => (e.type === "job" ? [e.job.status] : []));
  assert.deepEqual(statuses, ["waiting_approval", "running"]);
  x.finish();
  await r.done;
  d.close();
});

test("the console list carries the newest progress and cut texts; job() has all of it", async () => {
  const d = new Dispatcher({ emit: () => {} });
  const x = new FakeExecutor("a");
  const input = "很长的任务说明。".repeat(200);
  const r = d.submit({ executor: x, input, origin: "chat", from: "sikeoop" });
  assert.ok(!("error" in r));
  await tick();
  for (let i = 0; i < 50; i++) d.progress(r.job.id, tool(i));

  const row = d.view().jobs.find((j) => j.id === r.job.id)!;
  assert.deepEqual(row.progress, [tool(49)], "only the newest line, for the live line");
  assert.ok(row.input.length < 500 && row.input.endsWith("…"));
  const full = d.job(r.job.id)!;
  assert.equal(full.progress?.length, 50);
  assert.equal(full.input, input);

  // Waiting for approval: the pending card stays in the list, next to the newest other line.
  const card: DispatchProgress = { type: "permission", at: 50, permission: { id: "p1", jobId: r.job.id, sessionId: "", title: "改文件", toolCall: {}, options: [] } };
  d.progress(r.job.id, card);
  assert.deepEqual(d.view().jobs.find((j) => j.id === r.job.id)!.progress, [tool(49), card]);

  x.finish();
  const done = await r.done;
  const finished = d.view().jobs.find((j) => j.id === r.job.id)!;
  assert.ok(finished.result!.text.length < 500 && finished.result!.text.endsWith("…"));
  assert.equal(d.job(r.job.id)!.result!.text, done.result!.text, "a finished job is still there in full");
  assert.equal(d.job("nope"), undefined);
  d.close();
});

test("a short job is listed as it is", () => {
  const job = { id: "j", rootId: "j", origin: "chat", from: "sikeoop", executor: { kind: "cli", ref: "c", name: "Claude-1" }, input: "短", limits: { timeoutMs: 1 }, status: "done", createdAt: 0, progress: [tool(1)], result: { text: "好" } } as DispatchJob;
  assert.equal(listed(job), job);
});
