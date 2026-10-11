import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentExecutor } from "../../src/main/dispatch/agent.ts";
import { AgentDispatchService } from "../../src/main/dispatch/agent-service.ts";
import { AgentApprovals } from "../../src/main/connectors/approval.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { Verifier } from "../../src/main/dispatch/verify.ts";
import type { DispatchEvent, DispatchJob, DispatchProgress } from "../../src/shared/types.ts";
const stub = fileURLToPath(new URL("../connectors/fake-acp.mjs", import.meta.url));
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-"));
  const cwd = path.join(dir, "workspace"); await fs.mkdir(cwd);
  const log = path.join(dir, "stdio.jsonl");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { cwd, log };
}
function submitted(sub: ReturnType<Dispatcher["submit"]>) { if ("error" in sub) throw Error(sub.error); return sub; }
function verifierOptions(v: Verifier) { return { before: (j: DispatchJob, s: AbortSignal) => v.before(j, s), after: (j: DispatchJob, state: unknown, s: AbortSignal) => v.after(j, state as Parameters<Verifier["after"]>[1], s), end: (j: DispatchJob) => v.end(j) }; }
for (const task of ["files", "crash", "cancel", "limit"]) test(`agent scheduler state, progress and local receipt: ${task}`, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.cwd, "changed.txt"), "old"); await fs.writeFile(path.join(f.cwd, "deleted.txt"), "old");
  const events: DispatchEvent[] = [];
  const v = new Verifier(async () => ({ output: "", exitCode: 0 }));
  const d = new Dispatcher({ emit: e => events.push(e), verifier: verifierOptions(v) }); t.after(() => d.close());
  let runId = "";
  const exec = new AgentExecutor({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], approveStart: async () => true, permission: async () => null,
    progress: (id, p) => { runId = id; d.progress(id, p); if (task === "cancel" && p.type === "text") d.cancel(id); },
  });
  const sub = submitted(d.submit({ executor: exec, input: task, origin: "user", from: "sikeoop", scope: { roots: [f.cwd] } }));
  const done = await sub.done;
  assert.equal(runId, done.id); assert.equal(done.executor.kind, "agent");
  assert.equal(done.status, task === "files" ? "done" : task === "cancel" ? "cancelled" : "failed");
  assert.ok(events.some(e => e.type === "progress")); assert.ok(done.progress!.some(p => p.type === "text"));
  assert.ok(done.checks?.some(c => c.kind === "files")); assert.ok(done.result?.files);
  assert.deepEqual(done.result!.files, task === "files" ? { created: ["created.txt"], changed: ["changed.txt"], deleted: ["deleted.txt"] } : { created: [], changed: [], deleted: [] });
  const pid = JSON.parse((await fs.readFile(f.log, "utf8")).split("\n")[0]).pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
test("launch rejected: no child spawned", async t => {
  const f = await fixture(t); const d = new Dispatcher({ emit: () => {} }); t.after(() => d.close());
  const exec = new AgentExecutor({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], approveStart: async () => false, permission: async () => null, progress: () => {} });
  const job = await submitted(d.submit({ executor: exec, input: "normal", origin: "user", from: "sikeoop" })).done;
  assert.equal(job.status, "failed"); await assert.rejects(fs.stat(f.log), { code: "ENOENT" });
});
test("write permission outside owns is denied before approval, read-only rejects edit", async t => {
  const f = await fixture(t);
  for (const readOnly of [false, true]) {
    let approvals = 0; const d = new Dispatcher({ emit: () => {} });
    const exec = new AgentExecutor({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], readOnly, approveStart: async () => true,
      permission: async () => { approvals++; return "opaque:once"; }, progress: (id, p) => d.progress(id, p),
    });
    const done = await submitted(d.submit({ executor: exec, input: "permission-edit", origin: "user", from: "sikeoop", scope: { roots: [f.cwd], owns: ["mine.txt"] } })).done;
    d.close(); assert.equal(approvals, 0); assert.equal(done.status, "done");
  }
  const rows = (await fs.readFile(f.log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.ok(rows.filter(r => r.id === "permission-opaque").every(r => r.result.outcome.outcome === "cancelled"));
});
test("agent tree budget refuses next dispatch, no extra child", async t => {
  const f = await fixture(t); const events: DispatchEvent[] = [];
  const d = new Dispatcher({ emit: e => events.push(e), budget: { agent: 1 } }); t.after(() => d.close());
  const make = () => new AgentExecutor({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], approveStart: async () => true, permission: async () => null, progress: () => {} });
  const root = submitted(d.submit({ executor: make(), input: "normal", origin: "agent", from: "A" }));
  await root.done;
  const next = d.submit({ executor: make(), input: "normal", origin: "agent", from: "A", parentId: root.job.id });
  assert.ok("error" in next); assert.ok(events.some(e => e.type === "budget_exhausted"));
  assert.equal((await fs.readFile(f.log, "utf8")).split("\n").filter(l => l.includes('"pid"')).length, 1);
});
test("bounded progress, permission waiting state and cancellation during approval", async t => {
  const f = await fixture(t); const removed: string[] = [];
  let d: Dispatcher;
  const broker = new AgentApprovals(card => { d.cancel(card.jobId); }, id => removed.push(id));
  d = new Dispatcher({ emit: () => {} }); t.after(() => d.close());
  const exec = new AgentExecutor({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], approveStart: async () => true,
    permission: (c, signal) => broker.ask(c, signal), progress: (id, p) => d.progress(id, p),
  });
  const done = await submitted(d.submit({ executor: exec, input: "permission", origin: "user", from: "sikeoop" })).done;
  assert.equal(done.status, "cancelled"); assert.equal(removed.length, 1);
  // A non-running queue cannot be flooded by stale progress.
  const queued = submitted(d.submit({ executor: { kind: "agent", ref: "blocked", name: "blocked", ready: () => false, alive: () => true, run: async () => null }, input: "", origin: "user", from: "u" }));
  d.progress(queued.job.id, { type: "text", at: 0, text: "stale" }); assert.equal(d.jobs().find(j => j.id === queued.job.id)?.progress, undefined);
  d.cancel(queued.job.id); await queued.done;
});
test("progress retains the last 100 events and recovers running after permission", async t => {
  const d = new Dispatcher({ emit: () => {} }); t.after(() => d.close());
  const exec = { kind: "agent" as const, ref: "progress", name: "fake", alive: () => true, ready: () => true, run: async (job: DispatchJob) => {
    for (let i = 0; i < 120; i++) d.progress(job.id, { type: "text", at: i, text: String(i) });
    assert.equal(d.current(exec.ref)?.progress?.length, 100);
    assert.equal(d.current(exec.ref)?.progress?.[0].text, "20");
    d.progress(job.id, { type: "permission", at: 121 }); assert.equal(d.current(exec.ref)?.status, "waiting_approval");
    d.progress(job.id, { type: "status", at: 122, text: "running" }); assert.equal(d.current(exec.ref)?.status, "running");
    return { text: "ok", outcome: "end_turn" };
  } };
  assert.equal((await submitted(d.submit({ executor: exec, input: "", origin: "user", from: "u" })).done).status, "done");
});
test("agent submission is gated in production and validates before any child starts", () => {
  const d = new Dispatcher({ emit: () => {} });
  const approvals = new AgentApprovals(() => {}, () => {});
  const base = { root: () => "/tmp", bin: () => process.execPath, dispatcher: d, approvals };
  assert.throws(() => new AgentDispatchService({ ...base, development: () => false }).submit({ input: "x" }), /development-only/);
  assert.throws(() => new AgentDispatchService({ ...base, development: () => true, root: () => null }).submit({ input: "x" }), /workspace/);
  const service = new AgentDispatchService({ ...base, development: () => true });
  for (const bad of [{ input: "" }, { input: "x", readOnly: "false" }, { input: "x", model: "bad" }, { input: "x", timeoutMs: -1 }, { input: "x", owns: [1] }]) assert.throws(() => service.submit(bad));
  assert.equal(d.jobs().length, 0); d.close();
});
