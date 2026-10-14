import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexError, codexIdentity, CodexMinVersion, CodexOriginator, CodexResponsesURL, CodexUnsupportedFields, CodexVersion, OpenAICodexAdapter,
  codexClientMetadata, sseEvents, toCodexBody, toReplayItem } from "../../src/main/providers/openai-codex.ts";
import type { OpenAIOAuthToken } from "../../src/main/providers/openai-oauth.ts";
import { CodexInstallationKey, CodexModelsURL, codexInstallationId, codexModelsRequest, configureInstallationStorage, isCodexLogin,
  parseCodexModels } from "../../src/main/providers/openai-codex.ts";
import { PRESETS, supportsLogin } from "../../src/main/providers/presets.ts";

const token: OpenAIOAuthToken = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Date.now() + 3600_000,
  chatgpt_account_id: "test-account" };
const tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
const usage = { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 100 } };

const sse = (events: unknown[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
function streamOf(text: string, chunk = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
}
const completed = (output: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage, ...extra } });
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "enc-blob" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };

interface Seen { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> }
function harness(replies: (string | Response)[], opts: { token?: OpenAIOAuthToken | null } = {}) {
  const seen: Seen[] = [];
  const fetchMock: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("unexpected request");
    return typeof reply === "string" ? new Response(streamOf(reply), { status: 200 }) : reply;
  };
  const adapter = new OpenAICodexAdapter(
    { model: " gpt-5.5 ", installationId: "sweet-test-install", fetch: fetchMock, token: async () => (opts.token === null ? undefined : (opts.token ?? token)) },
    "You are sikeoop.", tools);
  return { adapter, seen };
}
function handlers() {
  const log = { text: "", thinking: "", starts: [] as string[], input: "" };
  return { log, h: {
    onText: (d: string) => { log.text += d; },
    onThinking: (d: string) => { log.thinking += d; },
    onToolStart: (id: string, name: string) => { log.starts.push(`${id}:${name}`); },
    onToolInput: (_id: string, d: string) => { log.input += d; },
  } };
}
const step = { effort: "high" as const, signal: new AbortController().signal };

test("omitted installationId defaults to a uuid", () => {
  const a = new OpenAICodexAdapter({ model: "gpt-5.5", fetch: async () => new Response("{}"), token: async () => undefined }, "s", []);
  const meta = codexClientMetadata({ threadId: "t", turnId: "u", rootTurnId: "r", installationId: (a as unknown as { installationId: string }).installationId, model: "m", effort: "high" });
  assert.match(meta["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
});

test("toCodexBody forces store/stream, drops unsupported fields and adds the reasoning include", () => {
  const body = toCodexBody({ model: " gpt-5.5 ", store: true, stream: false, input: "hi", reasoning: { effort: "low" },
    ...Object.fromEntries(CodexUnsupportedFields.map((k) => [k, 1])) });
  assert.deepEqual(body, { model: "gpt-5.5", store: false, stream: true, reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"], input: [{ type: "message", role: "user", content: "hi" }] });
  assert.deepEqual(toCodexBody({ reasoning: { effort: "low" }, include: ["x", "reasoning.encrypted_content"] }).include,
    ["x", "reasoning.encrypted_content"]);
  assert.deepEqual(toCodexBody({ reasoning: { effort: "low" }, include: ["x"] }).include, ["x", "reasoning.encrypted_content"]);
  assert.equal("include" in toCodexBody({ reasoning: {} }), false);
  assert.deepEqual(toCodexBody({ input: "  " }).input, []);
});

test("identity triple is self-consistent and falls back on a bad version", () => {
  const id = codexIdentity("0.150.1");
  assert.equal(id.originator, CodexOriginator);
  assert.equal(id.version, "0.150.1");
  assert.match(id.userAgent, /^codex-tui\/0\.150\.1 \(Ubuntu 22\.4\.0; x86_64\) xterm-256color$/);
  assert.equal(CodexOriginator, "codex-tui");
  assert.equal(codexIdentity().version, "0.162.0");
  assert.equal(codexIdentity(CodexMinVersion).version, "0.144.0");
  assert.equal(codexIdentity("0.147.0-alpha.4").version, "0.147.0-alpha.4");
  for (const bad of ["", "1", "0.1.0\r\nX: y", "v0.150.0", "9".repeat(70) + ".1", "0.143.9", "0.99"]) assert.equal(codexIdentity(bad).version, CodexVersion);
});

test("toReplayItem strips ids, keeps encrypted reasoning and backfills summary", () => {
  assert.deepEqual(toReplayItem(reasoning), { type: "reasoning", summary: reasoning.summary, encrypted_content: "enc-blob" });
  assert.deepEqual(toReplayItem({ type: "reasoning", id: "rs_2", encrypted_content: "e" }), { type: "reasoning", encrypted_content: "e", summary: [] });
  assert.deepEqual(toReplayItem(call), { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' });
});

test("sseEvents handles split chunks, CRLF, comments, [DONE] and a trailing event without a blank line", async () => {
  const text = ': ping\r\n\r\nevent: a\r\ndata: {"type":"a","n":1}\r\n\r\ndata: not-json\n\ndata: [DONE]\n\ndata: {"type":"b",\r\ndata: "n":2}\r';
  for (const size of [1, 5, 1000]) {
    const out: unknown[] = [];
    for await (const ev of sseEvents(streamOf(text, size))) out.push(ev);
    assert.deepEqual(out, [{ type: "a", n: 1 }, { type: "b", n: 2 }]);
  }
});

test("step sends the Codex wire body and identity headers, and streams text and thinking", async () => {
  const { adapter, seen } = harness([sse([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    { type: "response.output_text.delta", delta: "Hel" },
    { type: "response.output_text.delta", delta: "lo" },
    completed([reasoning, message("Hello")]),
  ])]);
  adapter.addUserText(["hi", "there"], "high");
  const { log, h } = handlers();
  const res = await adapter.step(step, h);

  assert.deepEqual(res, { stop: "end_turn", toolCalls: [], usage: { input: 20, output: 30, cacheRead: 100, cacheWrite: 0 } });
  assert.equal(adapter.promptTokens(), 120);
  assert.deepEqual(log, { text: "Hello", thinking: "think", starts: [], input: "" });

  const [req] = seen;
  assert.equal(req.url, CodexResponsesURL);
  assert.equal(req.init.method, "POST");
  assert.equal(req.init.redirect, "error");
  assert.equal(req.init.signal, step.signal);
  const { threadId, turnId, rootTurnId } = adapter.exportState();
  assert.match(turnId!, /^[0-9a-f-]{36}$/);
  assert.equal(rootTurnId, turnId);
  assert.notEqual(turnId, threadId);
  const ids = { thread_id: threadId, session_id: threadId, turn_id: turnId, root_turn_id: turnId };
  assert.match(threadId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(req.body, {
    model: "gpt-5.5", instructions: "You are sikeoop.", input: [{ role: "user", content: "hi\n\nthere" }],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: tools[0].inputSchema, strict: false }],
    tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "high" }, prompt_cache_key: threadId,
    client_metadata: { "x-codex-installation-id": "sweet-test-install", ...ids, "x-codex-window-id": `${threadId}:0`,
      "x-codex-turn-metadata": JSON.stringify({ ...ids, installation_id: "sweet-test-install", model: "gpt-5.5", reasoning_effort: "high" }) },
    store: false, stream: true, include: ["reasoning.encrypted_content"],
  });
  for (const key of CodexUnsupportedFields) assert.equal(key in req.body, false);
  const id = codexIdentity();
  assert.deepEqual(req.headers, {
    Authorization: "Bearer test-access", "chatgpt-account-id": "test-account", "User-Agent": id.userAgent, originator: id.originator,
    version: id.version, "OpenAI-Beta": "responses=experimental", session_id: threadId, "x-client-request-id": threadId, Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  assert.equal(id.userAgent, "codex-tui/0.162.0 (Ubuntu 22.4.0; x86_64) xterm-256color");
  assert.equal(id.version, "0.162.0");
  assert.equal("thread_id" in req.body, false);
  assert.equal("previous_response_id" in req.body, false);
});

test("function calls stream, and the thread chains across steps with ids stripped", async () => {
  const { adapter, seen } = harness([
    sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.txt"}' },
      { type: "response.function_call_arguments.delta", item_id: "fc_unknown", delta: "ignored" },
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item: call },
      // The completed event carries no output list: the finished items stand in for it.
      completed([]),
    ]),
    sse([completed([message("done")])]),
  ]);
  adapter.addUserText(["read a.txt"], "high");
  const { log, h } = handlers();
  const first = await adapter.step(step, h);
  assert.equal(first.stop, "tool_use");
  assert.deepEqual(first.toolCalls, [{ id: "call_1", name: "read_file", input: { path: "a.txt" } }]);
  assert.deepEqual(log.starts, ["call_1:read_file"]);
  assert.equal(log.input, '{"path":"a.txt"}');

  adapter.addToolResults([{ id: "call_1", content: "file body", isError: false }]);
  const second = await adapter.step(step, h);
  assert.equal(second.stop, "end_turn");

  assert.deepEqual(seen[1].body.input, [
    { role: "user", content: "read a.txt" },
    { type: "reasoning", summary: reasoning.summary, encrypted_content: "enc-blob" },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_1", output: "file body" },
  ]);
  assert.equal("previous_response_id" in seen[1].body, false);
  assert.equal(seen[1].body.prompt_cache_key, seen[0].body.prompt_cache_key);
  assert.equal(seen[1].headers.session_id, seen[0].headers.session_id);
  assert.equal(seen[1].headers.session_id, seen[0].body.prompt_cache_key);
  assert.equal(seen[1].headers["x-client-request-id"], seen[0].headers["x-client-request-id"]);
  // Both steps belong to the one user turn.
  assert.deepEqual(seen[1].body.client_metadata, seen[0].body.client_metadata);
  assert.deepEqual(adapter.history().map((e) => e.role), ["user", "assistant", "tool", "assistant"]);
});

test("thread id survives export/import and rollback, and restart begins a new thread", async () => {
  const { adapter, seen } = harness([sse([completed([message("a")])]), sse([completed([message("b")])]), sse([completed([message("c")])])]);
  adapter.addUserText(["one"], "high");
  const mark = adapter.checkpoint();
  await adapter.step(step, handlers().h);
  adapter.rollback(mark);
  assert.equal(adapter.checkpoint(), mark);

  const saved = JSON.parse(JSON.stringify(adapter.exportState()));
  const next = harness([sse([completed([message("b")])])]);
  next.adapter.importState(saved);
  await next.adapter.step(step, handlers().h);
  assert.equal(next.seen[0].headers.session_id, seen[0].headers.session_id);
  assert.deepEqual(next.seen[0].body.input, [{ role: "user", content: "one" }]);

  adapter.restart(["summary"], true);
  await adapter.step(step, handlers().h);
  assert.notEqual(seen[1].headers.session_id, seen[0].headers.session_id);
  assert.deepEqual(seen[1].body.input, [{ role: "user", content: "summary" }]);

  const meta = (i: number) => seen[i].body.client_metadata as Record<string, string>;
  assert.equal(meta(1).thread_id, seen[1].headers.session_id);
  assert.equal(meta(1).root_turn_id, meta(1).turn_id);
  assert.notEqual(meta(1).turn_id, meta(0).turn_id);
  assert.equal((next.seen[0].body.client_metadata as Record<string, string>).turn_id, meta(0).turn_id);

  adapter.restart(["carried"], false);
  adapter.addUserText(["next"], "high");
  await adapter.step(step, handlers().h);
  assert.deepEqual(seen[2].body.input, [{ role: "user", content: "carried\n\nnext" }]);
});

test("stop reasons: refusal, content filter and max tokens", async () => {
  const refusal = { type: "message", id: "msg_r", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] };
  const incomplete = (reason: string, output: unknown[]) =>
    ({ type: "response.incomplete", response: { status: "incomplete", output, usage, incomplete_details: { reason } } });
  const { adapter } = harness([sse([completed([refusal])]), sse([incomplete("content_filter", [])]),
    sse([incomplete("max_output_tokens", [call])]), sse([incomplete("max_output_tokens", [message("cut")])])]);
  adapter.addUserText(["x"], "high");
  assert.equal((await adapter.step(step, handlers().h)).stop, "refusal");
  assert.equal((await adapter.step(step, handlers().h)).stop, "refusal");
  const before = adapter.checkpoint();
  const cut = await adapter.step(step, handlers().h);
  assert.equal(cut.stop, "max_tokens");
  assert.equal(cut.toolCalls.length, 1);
  assert.equal(adapter.checkpoint(), before);
  assert.deepEqual(await adapter.step(step, handlers().h).then((r) => [r.stop, r.toolCalls.length]), ["max_tokens", 0]);
  assert.equal(adapter.checkpoint(), before + 1);
});

test("errors: no login, HTTP errors, stream errors and a cut-off stream", async () => {
  const none = harness([], { token: null });
  none.adapter.addUserText(["x"], "high");
  await assert.rejects(none.adapter.step(step, handlers().h), (e) => e instanceof CodexError && e.status === 401);
  assert.equal(none.seen.length, 0);

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const { adapter } = harness([
    json(401, { error: { message: "token expired" } }),
    json(429, { error: { type: "usage_limit_reached", message: "limit" } }),
    new Response("<html>bad gateway</html>", { status: 502 }),
    sse([{ type: "error", code: "server_is_overloaded", message: "overloaded" }]),
    sse([{ type: "response.failed", response: { status: "failed", output: [], error: { code: "server_error", message: "boom" } } }]),
    sse([{ type: "response.output_text.delta", delta: "partial" }]),
  ]);
  adapter.addUserText(["x"], "high");
  const fail = async () => adapter.step(step, handlers().h).then(() => assert.fail("should throw"), (e: unknown) => e);
  assert.match(adapter.describeError(await fail())!, /重新登录/);
  assert.match(adapter.describeError(await fail())!, /额度/);
  assert.match(adapter.describeError(await fail())!, /暂时出了问题/);
  assert.match(adapter.describeError(await fail())!, /太忙/);
  assert.match(adapter.describeError(await fail())!, /boom/);
  assert.match(adapter.describeError(await fail())!, /中途断了/);
  assert.equal(adapter.checkpoint(), 1);
  assert.equal(adapter.describeError(new Error("other")), null);
  const abort = new Error("aborted"); abort.name = "AbortError";
  assert.equal(adapter.isAbort(abort), true);
  assert.equal(adapter.isAbort(new Error("x")), false);
});

test("a context-length error clears old tool results and retries once", async () => {
  const { adapter, seen } = harness([
    new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), { status: 400 }),
    sse([completed([message("ok")])]),
  ]);
  adapter.importState({ format: "codex", threadId: "thread-1", items: [
    { role: "user", content: "go" },
    ...Array.from({ length: 6 }, (_, i) => [
      { type: "function_call", id: `fc_${i}`, call_id: `c${i}`, name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: `c${i}`, output: `out${i}` },
    ]).flat(),
  ] });
  const res = await adapter.step(step, handlers().h);
  assert.deepEqual(res.trimmed, { how: "cleared" });
  assert.equal(seen[1].headers.session_id, "thread-1");
  const outputs = (seen[1].body.input as { type?: string; output?: string; id?: string }[]).filter((i) => i.type === "function_call_output").map((i) => i.output!);
  assert.equal(outputs.filter((o) => o.startsWith("[")).length, 2);
  assert.deepEqual(outputs.slice(2), ["out2", "out3", "out4", "out5"]);
  assert.equal((seen[1].body.input as { id?: string }[]).some((i) => "id" in i), false);
});

test("a second user turn gets a new turn id under the same root", async () => {
  const { adapter, seen } = harness([sse([completed([message("a")])]), sse([completed([message("b")])])]);
  adapter.addUserText(["one"], "high");
  await adapter.step(step, handlers().h);
  adapter.addUserText(["two"], "low");
  await adapter.step({ ...step, effort: "low" }, handlers().h);
  const [a, b] = seen.map((r) => r.body.client_metadata as Record<string, string>);
  assert.equal(b.root_turn_id, a.turn_id);
  assert.notEqual(b.turn_id, a.turn_id);
  assert.equal(b.thread_id, a.thread_id);
  assert.equal(JSON.parse(b["x-codex-turn-metadata"]).reasoning_effort, "low");
  assert.deepEqual(seen[1].body.reasoning, { effort: "low" });
  assert.deepEqual(Object.keys(codexClientMetadata({ threadId: "t", turnId: "u", rootTurnId: "r", installationId: "i", model: "m", effort: "high" })),
    ["x-codex-installation-id", "thread_id", "session_id", "turn_id", "root_turn_id", "x-codex-window-id", "x-codex-turn-metadata"]);
});

test("routing and readiness: only the official OpenAI preset in login mode goes to the subscription", () => {
  const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
  assert.equal(supportsLogin(preset("openai")), true);
  assert.equal(supportsLogin(preset("anthropic")), true);
  for (const p of PRESETS.filter((x) => x.id !== "openai" && x.id !== "anthropic")) assert.equal(supportsLogin(p), false, p.id);
  assert.equal(supportsLogin({ id: "custom-1", kind: "openai" }), false);
  assert.equal(supportsLogin({ id: "relay", kind: "anthropic", compat: true }), false);

  assert.equal(isCodexLogin({ preset: preset("openai"), authMode: "login" }), true);
  assert.equal(isCodexLogin({ preset: preset("openai"), authMode: "api_key" }), false);
  assert.equal(isCodexLogin({ preset: preset("anthropic"), authMode: "login" }), false);
  assert.equal(isCodexLogin({ preset: { id: "custom-1", kind: "openai" }, authMode: "login" }), false);
});

test("installation id is a uuid made once, kept in storage, and stable while a save fails", async (t) => {
  t.after(() => configureInstallationStorage(() => undefined, async () => {}));
  assert.equal(CodexInstallationKey, "openai-codex-installation");
  const keys: Record<string, string> = {};
  let writes = 0;
  configureInstallationStorage(() => keys[CodexInstallationKey], async (id) => { writes++; keys[CodexInstallationKey] = id; });
  const first = codexInstallationId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await Promise.resolve();
  assert.equal(keys[CodexInstallationKey], first);
  assert.equal(codexInstallationId(), first);
  assert.equal(writes, 1);

  // A stored value that is not a uuid is replaced.
  keys[CodexInstallationKey] = "sweet-0123456789abcdef";
  configureInstallationStorage(() => keys[CodexInstallationKey], async (id) => { keys[CodexInstallationKey] = id; });
  const replaced = codexInstallationId();
  assert.notEqual(replaced, first);
  assert.equal(keys[CodexInstallationKey], replaced);

  // The save fails: the id stays the same for this run and the save is tried again.
  let attempts = 0;
  configureInstallationStorage(() => undefined, async () => { attempts++; throw new Error("disk full"); });
  const unsaved = codexInstallationId();
  assert.equal(codexInstallationId(), unsaved);
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test("models request carries the login and identity, not the per-thread headers", () => {
  const id = codexIdentity();
  const req = codexModelsRequest(token);
  assert.equal(req.url, `${CodexModelsURL}?client_version=${id.version}`);
  assert.equal(req.headers.Authorization, "Bearer test-access");
  assert.equal(req.headers["chatgpt-account-id"], "test-account");
  assert.equal(req.headers["User-Agent"], id.userAgent);
  assert.equal(req.headers.originator, id.originator);
  assert.equal(req.headers.Accept, "application/json");
  for (const key of ["session_id", "x-client-request-id", "Content-Type"]) assert.equal(key in req.headers, false);
  assert.deepEqual(parseCodexModels({ models: [{ slug: "gpt-a" }, { slug: " gpt-b " }, { slug: "gpt-a" }, { id: "gpt-c" }, {}, null] }), ["gpt-a", "gpt-b", "gpt-c"]);
  assert.deepEqual(parseCodexModels({ data: [{ id: "gpt-d" }] }), ["gpt-d"]);
  for (const bad of [null, "x", {}, { models: "x" }, []]) assert.deepEqual(parseCodexModels(bad), []);
});

test("subscription login falls back to the static model list; the API-key mode does not", async () => {
  const { availableModels } = await import("../../src/main/providers/model-routing.ts");
  const { CodexFallbackModels } = await import("../../src/main/providers/openai-codex.ts");
  const openai = { preset: PRESETS.find((p) => p.id === "openai")!, baseURL: "https://api.openai.com/v1", model: "", apiKey: "",
    openaiApi: "responses" as const };
  assert.equal(CodexFallbackModels.length, 12);
  assert.equal(new Set(CodexFallbackModels).size, 12);
  assert.deepEqual(availableModels({ ...openai, authMode: "login" }), CodexFallbackModels);
  assert.deepEqual(availableModels({ ...openai, authMode: "api_key" }), []);
  assert.deepEqual(availableModels({ ...openai, authMode: "login", enabled: false }), []);
});

const usagePayload = {
  user_id: "user-private", account_id: "acct-private", email: "private@example.invalid", plan_type: "plus",
  rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 37.5, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 140, limit_window_seconds: 604800, reset_after_seconds: 3600 } },
  additional_rate_limits: [
    { limit_name: "Codex Spark", metered_feature: "spark", rate_limit: { limit_reached: true, primary_window: { used_percent: 100 }, secondary_window: null } },
    { limit_name: "", metered_feature: "", rate_limit: { primary_window: { used_percent: 1 } } },
    { limit_name: "empty", rate_limit: null },
  ],
  credits: { has_credits: true, balance: "12.5" },
};

test("quota: parses the main and secondary windows and the additional limits, and keeps identifiers out", async () => {
  const { parseCodexQuota } = await import("../../src/main/providers/openai-codex.ts");
  const now = Date.parse("2026-10-12T12:00:00Z");
  const quota = parseCodexQuota(usagePayload, now);
  assert.deepEqual(quota, {
    plan_type: "plus", limit_reached: false,
    primary: { used_percent: 37.5, resets_at: new Date(1_800_000_000_000).toISOString(), window_seconds: 18000 },
    secondary: { used_percent: 100, resets_at: "2026-10-12T13:00:00.000Z", window_seconds: 604800 },
    additional: [{ name: "Codex Spark", limit_reached: true, primary: { used_percent: 100 } }],
    fetched_at: "2026-10-12T12:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(quota), /private|12\.5/);
  assert.deepEqual(parseCodexQuota({}, now), { limit_reached: false, additional: [], fetched_at: "2026-10-12T12:00:00.000Z" });
  assert.deepEqual(parseCodexQuota({ rate_limit: { primary_window: { used_percent: "9" }, secondary_window: null } }, now).primary, undefined);
  for (const bad of [null, "x", []]) assert.throws(() => parseCodexQuota(bad), /无效数据/);
});

test("quota: request shape, and errors that never carry the response or the login", async () => {
  const { fetchCodexQuota, CodexUsageURL, CODEX_USAGE_TIMEOUT } = await import("../../src/main/providers/openai-codex.ts");
  assert.equal(CODEX_USAGE_TIMEOUT, 20_000);
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const ok = await fetchCodexQuota(token, { now: () => 0, fetch: async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify(usagePayload), { status: 200 });
  } });
  assert.equal(ok.primary?.used_percent, 37.5);
  assert.equal(seen?.url, CodexUsageURL);
  assert.equal(seen?.init?.method, "GET");
  assert.equal(seen?.init?.redirect, "error");
  assert.ok(seen?.init?.signal instanceof AbortSignal);
  const h = seen?.init?.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer test-access");
  assert.equal(h["chatgpt-account-id"], "test-account");
  assert.equal(h["openai-beta"], "codex-1");
  assert.equal(h["oai-language"], "zh-CN");
  assert.equal(h.originator, "Codex Desktop");
  assert.equal(h.Accept, "application/json");
  assert.equal(h["sec-fetch-site"], "none");
  assert.equal(h["sec-fetch-mode"], "no-cors");
  assert.equal(h["sec-fetch-dest"], "empty");
  assert.equal(h.priority, "u=4, i");
  assert.equal("User-Agent" in h, false);
  assert.equal("version" in h, false);

  const failing = async (reply: () => Promise<Response>) =>
    fetchCodexQuota(token, { fetch: reply }).then(() => assert.fail("should throw"), (e: Error) => e.message);
  assert.equal(await failing(async () => new Response("secret body test-access", { status: 403 })), "ChatGPT 额度请求失败 (HTTP 403)");
  assert.equal(await failing(async () => new Response("<html>", { status: 200 })), "ChatGPT 额度返回无效 JSON");
  assert.equal(await failing(async () => new Response("[]", { status: 200 })), "ChatGPT 额度返回无效数据");
  assert.equal(await failing(async () => { throw new Error("connect ECONNREFUSED 10.0.0.1 Bearer test-access"); }), "ChatGPT 额度查询失败");
  await assert.rejects(fetchCodexQuota(token, { timeout: 5, fetch: (_u, init) => new Promise((_r, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
  }) }), /^Error: ChatGPT 额度查询失败$/);
  let called = false;
  await assert.rejects(fetchCodexQuota({ ...token, access_token: " " }, { fetch: async () => { called = true; return new Response("{}"); } }), /还没有登录/);
  assert.equal(called, false);
});

test("quota cache: 3 minutes for a result, 1 minute for a failure, shared in flight, separate per login", async () => {
  const { CodexQuotaCache, CODEX_USAGE_CACHE_TTL, CODEX_USAGE_ERROR_CACHE_TTL } = await import("../../src/main/providers/openai-codex.ts");
  assert.equal(CODEX_USAGE_CACHE_TTL, 180_000);
  assert.equal(CODEX_USAGE_ERROR_CACHE_TTL, 60_000);
  let now = 1_000_000, calls = 0, fail = false;
  const cache = new CodexQuotaCache({ now: () => now, fetch: async () => {
    calls++;
    if (fail) throw new Error("socket hang up with test-access");
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: calls } } }), { status: 200 });
  } });
  const [a, b] = await Promise.all([cache.get(token), cache.get(token)]);
  assert.equal(calls, 1);
  assert.equal(a.primary?.used_percent, 1);
  a.primary!.used_percent = 99;
  assert.equal(b.primary?.used_percent, 1);
  now += CODEX_USAGE_CACHE_TTL - 1;
  assert.equal((await cache.get(token)).primary?.used_percent, 1);
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await cache.get(token)).primary?.used_percent, 2);
  assert.equal((await cache.get(token, true)).primary?.used_percent, 3);

  // Another login never sees this one's entry.
  assert.equal((await cache.get({ ...token, access_token: "other-access" })).primary?.used_percent, 4);

  fail = true;
  now += CODEX_USAGE_CACHE_TTL;
  const message = async () => cache.get({ ...token, access_token: "other-access" }).then(() => assert.fail("should throw"), (e: Error) => e.message);
  assert.equal(await message(), "ChatGPT 额度查询失败");
  assert.equal(calls, 5);
  fail = false;
  now += CODEX_USAGE_ERROR_CACHE_TTL - 1;
  assert.equal(await message(), "ChatGPT 额度查询失败");
  assert.equal(calls, 5);
  now += 1;
  assert.equal((await cache.get({ ...token, access_token: "other-access" })).primary?.used_percent, 6);

  const before = calls;
  await assert.rejects(cache.get(undefined), /还没有登录/);
  assert.equal(calls, before);
});
