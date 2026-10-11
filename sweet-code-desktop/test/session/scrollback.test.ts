// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCROLLBACK_LIMIT, Scrollback } from "../../src/main/session/scrollback.ts";

test("output under the limit is kept whole and replayed after a reset", () => {
  const b = new Scrollback();
  assert.equal(b.text(), "");
  assert.equal(b.replay(), "\x1bc", "an empty terminal still clears the viewer");
  b.push("信任这个目录吗？\r\n");
  b.push("");
  b.push("❯ 1. Yes");
  assert.equal(b.text(), "信任这个目录吗？\r\n❯ 1. Yes");
  assert.equal(b.replay(), "\x1bc信任这个目录吗？\r\n❯ 1. Yes");
  b.push("\r\n");
  assert.equal(b.text(), "信任这个目录吗？\r\n❯ 1. Yes\r\n", "reading it doesn't stop it growing");
});

test("past the limit the oldest output goes, and the replay starts on a whole line", () => {
  const b = new Scrollback(20);
  b.push("line-1\nline-2\n");
  b.push("line-3\nline-4\n");
  // 28 characters in, 20 kept: "\nline-2\nline-3\nline-4\n" minus the cut line.
  assert.equal(b.text(), "line-3\nline-4\n");
  b.push("x".repeat(50));
  assert.equal(b.text(), "x".repeat(20), "one chunk bigger than the limit keeps its tail; no line break to start from");
  b.push("\nok\n");
  assert.equal(b.text(), "ok\n");
});

test("never holds more than the limit, however it arrives", () => {
  const b = new Scrollback();
  for (let i = 0; i < 3000; i++) b.push(`${String(i).padStart(6, "0")} ${"·".repeat(120)}\n`);
  const text = b.text();
  assert.ok(text.length <= SCROLLBACK_LIMIT);
  assert.ok(text.length > SCROLLBACK_LIMIT - 200, "and not much less");
  assert.match(text, /^\d{6} /, "starts at the beginning of a line");
  assert.ok(text.endsWith(`002999 ${"·".repeat(120)}\n`), "the newest output is there");
});
