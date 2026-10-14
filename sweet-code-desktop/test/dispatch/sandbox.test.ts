// Task sandboxes (src/main/dispatch/sandbox.ts) on real folders, and the per-task project root (workspace.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandbox, discardSandbox, MAX_RESTARTS, mergeSandbox, reworkInput, runInSandbox, sandboxChanges, type Sandbox,
  type SandboxRun } from "../../src/main/dispatch/sandbox.ts";
import { getRoot, hasRoot, resolveSafe, setRoot, withRoot } from "../../src/main/workspace.ts";
import type { DispatchCheck } from "../../src/shared/types.ts";

function project() {
  const top = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-sandbox-")));
  const root = path.join(top, "project");
  const put = (rel: string, text: string, base = root) => {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), text);
  };
  put("src/a.ts", "export const a = 1;\n");
  put("src/b.ts", "export const b = 1;\n");
  put("README.md", "# demo\n");
  put("node_modules/dep/index.js", "module.exports = 1;\n");
  put(".git/HEAD", "ref: refs/heads/main\n");
  put("dist/big.bin", "x".repeat(1000));
  put(".DS_Store", "junk");
  let n = 0;
  return { top, root, put, read: (rel: string, base = root) => readFileSync(path.join(base, rel), "utf8"),
    next: () => path.join(top, `sandbox-${++n}`), done: () => rmSync(top, { recursive: true, force: true }) };
}
/** Makes a later write visible to a "mtime:size" comparison even on a coarse clock. */
const touchLater = (file: string) => utimesSync(file, new Date(), new Date(Date.now() + 5000));

test("the copy has the source, links the dependencies, and leaves out history and build output", async () => {
  const p = project();
  try {
    const sb = await createSandbox(p.root, p.next());
    assert.equal(p.read("src/a.ts", sb.dir), "export const a = 1;\n");
    assert.equal(p.read("README.md", sb.dir), "# demo\n");
    assert.ok(lstatSync(path.join(sb.dir, "node_modules")).isSymbolicLink());
    assert.equal(p.read("node_modules/dep/index.js", sb.dir), "module.exports = 1;\n");
    for (const gone of [".git", "dist", ".DS_Store"]) assert.equal(existsSync(path.join(sb.dir, gone)), false, gone);
    assert.deepEqual([...sb.base.keys()].sort(), ["README.md", path.join("src", "a.ts"), path.join("src", "b.ts")]);
    assert.deepEqual(await sandboxChanges(sb), { written: [], removed: [] });

    // Thrown away: the copy goes, the dependencies it linked stay.
    await discardSandbox(sb);
    assert.equal(existsSync(sb.dir), false);
    assert.equal(p.read("node_modules/dep/index.js"), "module.exports = 1;\n");
    await assert.rejects(createSandbox(p.root, path.join(p.root, "inside")), /不能建在项目文件夹里面/);
  } finally { p.done(); }
});

test("work in the copy leaves the project alone until it is merged; then edits, new files and deletions all arrive", async () => {
  const p = project();
  try {
    const sb = await createSandbox(p.root, p.next());
    p.put("src/a.ts", "export const a = 2; // changed\n", sb.dir);
    touchLater(path.join(sb.dir, "src/a.ts"));
    p.put("src/new/c.ts", "export const c = 3;\n", sb.dir);
    rmSync(path.join(sb.dir, "src/b.ts"));
    assert.equal(p.read("src/a.ts"), "export const a = 1;\n");
    assert.equal(existsSync(path.join(p.root, "src/new/c.ts")), false);

    const changes = await sandboxChanges(sb);
    assert.deepEqual(changes, { written: [path.join("src", "a.ts"), path.join("src", "new", "c.ts")], removed: [path.join("src", "b.ts")] });
    const result = await mergeSandbox(sb, changes);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.merged.length, 3);
    assert.equal(p.read("src/a.ts"), "export const a = 2; // changed\n");
    assert.equal(p.read("src/new/c.ts"), "export const c = 3;\n");
    assert.equal(existsSync(path.join(p.root, "src/b.ts")), false);
    assert.equal(p.read("README.md"), "# demo\n");
  } finally { p.done(); }
});

test("a file someone else changed, created or deleted in the project meanwhile stops the whole merge", async () => {
  const p = project();
  try {
    const sb = await createSandbox(p.root, p.next());
    p.put("src/a.ts", "sandbox version of a\n", sb.dir);
    touchLater(path.join(sb.dir, "src/a.ts"));
    p.put("src/b.ts", "sandbox version of b!\n", sb.dir);
    touchLater(path.join(sb.dir, "src/b.ts"));
    p.put("src/c.ts", "sandbox c\n", sb.dir);
    // Meanwhile, in the project: a is edited, c appears. b is untouched.
    p.put("src/a.ts", "someone else's edit of a, longer\n");
    p.put("src/c.ts", "someone else's c\n");
    const result = await mergeSandbox(sb, await sandboxChanges(sb));
    assert.deepEqual(result, { merged: [], conflicts: [path.join("src", "a.ts"), path.join("src", "c.ts")] });
    // Nothing was written, not even the file that had no conflict.
    assert.equal(p.read("src/a.ts"), "someone else's edit of a, longer\n");
    assert.equal(p.read("src/b.ts"), "export const b = 1;\n");
    assert.equal(p.read("src/c.ts"), "someone else's c\n");

    // A file the task deleted but someone else already removed is a conflict too.
    const sb2 = await createSandbox(p.root, p.next());
    rmSync(path.join(sb2.dir, "README.md"));
    rmSync(path.join(p.root, "README.md"));
    assert.deepEqual((await mergeSandbox(sb2, await sandboxChanges(sb2))).conflicts, ["README.md"]);
  } finally { p.done(); }
});

interface Script { reports: string[]; checks: DispatchCheck[][] }
function runner(p: ReturnType<typeof project>, script: Script, edit: (sb: Sandbox, round: number) => void = () => {}) {
  const log: string[] = [];
  const opened: Sandbox[] = [];
  const inputs: string[] = [];
  let round = 0;
  const run: SandboxRun<number> = {
    open: async () => { const sb = await createSandbox(p.root, p.next()); opened.push(sb); return sb; },
    begin: async () => opened.length,
    work: async (sb, input) => { inputs.push(input); edit(sb, round); return script.reports[round] ?? `report ${round}`; },
    check: async () => script.checks[round++] ?? [],
    note: (text) => log.push(text),
  };
  return { run, log, opened, inputs };
}
const fail = (summary: string, details?: string[]): DispatchCheck[] => [{ kind: "typecheck", level: "fail", summary, ...(details ? { details } : {}) }];
const pass: DispatchCheck[] = [{ kind: "owns", level: "pass", summary: "ok" }, { kind: "files", level: "warn", summary: "a warning is not a failure" }];

test("a task that passes first time is merged once and its copy removed", async () => {
  const p = project();
  try {
    const r = runner(p, { reports: ["done"], checks: [pass] }, (sb) => p.put("src/c.ts", "export const c = 1;\n", sb.dir));
    const text = await runInSandbox("add c", new AbortController().signal, r.run);
    assert.match(text, /^done\n\n（在沙盒里完成，第 1 次通过，1 个文件已合并回项目。）$/);
    assert.equal(p.read("src/c.ts"), "export const c = 1;\n");
    assert.equal(r.opened.length, 1);
    assert.equal(existsSync(r.opened[0].dir), false);
    assert.deepEqual(r.inputs, ["add c"]);
  } finally { p.done(); }
});

test("a failed check is fixed once in the same copy; a second failure throws the copy away and starts over with the original task", async () => {
  const p = project();
  try {
    const r = runner(p, { reports: ["first", "fixed?", "second try"], checks: [fail("类型检查新增 2 个错误", ["src/c.ts TS1: x"]), fail("还是不行"), pass] },
      (sb, round) => p.put("src/c.ts", `// round ${round}\n`, sb.dir));
    const text = await runInSandbox("add c", new AbortController().signal, r.run);
    assert.match(text, /^second try\n\n（在沙盒里完成，第 2 次通过/);
    assert.equal(r.opened.length, 2);
    for (const sb of r.opened) assert.equal(existsSync(sb.dir), false);
    // Round 0 and 1 share the first copy; the rework names the problems; the restart gets the task afresh.
    assert.equal(r.inputs[0], "add c");
    assert.equal(r.inputs[1], reworkInput("add c", ["类型检查新增 2 个错误", "  src/c.ts TS1: x"]));
    assert.match(r.inputs[1], /只修下面这些问题，不要重做/);
    assert.equal(r.inputs[2], "add c");
    assert.equal(p.read("src/c.ts"), "// round 2\n");
    assert.deepEqual(r.log.map((l) => l.slice(0, 12)), ["沙盒已建好，在副本里开工", "沙盒里验收没过，在原沙盒", "沙盒已丢弃：还是不行", "第 2 个沙盒已建好，新", "沙盒验收通过，1 个文件"]);
  } finally { p.done(); }
});

test("when no attempt passes the project is untouched and the last problem is reported", async () => {
  const p = project();
  try {
    const r = runner(p, { reports: [], checks: Array.from({ length: 6 }, (_, i) => fail(`问题 ${i}`)) }, (sb) => {
      p.put("src/a.ts", "broken\n", sb.dir);
      touchLater(path.join(sb.dir, "src/a.ts"));
    });
    await assert.rejects(runInSandbox("break a", new AbortController().signal, r.run),
      new RegExp(`做了 ${MAX_RESTARTS + 1} 次都没通过验收，项目没有被改动。最后一次的问题：\\n问题 5`));
    assert.equal(r.opened.length, MAX_RESTARTS + 1);
    assert.equal(r.inputs.length, (MAX_RESTARTS + 1) * 2);
    assert.equal(p.read("src/a.ts"), "export const a = 1;\n");
    for (const sb of r.opened) assert.equal(existsSync(sb.dir), false);
  } finally { p.done(); }
});

test("a merge conflict counts as a failed attempt: the next copy starts from the project as it is now", async () => {
  const p = project();
  try {
    const r = runner(p, { reports: ["one", "two"], checks: [pass, pass] }, (sb, round) => {
      p.put("src/a.ts", `task's a, round ${round}\n`, sb.dir);
      touchLater(path.join(sb.dir, "src/a.ts"));
      if (round === 0) p.put("src/a.ts", "edited in the project while the task ran\n");
    });
    const text = await runInSandbox("edit a", new AbortController().signal, r.run);
    assert.match(text, /^two\n\n（在沙盒里完成，第 2 次通过/);
    assert.equal(p.read("src/a.ts"), "task's a, round 1\n");
    assert.ok(r.log.some((l) => /沙盒已丢弃：合并时发现项目里这些文件在它干活期间被别人改过：src.a\.ts/.test(l)));
  } finally { p.done(); }
});

test("a cancelled task stops, leaves nothing behind and merges nothing", async () => {
  const p = project();
  try {
    const stop = new AbortController();
    const r = runner(p, { reports: ["done"], checks: [pass] }, (sb) => { p.put("src/c.ts", "c\n", sb.dir); stop.abort(); });
    await assert.rejects(runInSandbox("add c", stop.signal, r.run), /已取消/);
    assert.equal(existsSync(path.join(p.root, "src/c.ts")), false);
    assert.equal(existsSync(r.opened[0].dir), false);
  } finally { p.done(); }
});

test("withRoot gives one task its own project folder, across awaits, without moving anyone else's", async () => {
  const p = project();
  try {
    await setRoot(p.root);
    const sb = await createSandbox(p.root, p.next());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inside = withRoot(sb.dir, async () => {
      await gate;
      await new Promise((r) => setTimeout(r, 1));
      return { root: getRoot(), has: hasRoot(), file: await resolveSafe("src/a.ts") };
    });
    // Outside, at the same time, the project is still the project.
    assert.equal(getRoot(), p.root);
    assert.equal(await resolveSafe("src/a.ts"), path.join(p.root, "src", "a.ts"));
    release();
    assert.deepEqual(await inside, { root: sb.dir, has: true, file: path.join(sb.dir, "src", "a.ts") });
    assert.equal(getRoot(), p.root);
    // From inside the copy, the project is outside.
    await assert.rejects(withRoot(sb.dir, () => resolveSafe(path.join(p.root, "src/a.ts"))), /在项目文件夹外面/);
  } finally { p.done(); }
});
