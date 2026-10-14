// Run: node --test test/dispatch/
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobLog } from "../../src/main/dispatch/store.ts";
import type { DispatchJob } from "../../src/shared/types.ts";

const job = (id: string, status: DispatchJob["status"], at: number): DispatchJob => ({
  id,
  rootId: id,
  origin: "chat",
  from: "sikeoop",
  executor: { kind: "cli", ref: "x", name: "Codex-1" },
  input: "做点事",
  limits: { timeoutMs: 1000 },
  status,
  createdAt: at,
  startedAt: at,
  ...(status === "running" ? {} : { endedAt: at + 1 }),
});

test("last line per job wins; a job cut off by a quit shows as exited; torn lines are skipped", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  await log.append("/p", job("a", "running", 1));
  await log.append("/p", job("a", "done", 1));
  await log.append("/p", job("b", "running", 5));
  const sub = readdirSync(dir)[0];
  appendFileSync(path.join(dir, sub, "jobs.jsonl"), '{"id":"c","sta');

  const jobs = await log.load("/p", 10);
  assert.deepEqual(jobs.map((j) => [j.id, j.status]), [["b", "exited"], ["a", "done"]]);
  assert.match(jobs[0].error ?? "", /还没做完/);
  assert.deepEqual(await log.load("/other", 10), []);
});

test("a long log is cut down to the newest jobs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  for (let i = 0; i < 30; i++) await log.append("/p", job(`j${i}`, "done", i));
  const jobs = await log.load("/p", 5);
  assert.deepEqual(jobs.map((j) => j.id), ["j29", "j28", "j27", "j26", "j25"]);
  const file = path.join(dir, readdirSync(dir)[0], "jobs.jsonl");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 5);
});

test("a job stays in the log of the project it was handed out in, whatever is open when it ends", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  await log.record(job("a", "queued", 1), "/first");
  await log.record(job("a", "running", 1), "/first");
  // The user opens another project while it runs.
  await log.record(job("a", "done", 1), "/second");
  assert.deepEqual((await log.load("/first", 10)).map((j) => [j.id, j.status]), [["a", "done"]]);
  assert.deepEqual(await log.load("/second", 10), []);

  // A job that says where it works is logged there.
  await log.record({ ...job("b", "running", 2), scope: { roots: ["/work"] } }, "/second");
  await log.record({ ...job("b", "done", 2), scope: { roots: ["/work"] } }, "/second");
  assert.deepEqual((await log.load("/work", 10)).map((j) => j.id), ["b"]);

  // With no project at all, nothing is written.
  await log.record(job("d", "running", 4), null);
  assert.deepEqual((await log.load("/first", 10)).map((j) => j.id), ["a"]);
});

const lines = (dir: string) => readFileSync(path.join(dir, readdirSync(dir)[0], "jobs.jsonl"), "utf8").split("\n").filter(Boolean);

test("T3-2: an unchanged status isn't written again; the end line keeps only the last 20 progress items", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  const progress = Array.from({ length: 50 }, (_, i) => ({ type: "tool" as const, at: i, title: `t${i}` }));
  for (let i = 0; i < 3; i++) await log.record({ ...job("a", "running", 1), progress: progress.slice(0, i + 1) }, "/p");
  await log.record({ ...job("a", "done", 1), progress }, "/p");
  const written = lines(dir).map((l) => JSON.parse(l) as DispatchJob);
  assert.equal(written.length, 2);
  assert.equal(written[0].progress, undefined);
  assert.equal(written[1].progress?.length, 20);
  assert.equal(written[1].progress?.[0].title, "t30");
});

test("T3-3: a finished job touched again appends a line and load() takes the newest", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  await log.record(job("a", "done", 1), "/p");
  await log.record({ ...job("a", "done", 1), needsReview: true }, "/p");
  assert.equal(lines(dir).length, 2);
  const [loaded] = await log.load("/p", 10);
  assert.equal(loaded.needsReview, true);
});

test("T14-1: a job still queued at quit shows as exited, saying it never left the queue", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-log-"));
  const log = new JobLog(dir);
  const { startedAt: _, ...queued } = job("q", "queued", 1);
  await log.record(queued, "/p");
  const [loaded] = await log.load("/p", 10);
  assert.equal(loaded.status, "exited");
  assert.match(loaded.error ?? "", /还在排队/);
});
