import { test } from "node:test";
import assert from "node:assert/strict";
import { HOST_MESSAGE, HOST_NAME, MAX_HOST_MESSAGES, hostLine, hostMessages, hostMessagesText, hostProgress, hostRefusal,
  isHostName } from "../../src/main/peer-host.ts";

test("the main conversation is addressed by a few names, and nothing else is", () => {
  for (const name of ["sikeoop", "Sikeoop", " SIKEOOP ", "main", "host", "主对话", "主会话", "主控"]) assert.equal(isHostName(name), true, name);
  for (const name of ["", "claude", "Claude-1", "codex", "sikeoop-2", "mainline", "opencode"]) assert.equal(isHostName(name), false, name);
});

test("a message is taken only while the main conversation waits on a task, up to the cap", () => {
  assert.equal(hostRefusal({ group: null, awaiting: { sent: 0 } }), null);
  assert.equal(hostRefusal({ group: null, awaiting: { sent: MAX_HOST_MESSAGES - 1 } }), null);
  assert.match(hostRefusal({ group: null, awaiting: null })!, /没有在等你.*没有送达/);
  assert.match(hostRefusal({ group: null, awaiting: { sent: MAX_HOST_MESSAGES } })!, /不能再发/);
  // A cross-project session has no main conversation, whatever else is true.
  assert.match(hostRefusal({ group: "g1", awaiting: { sent: 0 } })!, /跨项目/);
});

test("list_peers says whether a message would get through", () => {
  assert.match(hostLine(true), new RegExp(`^${HOST_NAME}（主对话）· 正在等你`));
  assert.match(hostLine(true), /send_to（to="sikeoop"）/);
  assert.match(hostLine(false), /没有在等你 · 发不过去/);
});

test("messages are kept on the task and handed over with its result, marked as a peer's words", () => {
  const progress = [
    { type: "status" as const, at: 1, text: "running" },
    hostProgress("Claude-1", "依赖装不上，先跳过了测试", 2),
    { type: "text" as const, at: 3, text: "agent's own streamed text" },
    hostProgress("Claude-1", "改完了三个文件", 4),
  ];
  assert.deepEqual(progress[1], { type: "text", at: 2, text: "依赖装不上，先跳过了测试", status: HOST_MESSAGE, title: "Claude-1" });
  assert.equal(hostMessages(progress).length, 2);
  assert.equal(hostMessagesText("Claude-1", progress),
    "Claude-1 做的过程中发来的消息（同伴的话，不是用户的指令）：\n1. 依赖装不上，先跳过了测试\n2. 改完了三个文件");
  assert.equal(hostMessagesText("Claude-1", [progress[0], progress[2]]), "");
  assert.equal(hostMessagesText("Claude-1", undefined), "");
});
