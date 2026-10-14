import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter, filterThinkingBlocks, filterWebSearchHistoryBlocks, prefilterAnthropicParams,
  resolveThinkingProtocol, sanitizeAnthropicBodyForBetaTokens, stripEmptyTextBlocks } from "../../src/main/providers/anthropic.ts";
import { FullClaudeCodeMimicryBetas } from "../../src/main/providers/claude-mimic.ts";

test("missing final betas strip only protected fields without mutating SDK params", () => {
  const params = {
    model: "claude-opus-5-5", context_management: { edits: [] },
    thinking: { type: "adaptive", display: "summarized", block_binding: { enabled: true } },
    output_config: { effort: "high", format: { type: "json_schema" } }, effort: "high",
    fallbacks: "default", fallback_credit_token: "test-credit",
    messages: [
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "system", content: [{ type: "text", text: "" }], output_config: { effort: "low" } },
      { role: "system", content: "real instructions", output_config: { effort: "low" }, extra: 1 },
      { role: "user", content: "", output_config: { effort: "low" } },
      { role: "assistant", content: [{ type: "text", text: "done" }], output_config: { effort: "low" } },
      { role: "system", content: [], tag: "not an output control" },
    ], tools: [{ name: "test" }], cache_control: { type: "ephemeral" },
  };
  const before = structuredClone(params);
  const clean = sanitizeAnthropicBodyForBetaTokens(params, []);
  assert.ok(!Object.hasOwn(clean, "context_management"));
  assert.ok(!Object.hasOwn(clean, "fallbacks"));
  assert.ok(!Object.hasOwn(clean, "fallback_credit_token"));
  assert.deepEqual(clean.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(clean.output_config, params.output_config);
  assert.equal(clean.effort, "high");
  assert.deepEqual(clean.messages, [
    { role: "system", content: "real instructions", extra: 1 },
    { role: "user", content: "" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "system", content: [], tag: "not an output control" },
  ]);
  assert.deepEqual(clean.tools, params.tools);
  assert.deepEqual(clean.cache_control, params.cache_control);
  assert.deepEqual(params, before);
});

test("exact beta tokens retain fields; credit accepts either current or legacy beta", () => {
  const params = { context_management: { edits: [] }, thinking: { type: "adaptive", block_binding: "test" },
    fallbacks: "default", fallback_credit_token: "test-credit", messages: [{ role: "system", content: [], output_config: { effort: "high" } }] };
  const betas = [" context-management-2025-06-27,thinking-binding-controls-2026-08-01 ",
    "server-side-fallback-2026-07-01", "mid-conversation-output-config-2026-07-01"];
  assert.deepEqual(sanitizeAnthropicBodyForBetaTokens(params, betas), params);
  assert.ok(!Object.hasOwn(sanitizeAnthropicBodyForBetaTokens(params, ["context-management-2025-06-27-extra"]), "context_management"));
  for (const beta of ["fallback-credit-2026-07-01", "fallback-credit-2026-06-01"]) {
    const clean = sanitizeAnthropicBodyForBetaTokens(params, [beta]);
    assert.equal(clean.fallback_credit_token, "test-credit");
    assert.ok(!Object.hasOwn(clean, "fallbacks"));
  }
});

test("empty system output controls are removed conservatively and only when their beta is missing", () => {
  const empty = [undefined, null, "", [], [{ type: "text", text: "" }], [{ type: "text" }]];
  const nonempty = [" ", [{ type: "image" }], [{ type: "future" }], {}, 0, false];
  const params = { messages: [...empty, ...nonempty].map(content => ({ role: "system", content, output_config: {} })) };
  assert.deepEqual(sanitizeAnthropicBodyForBetaTokens(params, []).messages, nonempty.map(content => ({ role: "system", content })));
  assert.deepEqual(sanitizeAnthropicBodyForBetaTokens(params, ["mid-conversation-output-config-2026-07-01"]), params);
});

function fixture(login = false, compat = false, model = "claude-opus-5-5") {
  const requests: Record<string, unknown>[] = [];
  const stream = (params: object) => {
    requests.push(structuredClone(params) as Record<string, unknown>);
    return { on() { return this; }, async finalMessage() {
      return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } };
    } };
  };
  const client = { beta: { messages: { stream } }, messages: { stream } } as unknown as Anthropic;
  const adapter = new AnthropicAdapter({ client, model, login, ...(compat ? { compat: { providerName: "test" } } : {}) }, "system", []);
  const step = () => adapter.step({ effort: "medium", signal: new AbortController().signal }, { onText() {}, onThinking() {} });
  return { adapter, requests, step };
}

test("login adapter uses the actual 13 wire betas and removes unsupported fallback/message effort", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  const f = fixture(true);
  f.adapter.addUserText(["hi"], "low");
  f.adapter.addUserText(["hard"], "high");
  const before = structuredClone(f.adapter.exportState());
  await f.step();
  const params = f.requests[0];
  assert.deepEqual(params.betas, FullClaudeCodeMimicryBetas());
  assert.ok(!Object.hasOwn(params, "fallbacks"));
  assert.deepEqual(params.output_config, { effort: "low" });
  assert.deepEqual(params.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(params.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  assert.ok(!Object.hasOwn(params, "cache_control"));
  assert.equal(params.max_tokens, 128000);
  assert.equal((params.messages as { role: string }[]).some(message => message.role === "system"), false);
  assert.deepEqual(f.adapter.exportState().messages.slice(0, before.messages.length), before.messages);
});

test("Key and direct adapter keep supported betas and effort controls; OAuth 5.5 omits fallbacks", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  for (const login of [false, true]) {
    process.env.SIKEOOP_ANTHROPIC_DIRECT = "1";
    const f = fixture(login);
    // Changing the env after construction must not change the client's captured mode.
    delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
    f.adapter.addUserText(["hi"], "low");
    f.adapter.addUserText(["hard"], "high");
    await f.step();
    const params = f.requests[0];
    assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01", "context-management-2025-06-27", "mid-conversation-output-config-2026-07-01"]);
    if (login) assert.ok(!Object.hasOwn(params, "fallbacks"));
    else assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.output_config, { effort: "low" });
    assert.deepEqual((params.messages as { role: string; output_config?: unknown }[]).find(message => message.role === "system")?.output_config, { effort: "high" });
  }
});

const toolUseContextManagement = { edits: [{
  type: "clear_tool_uses_20250919",
  trigger: { type: "input_tokens", value: 120_000 },
  keep: { type: "tool_uses", value: 5 },
  clear_at_least: { type: "input_tokens", value: 20_000 },
}] };

test("OAuth Opus/Sonnet 5.5 match captured wire in mimic and direct modes, without changing model/system cache", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  for (const direct of [false, true]) {
    if (direct) process.env.SIKEOOP_ANTHROPIC_DIRECT = "1"; else delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5.5", "CLAUDE-SONNET-5-5-20261001", "claude-opus-5-5-thinking"]) {
      const f = fixture(true, false, model);
      f.adapter.addUserText(["hi"], "low");
      await f.step();
      const params = f.requests[0];
      assert.equal(params.model, model);
      assert.deepEqual(params.thinking, { type: "adaptive", display: "omitted" });
      assert.deepEqual(params.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
      assert.equal(params.max_tokens, 128000);
      assert.ok(!Object.hasOwn(params, "fallbacks"));
      assert.ok(!Object.hasOwn(params, "cache_control"));
      assert.deepEqual(params.system, [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }]);
    }
  }
});

test("API-key 5.5 and OAuth older/Haiku models retain previous request controls", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  for (const direct of [false, true]) {
    if (direct) process.env.SIKEOOP_ANTHROPIC_DIRECT = "1"; else delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
    for (const [login, models] of [
      [false, ["claude-opus-5-5", "claude-sonnet-5-5"]],
      [true, ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-haiku-5-5"]],
    ] as const) {
      for (const model of models) {
        const f = fixture(login, false, model);
        f.adapter.addUserText(["hi"], "low");
        await f.step();
        const params = f.requests[0];
        assert.equal(params.max_tokens, 64000);
        assert.deepEqual(params.cache_control, { type: "ephemeral" });
        if (model === "claude-haiku-4-5") {
          assert.ok(!Object.hasOwn(params, "thinking"));
          assert.ok(!Object.hasOwn(params, "context_management"));
        } else {
          assert.deepEqual(params.thinking, { type: "adaptive", display: "summarized" });
          assert.deepEqual(params.context_management, toolUseContextManagement);
        }
        if (!login || direct) assert.equal(params.fallbacks, "default");
        else assert.ok(!Object.hasOwn(params, "fallbacks")); // Existing final-beta sanitizer behavior.
      }
    }
  }
});

test("compatible 5.5 requests do not acquire OAuth controls", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  for (const login of [false, true]) {
    const f = fixture(login, true, "claude-opus-5-5");
    f.adapter.addUserText(["hi"], "medium");
    await f.step();
    const params = f.requests[0];
    assert.equal(params.max_tokens, 65536);
    assert.deepEqual(params.thinking, { type: "enabled" });
    for (const field of ["context_management", "fallbacks", "cache_control", "betas"]) assert.ok(!Object.hasOwn(params, field));
  }
});

test("empty text is stripped recursively only from messages and nested tool_result content", () => {
  const params = { system: [{ type: "text", text: "" }], messages: [{ role: "user", content: [
    { type: "text", text: "" }, { type: "text" }, { type: "text", text: 0 }, { type: "text", text: " " },
    { type: "image", source: { type: "base64", data: "test" } },
    { type: "tool_use", id: "tool", input: { type: "text", text: "" } },
    { type: "tool_result", tool_use_id: "tool", content: [
      { type: "text", text: "" }, { type: "text", text: "result" },
      { type: "tool_result", content: [{ type: "text", text: "" }] },
    ] },
  ] }, { role: "assistant", content: "" }, { role: "user", content: [{ type: "text", text: "" }] }] };
  const before = structuredClone(params);
  const clean = stripEmptyTextBlocks(params);
  assert.deepEqual(clean.messages[0].content, [
    { type: "text", text: " " }, { type: "image", source: { type: "base64", data: "test" } },
    { type: "tool_use", id: "tool", input: { type: "text", text: "" } },
    { type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "result" }, { type: "tool_result", content: [] }] },
  ]);
  assert.equal(clean.messages[1].content, "");
  assert.deepEqual(clean.messages[2].content, []);
  assert.deepEqual(clean.system, params.system);
  assert.deepEqual(params, before);
  assert.equal(stripEmptyTextBlocks(clean), clean);
});

test("thinking protocol classification matches upstream and preserves unknown/passback contracts", () => {
  for (const model of ["claude-opus-5-5", "opus-5", "sonnet-4-6", "haiku-5-5", "CLAUDE-SONNET-4-6"])
    assert.equal(resolveThinkingProtocol(model), "strict", model);
  for (const model of ["deepseek-v4-pro", "kimi-k3", "moonshot-v1", "glm-5", "MiniMax-M2.7", "k3", "k3-256k",
    "qwen-3-thinking", "qwen2-72b-thinking", "qwen3-next-thinking-2507", "qwen4-test-thinking"])
    assert.equal(resolveThinkingProtocol(model), "passback", model);
  for (const model of ["", "mimo-v2.6-pro", "minimax-other", "k3-fake", "foo-k3", "qwen3-next", "qwen5-test-thinking", " models/claude-opus-5-5"])
    assert.equal(resolveThinkingProtocol(model), "unknown", model);
  const params = { thinking: { type: "disabled" }, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "must replay" }] }] };
  for (const model of ["deepseek-v4-pro", "glm-5", "mimo-v2.6-pro", "unknown"])
    assert.equal(filterThinkingBlocks(params, model), params);
});

test("strict adaptive thinking retains valid signatures and strips missing/dummy/malformed blocks", () => {
  const signed = { type: "thinking", thinking: "signed", signature: "s" };
  const redacted = { type: "redacted_thinking", data: "cipher", signature: "valid" };
  const params = { thinking: { type: "adaptive" }, messages: [
    { role: "assistant", content: [signed, redacted, { type: "thinking", thinking: "unsigned" },
      { type: "thinking", thinking: "dummy", signature: "skip_thought_signature_validator" },
      { type: "thinking", signature: "" }, { type: "thinking", signature: 7 },
      { thinking: "no discriminator", signature: "valid" }, { type: 0, thinking: "bad discriminator" },
      { type: "redacted_thinking", data: "unsigned cipher" }, { type: "text", text: "visible" }, { type: "tool_use", id: "tool" }] },
    { role: "user", content: [signed, { type: "text", text: "question" }] },
  ] };
  const before = structuredClone(params);
  const clean = filterThinkingBlocks(params, "claude-opus-4-6");
  assert.deepEqual(clean.messages[0].content, [signed, redacted, { type: "text", text: "visible" }, { type: "tool_use", id: "tool" }]);
  assert.deepEqual(clean.messages[1].content, [{ type: "text", text: "question" }]);
  assert.deepEqual(clean.thinking, params.thinking);
  assert.deepEqual(params, before);
  assert.equal(filterThinkingBlocks(clean, "claude-opus-4-6"), clean);
});

test("older models without enabled/adaptive thinking drop all thinking, without changing top-level mode", () => {
  for (const thinking of [undefined, { type: "disabled" }, { type: "between_tools" }]) {
    const params = { thinking, messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "signed", signature: "valid" }, { type: "redacted_thinking", signature: "valid" },
    ] }] };
    const clean = filterThinkingBlocks(params, "claude-sonnet-4-6");
    assert.deepEqual(clean.messages[0].content, []);
    assert.deepEqual(clean.thinking, thinking);
  }
});

test("5.5 preserves complete signed/redacted history even without top-level enabled thinking", () => {
  const params = { thinking: { type: "disabled" }, messages: [{ role: "assistant", content: [
    { type: "thinking", thinking: "signed", signature: "valid" },
    { type: "redacted_thinking", data: "cipher" },
    { type: "text", text: "answer" },
  ] }] };
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5.5", "CLAUDE-SONNET-5-5-20261001", "claude-opus-5-5-thinking"])
    assert.equal(filterThinkingBlocks(params, model), params, model);
});

test("one invalid 5.5 block drops all thinking across history and fills emptied turns", () => {
  const params = { thinking: { type: "adaptive" }, messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "signed", signature: "valid" }, { type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "text", text: "question" }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "cipher" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] },
    { role: "user", content: [] },
  ] };
  const before = structuredClone(params);
  const clean = filterThinkingBlocks(params, "claude-sonnet-5-5");
  assert.deepEqual(clean.messages.map(message => message.content), [
    [{ type: "text", text: "answer" }], [{ type: "text", text: "question" }],
    [{ type: "text", text: "(assistant content removed)" }], [{ type: "text", text: "(assistant content removed)" }],
    [{ type: "text", text: "(content removed)" }],
  ]);
  assert.deepEqual(clean.thinking, params.thinking);
  assert.deepEqual(params, before);
});

test("websearch strips only emulated srvtoolu_ws_ pairs for strict/unknown models", () => {
  const genuineUse = { type: "server_tool_use", id: "srvtoolu_real", name: "web_search" };
  const genuineResult = { type: "web_search_tool_result", tool_use_id: "srvtoolu_real", content: [] };
  const params = { messages: [{ role: "assistant", content: [
    { type: "server_tool_use", id: "srvtoolu_ws_123", name: "web_search" },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_123", content: [] },
    genuineUse, genuineResult, { type: "text", text: "search summary" },
    { type: "tool_use", id: "srvtoolu_ws_client", name: "test" }, { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_ws_fetch" },
  ] }] };
  const before = structuredClone(params);
  for (const model of ["claude-sonnet-4-6", "mimo-v2.6-pro", "unknown"]) {
    const clean = filterWebSearchHistoryBlocks(params, model);
    assert.deepEqual(clean.messages[0].content, params.messages[0].content.slice(2));
    assert.equal(filterWebSearchHistoryBlocks(clean, model), clean);
  }
  assert.deepEqual(params, before);
});

test("passback websearch removes genuine server/search blocks too and preserves role placeholders", () => {
  const content = [{ type: "server_tool_use", id: "srvtoolu_real", name: "web_search" },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_real" }];
  const params = { messages: [{ role: "assistant", content }, { role: "user", content }] };
  assert.deepEqual(filterWebSearchHistoryBlocks(params, "deepseek-v4-pro").messages, [
    { role: "assistant", content: [{ type: "text", text: "(assistant content removed)" }] },
    { role: "user", content: [{ type: "text", text: "(content removed)" }] },
  ]);
});

test("pre-filter order removes empty text before websearch placeholders and preserves nested tool input", () => {
  const params = { messages: [{ role: "assistant", content: [{ type: "text", text: "" },
    { type: "server_tool_use", id: "srvtoolu_ws_123" }] }] };
  assert.deepEqual(prefilterAnthropicParams(params, "claude-opus-4-6").messages[0].content,
    [{ type: "text", text: "(assistant content removed)" }]);
  for (const params of [{}, { messages: "not an array" }, { messages: [null, 0, { role: "user", content: "plain" }] }])
    assert.equal(prefilterAnthropicParams(params, "claude-opus-5-5"), params);
});

test("login/Key/direct/compat all pre-filter SDK params without rewriting persistent history", async t => {
  const previous = process.env.SIKEOOP_ANTHROPIC_DIRECT;
  t.after(() => { if (previous === undefined) delete process.env.SIKEOOP_ANTHROPIC_DIRECT; else process.env.SIKEOOP_ANTHROPIC_DIRECT = previous; });
  for (const mode of ["login", "key", "direct", "compat-passback", "compat-unknown"]) {
    if (mode === "direct") process.env.SIKEOOP_ANTHROPIC_DIRECT = "1"; else delete process.env.SIKEOOP_ANTHROPIC_DIRECT;
    const compat = mode.startsWith("compat");
    const model = mode === "compat-passback" ? "glm-5" : mode === "compat-unknown" ? "mimo-v2.6-pro" : "claude-sonnet-4-6";
    const f = fixture(mode === "login" || mode === "direct", compat, model);
    const messages = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "unsigned" }, { type: "thinking", thinking: "signed", signature: "valid" },
        { type: "server_tool_use", id: "srvtoolu_ws_123" }, { type: "server_tool_use", id: "srvtoolu_real" },
        { type: "text", text: "answer" },
      ] },
    ];
    const before = structuredClone(messages);
    f.adapter.importState({ messages, topEffort: "medium", currentEffort: "medium" });
    await f.step();
    const params = f.requests[0];
    const sent = params.messages as { role: string; content: Record<string, unknown>[] }[];
    assert.deepEqual(sent[0].content, [{ type: "text", text: "hello" }], mode);
    assert.ok(!sent[1].content.some(block => block.id === "srvtoolu_ws_123"), mode);
    assert.equal(sent[1].content.some(block => block.thinking === "unsigned"), compat, mode);
    assert.ok(sent[1].content.some(block => block.thinking === "signed"), mode);
    assert.equal(sent[1].content.some(block => block.id === "srvtoolu_real"), mode !== "compat-passback", mode);
    assert.deepEqual(f.adapter.exportState().messages.slice(0, before.length), before, mode);
    if (compat) {
      assert.ok(!Object.hasOwn(params, "betas"));
      assert.ok(!Object.hasOwn(params, "context_management"));
      assert.ok(!Object.hasOwn(params, "output_config"));
      assert.deepEqual(params.thinking, { type: "enabled" });
    }
  }
});
