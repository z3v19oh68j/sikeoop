import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "../../src/main/providers/anthropic.ts";
import { claudeEffortParams, supportsClaudeEffort, supportsMessageEffort } from "../../src/main/providers/effort.ts";
import { selectEffort, effortOverrides, effortPurpose } from "../../src/main/agent/route.ts";

const base = { hasFiles: false, hasImages: false, planOpen: false, autopilot: false };

test("purpose effort defaults and difficulty routing share one selection policy", () => {
  assert.equal(selectEffort("chat"), "low");
  assert.equal(selectEffort("subtask", undefined, "heavy"), "low");
  assert.equal(selectEffort("compress"), "low");
  assert.equal(selectEffort("coding"), "medium");
  assert.equal(selectEffort("coding", undefined, "heavy"), "high");
  assert.equal(selectEffort("coding", { hard: "medium" }, "heavy"), "medium");
  assert.equal(selectEffort("chat", { chat: "high" }), "high");
  assert.equal(selectEffort("coding", { coding: "low" }, null, "high"), "high");
  assert.equal(effortPurpose({ ...base, text: "hi" }), "chat");
  assert.equal(effortPurpose({ ...base, text: "修复接口 bug" }), "coding");
});

test("routing overrides validate values without requiring new renderer API methods", () => {
  assert.deepEqual(effortOverrides({ compress: "low", coding: "high" }), { coding: "high", compress: "low" });
  assert.equal(effortOverrides(undefined), undefined);
  assert.deepEqual(effortOverrides({}), {});
  for (const bad of [null, [], "high", { chat: "max" }, { coding: false }]) {
    assert.throws(() => effortOverrides(bad), /effort/);
  }
});

test("effort capability gate is Claude-only, conservative, and excludes compatible vendors", () => {
  for (const model of ["claude-opus-4-5-20251101", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5-5", "claude-sonnet-5-5"]) {
    assert.equal(supportsClaudeEffort(model), true, model);
    assert.deepEqual(claudeEffortParams("anthropic", model, false, "low"), { output_config: { effort: "low" } });
  }
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-7-sonnet", "claude-opus-5-fake", "mimo-v2.6-pro", "gpt-6.1"]) {
    assert.equal(supportsClaudeEffort(model), false, model);
    assert.deepEqual(claudeEffortParams("anthropic", model, false, "high"), {});
  }
  assert.deepEqual(claudeEffortParams("openai", "claude-opus-5-5", false, "high"), {});
  assert.deepEqual(claudeEffortParams("anthropic", "claude-opus-5-5", true, "high"), {});
  assert.equal(supportsMessageEffort("claude-opus-4-6"), false);
  assert.equal(supportsMessageEffort("claude-opus-5-5"), true);
});

function fixture(model: string, compat = false) {
  const requests: Record<string, unknown>[] = [];
  const stream = (request: Record<string, unknown>) => {
    // Clone here: later additions to history must not alter the recorded earlier request.
    requests.push(structuredClone(request));
    return {
      on() { return this; },
      async finalMessage() {
        return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  };
  const client = { beta: { messages: { stream } }, messages: { stream } } as unknown as Anthropic;
  const adapter = new AnthropicAdapter({ client, model, login: false, ...(compat ? { compat: { providerName: "MiMo" } } : {}) }, "Static system", []);
  const step = () => adapter.step({ effort: "medium", signal: new AbortController().signal }, { onText() {}, onThinking() {} });
  return { adapter, step, requests };
}

test("modern Claude pins top effort and appends only cache-safe message-level changes", async () => {
  const f = fixture("claude-opus-5-5");
  f.adapter.setEffort("low", "low");
  f.adapter.addUserText(["hello"], "low");
  await f.step();
  f.adapter.setEffort("high", "low");
  f.adapter.addUserText(["hard task"], "high");
  await f.step();
  assert.deepEqual(f.requests.map(r => r.output_config), [{ effort: "low" }, { effort: "low" }]);
  const messages = f.requests[1].messages as { role: string; output_config?: unknown }[];
  assert.deepEqual(messages.filter(m => m.role === "system").map(m => m.output_config), [{ effort: "high" }]);
  assert.deepEqual(f.requests[0].system, f.requests[1].system);
});

test("older effort-capable Claude never changes its top value mid-session", async () => {
  const f = fixture("claude-opus-4-6");
  f.adapter.addUserText(["code"], "medium");
  await f.step();
  f.adapter.addUserText(["hard"], "high");
  await f.step();
  assert.deepEqual(f.requests.map(r => r.output_config), [{ effort: "medium" }, { effort: "medium" }]);
  assert.equal((f.requests[1].messages as { role: string }[]).some(m => m.role === "system"), false);
});

test("top effort survives compaction, restoration and failover before a user message", async () => {
  const first = fixture("claude-opus-5-5");
  first.adapter.addUserText(["hello"], "low");
  await first.step();
  first.adapter.addUserText(["hard task"], "high");
  await first.step();
  const saved = structuredClone(first.adapter.exportState());
  const restored = fixture("claude-opus-5-5");
  restored.adapter.importState(saved);
  restored.adapter.restart(["summary"], true);
  restored.adapter.setEffort("high", "low");
  await restored.step();
  const backup = fixture("claude-sonnet-5-5");
  backup.adapter.restart(["handoff record"], true);
  backup.adapter.setEffort("high", "low");
  await backup.step();
  assert.deepEqual(restored.requests[0].output_config, { effort: "low" });
  assert.deepEqual(backup.requests[0].output_config, { effort: "low" });
  for (const request of [restored.requests[0], backup.requests[0]]) {
    assert.deepEqual((request.messages as { role: string; output_config?: unknown }[]).filter(m => m.role === "system").map(m => m.output_config), [{ effort: "high" }]);
  }
});

test("rollback undoes appended effort changes without disturbing the cached top", async () => {
  const f = fixture("claude-opus-5-5");
  f.adapter.addUserText(["hello"], "low");
  await f.step();
  const point = f.adapter.checkpoint();
  f.adapter.addUserText(["hard"], "high");
  f.adapter.rollback(point);
  f.adapter.addUserText(["chat"], "low");
  await f.step();
  assert.deepEqual(f.requests[1].output_config, { effort: "low" });
  assert.equal((f.requests[1].messages as { role: string }[]).some(m => m.role === "system"), false);
});

test("between-turn handoff keeps summary text and reinstates message effort after restart", async () => {
  const f = fixture("claude-opus-5-5");
  f.adapter.addUserText(["hello"], "low");
  f.adapter.addUserText(["hard task"], "high");
  f.adapter.restart(["handoff summary"], false);
  f.adapter.addUserText(["continue"], "high");
  await f.step();
  const history = f.adapter.history();
  assert.equal(history[0].text, "handoff summary\ncontinue");
  assert.deepEqual(f.requests[0].output_config, { effort: "low" });
  const messages = f.requests[0].messages as { role: string; output_config?: unknown }[];
  assert.deepEqual(messages.filter(m => m.role === "system").map(m => m.output_config), [{ effort: "high" }]);
});

test("unsupported Claude and compatible requests omit output_config and effort beta", async () => {
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "unknown-model"]) {
    const f = fixture(model);
    f.adapter.addUserText(["hello"], "low");
    f.adapter.addUserText(["code"], "high");
    await f.step();
    assert.equal("output_config" in f.requests[0], false);
    assert.equal((f.requests[0].betas as string[]).includes("mid-conversation-output-config-2026-07-01"), false);
  }
  const compat = fixture("claude-opus-5-5", true);
  compat.adapter.addUserText(["hello"], "low");
  await compat.step();
  assert.equal("output_config" in compat.requests[0], false);
  assert.equal("betas" in compat.requests[0], false);
  assert.deepEqual(compat.requests[0].thinking, { type: "disabled" });
});
