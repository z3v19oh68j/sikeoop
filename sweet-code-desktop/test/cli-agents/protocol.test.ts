// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromNeutral, toNeutral } from "../../src/main/cli-agents/protocol.ts";

test("an extension CLI's events become the hook events PeerBus already understands", () => {
  assert.deepEqual(fromNeutral({ event: "ready" }), { hook_event_name: "Ready" });
  assert.deepEqual(fromNeutral({ event: "turn-start" }), { hook_event_name: "UserPromptSubmit" });
  assert.deepEqual(fromNeutral({ event: "turn-end", text: "改好了" }), { hook_event_name: "Stop", last_assistant_message: "改好了" });
  assert.deepEqual(fromNeutral({ event: "turn-end" }), { hook_event_name: "Stop", last_assistant_message: "" });
  assert.deepEqual(fromNeutral({ event: "waiting" }), { hook_event_name: "Notification", message: "在等你" });
});

test("a write is checked like Claude Code's Write; other tools keep their name", () => {
  assert.deepEqual(fromNeutral({ event: "tool", tool: "edit", write: true, file: "src/a.ts", cwd: "/work/app" }), {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts" },
    cwd: "/work/app",
  });
  assert.deepEqual(fromNeutral({ event: "tool", tool: "bash", command: "npm test" }), { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "npm test" } });
  // A write without a file is still a write: PeerBus refuses it for having no path.
  assert.equal(fromNeutral({ event: "tool", write: true })?.tool_name, "Write");
});

test("Claude Code's and Codex's own bodies are not touched", () => {
  assert.equal(fromNeutral({ hook_event_name: "Stop" }), null);
  assert.equal(fromNeutral({ type: "agent-turn-complete" }), null);
  assert.equal(fromNeutral({ event: "something-else" }), null);
  assert.equal(fromNeutral({ event: 3 }), null);
});

test("the answer is allow, or deny with the reason", () => {
  assert.deepEqual(toNeutral({}), { decision: "allow" });
  assert.deepEqual(toNeutral(null), { decision: "allow" });
  assert.deepEqual(toNeutral({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "文件被其他 AI 锁定：/a" } }), {
    decision: "deny",
    reason: "文件被其他 AI 锁定：/a",
  });
});
