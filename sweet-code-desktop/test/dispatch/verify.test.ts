// Run: node --test test/dispatch/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Verifier, mentionedFiles, typeErrors, typeErrorList } from "../../src/main/dispatch/verify.ts";
import type { DispatchJob } from "../../src/shared/types.ts";

function job(root: string, extra: Partial<DispatchJob> = {}): DispatchJob {
  return {
    id: "j",
    rootId: "j",
    origin: "chat",
    from: "sikeoop",
    executor: { kind: "cli", ref: "x", name: "Codex-1" },
    input: "",
    limits: { timeoutMs: 1000 },
    status: "running",
    createdAt: 0,
    scope: { roots: [root], owns: ["src/mine.ts"] },
    ...extra,
  };
}

test("type errors are keyed without line numbers", () => {
  const before = typeErrors("src/a.ts(5,7): error TS2741: Property 'x' is missing.\nnoise");
  const after = typeErrors("src/a.ts(9,7): error TS2741: Property 'x' is missing.\nsrc/b.ts:3:1 - error TS2322: Bad.");
  assert.equal(before.size, 1);
  assert.deepEqual([...after].filter((e) => !before.has(e)), ["src/b.ts TS2322: Bad."]);
});

test("report paths are picked out, URLs are not", () => {
  const found = mentionedFiles("新建了 `src/main/publish/client.ts`，见 https://x.dev/a/b.js 和 /abs/dir/f.json。", ["/p"]);
  assert.deepEqual(found.sort(), ["/abs/dir/f.json", "/p/src/main/publish/client.ts"]);
});

test("after a job: changed files, files outside owns, new type errors, missing claims", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-v-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/mine.ts"), "a");
  writeFileSync(path.join(root, "src/other.ts"), "a");
  mkdirSync(path.join(root, "node_modules"));
  let output = "src/old.ts(1,1): error TS1: old.";
  const v = new Verifier(async () => ({ output, exitCode: 2 }));
  const j = job(root, { verify: { typecheck: "tsc" } });
  const signal = new AbortController().signal;

  const state = await v.before(j, signal);
  await new Promise((r) => setTimeout(r, 15));
  writeFileSync(path.join(root, "src/mine.ts"), "bb");
  writeFileSync(path.join(root, "src/new.ts"), "c");
  rmSync(path.join(root, "src/other.ts"));
  writeFileSync(path.join(root, "node_modules/ignored.js"), "x");
  output = "src/old.ts(2,1): error TS1: old.\nsrc/mine.ts(1,1): error TS2: new.";

  const checks = await v.after({ ...j, result: { text: "改了 src/mine.ts，新建了 src/ghost.ts" } }, state, signal);
  const by = Object.fromEntries(checks.map((c) => [c.kind, c]));
  assert.equal(by.files.details?.length, 3);
  assert.equal(by.owns.level, "fail");
  assert.deepEqual(by.owns.details?.sort(), ["src/new.ts", "src/other.ts"]);
  assert.equal(by.typecheck.level, "fail");
  assert.deepEqual(by.typecheck.details, ["src/mine.ts TS2: new."]);
  assert.equal(by.claims.level, "warn");
  assert.deepEqual(by.claims.details, ["src/ghost.ts"]);
});

test("a typecheck that didn't run is reported as not compared, never as a pass", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-v-"));
  writeFileSync(path.join(root, "a.ts"), "a");
  const signal = new AbortController().signal;
  const j = job(root, { verify: { typecheck: "tsc" } });

  // The command isn't there at all: there is no baseline to compare with.
  const missing = new Verifier(async () => ({ output: "sh: tsc: command not found", exitCode: 127 }));
  const before = await missing.before(j, signal);
  writeFileSync(path.join(root, "b.ts"), "b");
  const none = (await missing.after(j, before, signal)).find((c) => c.kind === "typecheck");
  assert.equal(none?.level, "warn");
  assert.match(none?.details?.join(" ") ?? "", /基线/);

  // It worked before the job and broke after (the job deleted node_modules, say).
  let broken = false;
  const flaky = new Verifier(async () => (broken ? { output: "Cannot find module typescript", exitCode: 1 } : { output: "", exitCode: 0 }));
  const ok = await flaky.before(j, signal);
  broken = true;
  writeFileSync(path.join(root, "c.ts"), "c");
  const after = (await flaky.after(j, ok, signal)).find((c) => c.kind === "typecheck");
  assert.equal(after?.level, "warn");
  assert.match(after?.details?.join(" ") ?? "", /结束后/);

  // A clean run with no errors is still a pass.
  const clean = new Verifier(async () => ({ output: "", exitCode: 0 }));
  const s = await clean.before(j, signal);
  writeFileSync(path.join(root, "d.ts"), "d");
  assert.equal((await clean.after(j, s, signal)).find((c) => c.kind === "typecheck")?.level, "pass");
});

test("a file mentioned in a sibling folder that shares the root's prefix isn't checked", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "dispatch-v-"));
  mkdirSync(path.join(base, "app"));
  mkdirSync(path.join(base, "app2"));
  const v = new Verifier(async () => ({ output: "", exitCode: 0 }));
  const signal = new AbortController().signal;
  const j = job(path.join(base, "app"), { result: { text: `参考了 ${path.join(base, "app2", "src/x.ts")} 的写法，新建了 src/ghost.ts` } });
  const claims = (await v.after(j, await v.before(j, signal), signal)).find((c) => c.kind === "claims");
  assert.deepEqual(claims?.details, ["src/ghost.ts"]);
});

test("a change in files a job running at the same time may write is put down to that job", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-v-"));
  mkdirSync(path.join(root, "front"));
  mkdirSync(path.join(root, "back"));
  mkdirSync(path.join(root, "docs"));
  for (const f of ["front/a.ts", "back/b.ts", "docs/c.md"]) writeFileSync(path.join(root, f), "1");
  const v = new Verifier(async () => ({ output: "", exitCode: 0 }));
  const signal = new AbortController().signal;
  const front = job(root, { id: "front", scope: { roots: [root], owns: ["front/"] }, executor: { kind: "cli", ref: "c", name: "Claude-1" } });
  const back = job(root, { id: "back", scope: { roots: [root], owns: ["back/"] }, executor: { kind: "cli", ref: "x", name: "Codex-1" } });

  const frontState = await v.before(front, signal);
  const backState = await v.before(back, signal);
  await new Promise((r) => setTimeout(r, 15));
  for (const f of ["front/a.ts", "back/b.ts", "docs/c.md"]) writeFileSync(path.join(root, f), "22");

  // Codex-1 finishes first; Claude-1 was working alongside it the whole time.
  const backChecks = (await v.after(back, backState, signal)).filter((c) => c.kind === "owns");
  v.end(back);
  assert.deepEqual(backChecks.map((c) => [c.level, c.details]), [["fail", ["docs/c.md"]], ["warn", ["front/a.ts"]]]);
  assert.match(backChecks[1].summary, /Claude-1/);

  // Claude-1 finishes after Codex-1 is gone: what Codex-1 could write is still not held against it.
  const frontChecks = (await v.after(front, frontState, signal)).filter((c) => c.kind === "owns");
  v.end(front);
  assert.deepEqual(frontChecks.map((c) => [c.level, c.details]), [["fail", ["docs/c.md"]], ["warn", ["back/b.ts"]]]);

  // A job that starts when nobody else is working answers for everything.
  const alone = job(root, { id: "alone", scope: { roots: [root], owns: ["front/"] } });
  const aloneState = await v.before(alone, signal);
  await new Promise((r) => setTimeout(r, 15));
  writeFileSync(path.join(root, "back/b.ts"), "333");
  const aloneChecks = (await v.after(alone, aloneState, signal)).filter((c) => c.kind === "owns");
  assert.deepEqual(aloneChecks.map((c) => [c.level, c.details]), [["fail", ["back/b.ts"]]]);
});

test("build output, caches and system files are not counted as changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-v-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.ts"), "1");
  const v = new Verifier(async () => ({ output: "", exitCode: 0 }));
  const signal = new AbortController().signal;
  const j = job(root, { scope: { roots: [root], owns: ["src/"] } });
  const state = await v.before(j, signal);
  for (const dir of ["coverage", "target/debug", ".turbo", "oh_modules/x", ".hvigor", "src/__pycache__"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "out.bin"), "x");
  }
  writeFileSync(path.join(root, ".DS_Store"), "x");
  writeFileSync(path.join(root, "tsconfig.tsbuildinfo"), "x");
  writeFileSync(path.join(root, "src/b.ts"), "2");
  const by = Object.fromEntries((await v.after(j, state, signal)).map((c) => [c.kind, c]));
  assert.deepEqual(by.files.details, ["新建 src/b.ts"]);
  assert.equal(by.owns.level, "pass");
});

for (const scenario of [
  { name: "T7-1: alone, errors in other files fail", concurrent: false, mine: false, fail: true },
  { name: "T7-2: concurrent foreign errors only warn", concurrent: true, mine: false, fail: false },
  { name: "T7-3: only errors in own changed files fail", concurrent: true, mine: true, fail: true },
  { name: "read-only peers are not concurrent writers", concurrent: true, mine: false, fail: true, readOnly: true },
  { name: "disjoint roots are not concurrent writers", concurrent: true, mine: false, fail: true, disjoint: true },
]) {
  test(scenario.name, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "dispatch-f7-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "src"));
    for (const file of ["mine", "other"]) writeFileSync(path.join(root, `src/${file}.ts`), "1");
    let output = "";
    const v = new Verifier(async () => ({ output, exitCode: output ? 2 : 0 }));
    const signal = new AbortController().signal;
    const j = job(root, { verify: { typecheck: "tsc" } });
    const state = await v.before(j, signal);
    if (scenario.concurrent) {
      const peerRoot = scenario.disjoint ? path.join(root, "../", path.basename(root) + "-peer") : root;
      if (scenario.disjoint) {
        mkdirSync(peerRoot);
        t.after(() => rmSync(peerRoot, { recursive: true, force: true }));
      }
      await v.before(job(peerRoot, {
        id: "peer", scope: { roots: [peerRoot], owns: ["src/other.ts"], readOnly: scenario.readOnly },
        executor: { kind: "cli", ref: "peer", name: "Claude-2" },
      }), signal);
    }
    writeFileSync(path.join(root, "src/other.ts"), "22");
    if (scenario.mine) writeFileSync(path.join(root, "src/mine.ts"), "22");
    output = "src/other.ts(1,1): error TS2322: other.";
    if (scenario.mine) output += "\nsrc/mine.ts(1,1): error TS2322: mine.";
    const checks = (await v.after(j, state, signal)).filter((c) => c.kind === "typecheck");
    const fail = checks.find((c) => c.level === "fail");
    assert.equal(!!fail, scenario.fail);
    if (scenario.mine) assert.deepEqual(fail?.details, ["src/mine.ts TS2322: mine."]);
    if (!scenario.fail || scenario.mine) {
      const warn = checks.find((c) => c.level === "warn");
      assert.deepEqual(warn?.details, ["src/other.ts TS2322: other."]);
      assert.match(warn?.summary ?? "", /Claude-2/);
    }
  });
}

test("T7-4: concurrent before calls share one command", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-f7-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "a.ts"), "1");
  let calls = 0;
  const v = new Verifier(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { output: "", exitCode: 0 };
  });
  const signal = new AbortController().signal;
  await Promise.all(["one", "two"].map((id) => v.before(job(root, { id, verify: { typecheck: "tsc" } }), signal)));
  assert.equal(calls, 1);
});

test("different snapshots serialize checks and a failed run releases the queue", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-f7-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "a.ts"), "1");
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const v = new Verifier(async () => {
    calls++;
    if (calls === 1) {
      started();
      await gate;
      throw new Error("failed");
    }
    return { output: "", exitCode: 0 };
  });
  const signal = new AbortController().signal;
  const one = v.before(job(root, { id: "one", verify: { typecheck: "tsc" } }), signal);
  await firstStarted;
  writeFileSync(path.join(root, "a.ts"), "22");
  const two = v.before(job(root, { id: "two", verify: { typecheck: "tsc" } }), signal);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 1);
  release();
  const states = await Promise.all([one, two]);
  assert.equal(calls, 2);
  assert.equal(states[0].baseline, null);
  assert.equal(states[1].baseline?.size, 0);
});

test("typeErrorList resolves both diagnostic formats against the checked root", () => {
  assert.deepEqual(typeErrorList("src/a.ts(5,7): error TS2741: Missing.\nsrc/b.ts:3:1 - error TS2322: Bad.", "/project"), [
    { key: "src/a.ts TS2741: Missing.", file: "/project/src/a.ts" },
    { key: "src/b.ts TS2322: Bad.", file: "/project/src/b.ts" },
  ]);
});
