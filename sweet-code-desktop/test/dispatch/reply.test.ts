// Run: node --test test/dispatch/
import { test } from "node:test";
import assert from "node:assert/strict";
import { replyText, wantsReply } from "../../src/main/dispatch/reply.ts";
import type { DispatchJob } from "../../src/shared/types.ts";

const job = (extra: Partial<DispatchJob>): DispatchJob =>
  ({ id: "ask", rootId: "ask", origin: "agent", from: "Claude-1", executor: { kind: "cli", ref: "codex", name: "Codex-1" }, input: "", limits: { timeoutMs: 1 }, status: "done", createdAt: 0, ...extra }) as DispatchJob;

test("the asker gets the last reply, cut to what send_to would carry", () => {
  assert.equal(replyText(job({ result: { text: "  看过了，没问题。\n" } }), 100), "看过了，没问题。");
  assert.equal(replyText(job({ result: { text: "" } }), 100), "（没有文字回复）");
  const long = replyText(job({ result: { text: "长".repeat(500) } }), 100);
  assert.ok(long.startsWith("长".repeat(100) + "\n…"));
  assert.ok(long.length < 130);
});

test("a job that did not finish is answered with one line saying why", () => {
  assert.equal(replyText(job({ status: "timeout" }), 100), "（Codex-1 超时了，没有回复。）");
  assert.equal(replyText(job({ status: "failed", error: "没有拿到结果", result: { text: "半截" } }), 100), "（Codex-1 没做成：没有拿到结果，没有回复。）");
});

test("nothing is sent back for a reply, or when the receiver already answered itself", () => {
  const ask = job({});
  assert.ok(wantsReply(ask, [ask], "claude"));
  assert.ok(!wantsReply(job({ reply: true }), [], "claude"), "a reply is never answered");
  const own = job({ id: "own", parentId: "ask", executor: { kind: "cli", ref: "claude", name: "Claude-1" } });
  assert.ok(!wantsReply(ask, [ask, own], "claude"), "it used send_to itself");
  const other = job({ id: "other", parentId: "ask", executor: { kind: "cli", ref: "claude-2", name: "Claude-2" } });
  assert.ok(wantsReply(ask, [ask, other], "claude"), "a message to someone else is not an answer");
});
