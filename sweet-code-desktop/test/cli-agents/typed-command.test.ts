// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLine, startsCli, typeInto } from "../../src/renderer/src/components/typedCommand.ts";

const kinds = [
  { id: "claude", bins: ["claude"] },
  { id: "codex", bins: ["codex"] },
  { id: "opencode", bins: ["opencode"] },
  { id: "cursor", bins: ["agent", "cursor-agent"] },
  { id: "nobins" },
];
const entered = (...chunks: string[]) => {
  let line = emptyLine();
  const out: string[] = [];
  for (const c of chunks) {
    const r = typeInto(line, c);
    line = r.line;
    out.push(...r.entered);
  }
  return out;
};

test("keys become a line on Enter; backspace, Ctrl-C and Ctrl-U are followed", () => {
  assert.deepEqual(entered("o", "p", "e", "n", "c", "o", "d", "e", "\r"), ["opencode"]);
  assert.deepEqual(entered("opem", "\x7f", "ncode\r"), ["opencode"]);
  assert.deepEqual(entered("rm -rf x", "\x03", "claude\r"), ["claude"]);
  assert.deepEqual(entered("ls", "\x15", "codex\r"), ["codex"]);
  assert.deepEqual(entered("\r", "  \r"), [], "empty lines are nothing");
  assert.deepEqual(entered("ls\rclaude\r"), ["ls", "claude"], "several lines in one chunk");
});

test("a paste counts as typed; a line the shell edited itself is not guessed at", () => {
  assert.deepEqual(entered("\x1b[200~opencode .\x1b[201~", "\r"), ["opencode ."]);
  assert.deepEqual(entered("\x1b[A", "\r"), [], "history: we don't know what ran");
  assert.deepEqual(entered("open", "\t", "\r"), [], "completion: we don't know what it became");
  assert.deepEqual(entered("claud", "\x1b[D", "x", "\r"), [], "the cursor moved");
  assert.deepEqual(entered("\x1b[A", "\r", "codex\r"), ["codex"], "the next line starts clean");
});

test("starting a session is recognised by executable name", () => {
  const id = (cmd: string) => startsCli(cmd, kinds)?.id ?? null;
  assert.equal(id("opencode"), "opencode");
  assert.equal(id("opencode ."), "opencode");
  assert.equal(id("/opt/homebrew/bin/opencode"), "opencode");
  assert.equal(id("claude \"修一下登录\""), "claude");
  assert.equal(id("codex --model gpt-5"), "codex");
  assert.equal(id("FOO=1 BAR=2 claude"), "claude");
  assert.equal(id("cursor-agent"), "cursor");
  assert.equal(id("agent --workspace ./app"), "cursor");
});

test("commands that aren't a session are let be", () => {
  const id = (cmd: string) => startsCli(cmd, kinds)?.id ?? null;
  for (const cmd of [
    "claude --version", "opencode -v", "codex --help", "claude -p hi", "opencode auth login", "opencode run hi", "codex exec fix", "claude mcp list",
    "which opencode", "npm install -g opencode-ai", "echo claude", "claude | tee log", "cd app && claude", "opencodex", "ls", "FOO=1",
  ]) {
    assert.equal(id(cmd), null, cmd);
  }
});
