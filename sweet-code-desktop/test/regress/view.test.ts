// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSettings, conflictsOf, DEFAULT_SETTINGS, diffRows, latestRuns, runStatus, snapshotResults } from "../../src/main/regress/view.ts";
import type { DispatchJob, RegressItem, RegressRun } from "../../src/shared/types.ts";

const item = (id: string): RegressItem => ({ id, title: id, detail: "", owner: "both", criteria: "", createdAt: 0, updatedAt: 0 });
const run = (id: string, itemId: string, cli: "claude" | "codex", verdict: RegressRun["verdict"], startedAt: number): RegressRun => ({
  id, itemId, session: `${cli}-1`, cli, startedAt, endedAt: startedAt + 1, status: "done", auto: verdict, verdict, overridden: false, reason: "", excerpt: "",
});

test("a run's status is its job's status", () => {
  const map: Record<DispatchJob["status"], RegressRun["status"]> = {
    queued: "queued", starting: "running", running: "running", waiting_approval: "running",
    done: "done", timeout: "timeout", exited: "gone", cancelled: "cancelled", failed: "error",
  };
  for (const [job, expected] of Object.entries(map)) assert.equal(runStatus(job as DispatchJob["status"]), expected, job);
});

test("settings are whole numbers inside their ranges", () => {
  assert.deepEqual(clampSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(clampSettings({ runTimeoutSec: 1, generateTimeoutSec: 99999, maxPerBatch: 0, maxCandidates: 1000 }), { runTimeoutSec: 30, generateTimeoutSec: 3600, maxPerBatch: 1, maxCandidates: 100 });
  assert.deepEqual(clampSettings({ runTimeoutSec: 90.6, maxPerBatch: "很多", maxCandidates: NaN }), { ...DEFAULT_SETTINGS, runTimeoutSec: 91 });
  assert.deepEqual(clampSettings({ maxPerBatch: 7 }, { ...DEFAULT_SETTINGS, runTimeoutSec: 60 }), { ...DEFAULT_SETTINGS, runTimeoutSec: 60, maxPerBatch: 7 });
  assert.deepEqual(clampSettings("不是对象"), DEFAULT_SETTINGS);
});

test("latest is per item and per CLI, only for items that still exist; conflicts need two decided verdicts that differ", () => {
  const items = [item("a"), item("b"), item("c")];
  const runs = [
    run("r1", "a", "claude", "fail", 1), run("r2", "a", "claude", "pass", 5), run("r3", "a", "codex", "fail", 3),
    run("r4", "b", "claude", "pass", 2), run("r5", "b", "codex", "pending", 2),
    run("r6", "c", "claude", "pass", 2), run("r7", "c", "codex", "pass", 2),
    run("r8", "deleted", "claude", "pass", 9),
  ];
  const latest = latestRuns(items, runs);
  assert.deepEqual(Object.keys(latest).sort(), ["a", "b", "c"]);
  assert.equal(latest.a.claude?.id, "r2");
  assert.equal(latest.a.codex?.id, "r3");
  assert.deepEqual(conflictsOf(items, latest), ["a"]);
});

test("a baseline records every latest verdict, and a diff compares CLI with CLI", () => {
  const items = [item("a"), item("b"), item("c"), item("d"), item("e")];
  const then = latestRuns(items, [
    run("1", "a", "claude", "pass", 1), run("2", "b", "claude", "fail", 1), run("3", "c", "claude", "pass", 1),
    run("4", "d", "claude", "pending", 1), run("5", "e", "claude", "pass", 1), run("6", "a", "codex", "pass", 1),
  ]);
  const results = snapshotResults(then);
  assert.deepEqual(results.d, { claude: { runId: "4", verdict: "pending" } }, "undecided ones are recorded too");
  assert.deepEqual(Object.keys(results.a).sort(), ["claude", "codex"]);

  const now = latestRuns(items.filter((i) => i.id !== "e"), [
    run("7", "a", "claude", "fail", 2), run("8", "b", "claude", "pass", 2), run("9", "c", "claude", "pass", 2),
    run("10", "d", "claude", "pass", 2), run("11", "b", "codex", "pass", 2),
  ]);
  const rows = diffRows({ id: "base", name: "发版前", createdAt: 0, results }, now);
  const kind = (itemId: string, cli: string) => rows.find((r) => r.itemId === itemId && r.cli === cli)?.kind;
  assert.equal(kind("a", "claude"), "regressed");
  assert.equal(kind("b", "claude"), "fixed");
  assert.equal(kind("c", "claude"), "same");
  assert.equal(kind("d", "claude"), "same", "pending → pass is neither a regression nor a fix");
  assert.equal(kind("e", "claude"), "missing");
  assert.equal(kind("a", "codex"), "missing");
  assert.equal(kind("b", "codex"), "new");
  assert.equal(kind("c", "codex"), undefined, "nothing on either side: no row");
});
