// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry } from "../../src/main/cli-agents/registry.ts";

const def = (extra: object) => JSON.stringify({ id: "mycli", name: "My CLI", label: "MyCli", bin: ["mycli"], turnEnd: "quiet", ...extra });

test("bundled definitions are there without any folder", async () => {
  const r = await loadRegistry(path.join(os.tmpdir(), "sikeoop-no-such-folder"));
  assert.deepEqual(r.defs.map((d) => [d.def.id, d.source]), [["opencode", "内置"], ["codebuddy", "内置"]]);
  assert.deepEqual(r.problems, []);
});

test("the user's files are added; a bad one is skipped with its reasons and doesn't stop the rest", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sikeoop-cli-"));
  writeFileSync(path.join(dir, "a-mycli.json"), def({}));
  writeFileSync(path.join(dir, "b-broken.json"), "{ not json");
  writeFileSync(path.join(dir, "c-invalid.json"), JSON.stringify({ id: "x" }));
  writeFileSync(path.join(dir, "d-dup.json"), def({ name: "Again" }));
  writeFileSync(path.join(dir, "e-samelabel.json"), def({ id: "other", label: "mycli" }));
  writeFileSync(path.join(dir, "README.md"), "not a definition");
  const r = await loadRegistry(dir);
  assert.deepEqual(r.defs.map((d) => d.def.id), ["opencode", "codebuddy", "mycli"]);
  assert.equal(r.defs[2].source, path.join(dir, "a-mycli.json"));
  assert.deepEqual(r.problems.map((p) => p.file), ["b-broken.json", "c-invalid.json", "d-dup.json", "e-samelabel.json"]);
  assert.match(r.problems[0].problems[0], /不是合法的 JSON/);
  assert.match(r.problems[2].problems[0], /已经被另一个文件用了/);
  assert.match(r.problems[3].problems[0], /会话会重名/);
  rmSync(dir, { recursive: true, force: true });
});

test("a user's file with a bundled id replaces the bundled definition", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sikeoop-cli-"));
  writeFileSync(path.join(dir, "opencode.json"), def({ id: "opencode", label: "OpenCode", name: "我的 opencode" }));
  const r = await loadRegistry(dir);
  assert.deepEqual(r.defs.map((d) => d.def.name), ["我的 opencode", "CodeBuddy"]);
  assert.equal(r.problems.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
