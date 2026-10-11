import assert from "node:assert/strict";
import test from "node:test";
import { MobileRpcDispatcher } from "../../sweet-code-desktop/src/main/mobile/rpc-dispatcher.ts";

const snapshot = () => ({
  sessionId: "session-current",
  eventCursor: 9,
  title: "修复接口",
  busy: false,
  turnId: 7,
  task: "修复接口",
  plan: [],
  transcript: [{ role: "user", text: "修复接口", createdAt: 123, source: { kind: "mobile", deviceName: "Pixel 9" } }],
  events: [{ cursor: 9, event: { type: "status", state: "idle" } }],
  pendingApprovals: [{ id: "approval-1", subject: { kind: "command", command: { command: "git push", explanation: "发布" } }, humanOnly: true, createdAt: 1_000 }],
  pendingQuestions: [{ id: "question-1", intro: "选一个", questions: [{ id: "q1", question: "方案？", options: [{ label: "A" }] }], createdAt: 1_001 }],
});

function makeDispatcher({ busy = false } = {}) {
  const calls = { sent: [], approvals: [], answers: [], cancels: 0, undos: [] };
  const session = {
    get busy() { return busy; },
    mobileSnapshot: snapshot,
    send: async (request) => { calls.sent.push(request); },
    cancel: () => { calls.cancels++; },
    respondApproval: (response) => { calls.approvals.push(response); },
    answerQuestion: (response) => { calls.answers.push(response); },
    undoTurn: async (turnId) => { calls.undos.push(turnId); return { restored: ["src/a.ts"], skipped: [] }; },
  };
  const dispatcher = new MobileRpcDispatcher({
    session,
    device: { id: "phone-1", name: "Pixel 9" },
    computer: { id: "desktop-1", name: "MacBook" },
    view: () => ({ status: "waiting", presence: { online: true }, computer: { id: "desktop-1", name: "MacBook" }, pendingApprovals: 1 }),
  });
  return { dispatcher, calls };
}

test("authenticated RPC calls stay on the allowlist and force lazy phone origin", async () => {
  const { dispatcher, calls } = makeDispatcher();
  const bad = await dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "filesystem.read", params: { path: "/etc/passwd" } });
  assert.equal(bad.error.code, -32601);
  assert.equal(calls.sent.length, 0);

  const response = await dispatcher.dispatch({ jsonrpc: "2.0", id: 2, method: "chat.send", params: { requestId: "req-1", text: "改接口", mode: "lazy" } });
  assert.deepEqual(response.result, { accepted: true, requestId: "req-1", turnId: 8 });
  assert.equal(calls.sent[0].lazy, true);
  assert.deepEqual(calls.sent[0].origin, { kind: "mobile", deviceId: "phone-1", deviceName: "Pixel 9" });
  assert.equal(calls.sent[0].editor.activeFile, undefined);
});

test("busy requests are rejected without dispatch and task mode cannot be changed", async () => {
  const { dispatcher: busy, calls: busyCalls } = makeDispatcher({ busy: true });
  const response = await busy.dispatch({ jsonrpc: "2.0", id: "1", method: "chat.send", params: { requestId: "req", text: "task", mode: "lazy" } });
  assert.equal(response.error.code, -32001);
  assert.equal(busyCalls.sent.length, 0);

  const { dispatcher, calls } = makeDispatcher();
  const invalid = await dispatcher.dispatch({ jsonrpc: "2.0", id: "2", method: "chat.send", params: { requestId: "req", text: "task", mode: "agent" } });
  assert.equal(invalid.error.code, -32602);
  assert.equal(calls.sent.length, 0);
});

test("oversized chat images are rejected before the relay frame is built", async () => {
  const { dispatcher, calls } = makeDispatcher();
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0", id: 3, method: "chat.send",
    params: { requestId: "req", text: "看图", mode: "lazy", images: [{ mime: "image/png", data: "A".repeat(600_001) }] },
  });
  assert.equal(response.error.code, -32602);
  assert.equal(calls.sent.length, 0);
});

test("snapshot maps conversation, event cursor, pending approvals and questions", async () => {
  const { dispatcher } = makeDispatcher();
  const response = await dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "session.snapshot", params: {} });
  assert.equal(response.result.cursor, 9);
  assert.equal(response.result.messages[0].source.deviceName, "Pixel 9");
  assert.equal(response.result.approvals[0].humanOnly, true);
  assert.equal(response.result.approvals[0].deadlineAt, 601_000);
  assert.equal(response.result.questions[0].id, "question-1");
  assert.deepEqual(response.result.events, snapshot().events);
});

test("responses operate on only one pending approval or question", async () => {
  const { dispatcher, calls } = makeDispatcher();
  const approval = await dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "approval.respond", params: { id: "approval-1", approved: true, decision: "approve_all" } });
  assert.deepEqual(approval.result, { accepted: true, id: "approval-1", status: "approved" });
  assert.deepEqual(calls.approvals, [{ id: "approval-1", decision: "approve" }]);

  const answer = await dispatcher.dispatch({ jsonrpc: "2.0", id: 2, method: "question.answer", params: { id: "question-1", answers: [{ id: "q1", choices: ["A"] }], usedDefaults: false } });
  assert.equal(answer.result.accepted, true);
  assert.deepEqual(calls.answers[0].answers, [{ id: "q1", choices: ["A"] }]);
});
