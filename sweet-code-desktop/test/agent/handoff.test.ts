// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffRecord } from "../../src/main/agent/handoff.ts";
import type { HistoryEntry } from "../../src/main/providers/types.ts";

const big = (c: string) => c.repeat(2000);

function history(): HistoryEntry[] {
  return [
    { role: "user", text: "把 a.ts 和 b.ts 里的 foo 改名为 bar" },
    { role: "assistant", text: "先读两个文件。", calls: [{ name: "read_file", input: { path: "a.ts" } }, { name: "read_file", input: { path: "b.ts" } }] },
    { role: "tool", tool: "read_file", text: big("A") },
    { role: "tool", tool: "read_file", text: big("B") },
    { role: "assistant", text: "改 a.ts。", calls: [{ name: "edit_file", input: { path: "a.ts", old_string: "foo", new_string: "bar" } }] },
    { role: "tool", tool: "edit_file", text: "Edited a.ts." },
  ];
}

test("everything fits: file contents are passed on whole, nothing needs a reread", () => {
  const r = handoffRecord(history(), 100_000);
  assert.equal(r.omitted, 0);
  assert.equal(r.kept, 2);
  assert.equal(r.dropped.size, 0);
  assert.ok(r.text.includes(big("A")) && r.text.includes(big("B")));
  assert.ok(r.text.includes('→ 调用 edit_file({"path":"a.ts"'));
});

test("too big: the oldest file content goes first, and only that file must be read again", () => {
  const r = handoffRecord(history(), 3000);
  assert.equal(r.omitted, 1);
  assert.deepEqual([...r.dropped], ["a.ts"]);
  assert.ok(!r.text.includes(big("A")) && r.text.includes(big("B")));
  assert.ok(r.text.includes("被省略了"));
});

test("a file read again later stays read when only its older read was left out", () => {
  const h = history();
  h.push({ role: "assistant", text: "再看一下 a.ts。", calls: [{ name: "read_file", input: { path: "a.ts" } }] }, { role: "tool", tool: "read_file", text: "short a" });
  const r = handoffRecord(h, 3000);
  assert.ok(!r.dropped.has("a.ts"));
});

test("far too big: keeps the first request and the newest work, and every read counts as dropped", () => {
  const r = handoffRecord(history(), 60);
  assert.ok(r.text.startsWith("[用户]"));
  assert.match(r.text, /中间省略了/);
  assert.deepEqual([...r.dropped].sort(), ["a.ts", "b.ts"]);
});
