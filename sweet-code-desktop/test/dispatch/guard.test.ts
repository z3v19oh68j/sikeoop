// Run: node --test test/dispatch/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isInside, matchOwns, preflight, realWriteViolation, writeViolation } from "../../src/main/dispatch/guard.ts";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";

test("owns patterns: exact, folder, globs", () => {
  const owns = ["src/main/publish/client.ts", "hosting/", "src/renderer/**/*.tsx", "docs/*.md"];
  assert.ok(matchOwns(owns, "src/main/publish/client.ts"));
  assert.ok(!matchOwns(owns, "src/main/publish/store.ts"));
  assert.ok(matchOwns(owns, "hosting/src/index.ts"));
  assert.ok(matchOwns(owns, "src/renderer/src/studio/Studio.tsx"));
  assert.ok(!matchOwns(owns, "src/renderer/src/dev-mock.ts"));
  assert.ok(matchOwns(owns, "docs/a.md"));
  assert.ok(!matchOwns(owns, "docs/sub/a.md"));
  // ** between slashes is any number of folders, including none.
  assert.ok(matchOwns(owns, "src/renderer/App.tsx"));
  assert.ok(matchOwns(["**/*.md"], "README.md"));
  assert.ok(matchOwns(["**/*.md"], "docs/sub/a.md"));
  assert.ok(matchOwns(["src/**"], "src/a/b.ts"));
  assert.ok(!matchOwns(["src/**/*.ts"], "srcx/a.ts"));
});

test("writes outside the roots or the owned files are refused", () => {
  const job = { scope: { roots: ["/p"], owns: ["src/a.ts"] } };
  assert.equal(writeViolation(job, "/p/src/a.ts"), null);
  assert.match(writeViolation(job, "/p/src/b.ts") ?? "", /不归这个任务负责/);
  assert.match(writeViolation(job, "/elsewhere/x.ts") ?? "", /不在这个任务的工作目录里/);
  assert.equal(writeViolation({ scope: { roots: ["/p"] } }, "/p/anything.ts"), null);
  assert.equal(writeViolation({}, "/anywhere"), null);
  // A name that only begins with two dots is inside; a real ".." is not.
  assert.equal(writeViolation({ scope: { roots: ["/p"], owns: ["..cache/"] } }, "/p/..cache/x"), null);
  assert.match(writeViolation({ scope: { roots: ["/p"] } }, "/p/../q/x") ?? "", /不在这个任务的工作目录里/);
});

test("preflight: missing deps and unwritable roots refuse, Codex network warns", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-pf-"));
  mkdirSync(path.join(root, "hosting"));
  const executor = { kind: "cli" as const, ref: "x", name: "Codex-1" };

  const deps = await preflight({ executor, scope: { roots: [root] }, needs: { deps: ["hosting"] } }, { writableRoots: [root] });
  assert.equal(deps.level, "fail");
  mkdirSync(path.join(root, "hosting", "node_modules"));
  assert.equal((await preflight({ executor, scope: { roots: [root] }, needs: { deps: ["hosting"] } }, { writableRoots: [root] })).level, "pass");

  // The B3/B5 case: the executor can only write a sub-folder of the job's root.
  const narrow = await preflight({ executor, scope: { roots: [root] } }, { writableRoots: [path.join(root, "docs")] });
  assert.equal(narrow.level, "fail");

  const net = await preflight({ executor, scope: { roots: [root] }, needs: { network: true } }, { writableRoots: [root], network: "ask" });
  assert.equal(net.level, "warn");
  const noNet = await preflight({ executor, scope: { roots: [root] }, needs: { network: true } }, { network: false });
  assert.equal(noNet.level, "fail");

  const missing = await preflight({ executor, scope: { roots: [path.join(root, "nope")] } }, {});
  assert.equal(missing.level, "fail");
});

test("on a file system that ignores case, so do the checks", () => {
  assert.ok(matchOwns(["src/App.tsx", "Docs/"], "SRC/app.tsx", true));
  assert.ok(matchOwns(["src/App.tsx", "Docs/"], "docs/a.md", true));
  assert.ok(!matchOwns(["src/App.tsx"], "SRC/app.tsx", false));
  assert.ok(isInside("/Users/me/App", "/users/me/app/src/a.ts", true));
  assert.ok(!isInside("/Users/me/App", "/users/me/app/src/a.ts", false));
  assert.equal(writeViolation({ scope: { roots: ["/P"], owns: ["Src/"] } }, "/p/src/a.ts", true), null);
  assert.match(writeViolation({ scope: { roots: ["/P"], owns: ["Src/"] } }, "/p/src/a.ts", false) ?? "", /不在这个任务的工作目录里/);
});

test("a symlink can't carry a write out of the job's folder or out of what it owns", async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-link-")));
  const root = path.join(base, "proj");
  mkdirSync(path.join(root, "mine"), { recursive: true });
  mkdirSync(path.join(root, "theirs"));
  mkdirSync(path.join(base, "elsewhere"));
  writeFileSync(path.join(root, "theirs/x.ts"), "x");
  symlinkSync(path.join(base, "elsewhere"), path.join(root, "mine/out"));
  symlinkSync(path.join(root, "theirs"), path.join(root, "mine/shortcut"));
  const job = { scope: { roots: [root], owns: ["mine/"] } };

  // As written, both look like files of the job.
  assert.equal(writeViolation(job, path.join(root, "mine/out/a.ts")), null);
  assert.equal(writeViolation(job, path.join(root, "mine/shortcut/x.ts")), null);
  // Where they really are, neither is.
  assert.match((await realWriteViolation(job, path.join(root, "mine/out/a.ts"))) ?? "", /不在这个任务的工作目录里/);
  assert.match((await realWriteViolation(job, path.join(root, "mine/shortcut/x.ts"))) ?? "", /不归这个任务负责/);
  // Ordinary files, new ones included, are unaffected.
  assert.equal(await realWriteViolation(job, path.join(root, "mine/new/deep.ts")), null);
  assert.equal(await realWriteViolation({}, "/anywhere"), null);

  // The folder itself reached through a link is still the folder.
  symlinkSync(root, path.join(base, "alias"));
  assert.equal(await realWriteViolation({ scope: { roots: [path.join(base, "alias")], owns: ["mine/"] } }, path.join(root, "mine/a.ts")), null);

  // A link that leads nowhere can't be judged, so it is refused.
  symlinkSync(path.join(base, "gone"), path.join(root, "mine/dangling"));
  assert.match((await realWriteViolation(job, path.join(root, "mine/dangling"))) ?? "", /没法确认/);
});
