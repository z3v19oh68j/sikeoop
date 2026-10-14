import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { VERSION as SDKVersion } from "@anthropic-ai/sdk/version";
import { BillingFingerprint, CLICurrentVersion, CLIVersion, DefaultHeaders, DefaultUserAgent, FullClaudeCodeMimicryBetas, IsSupportedCLIVersion, ModelIDOverrides, NormalizeModelID, WithClaudeCodeBilling } from "../../src/main/providers/claude-mimic.ts";
import { GenerateCodeChallenge, generateAuthUrl, SessionStore, SessionTTL, exchangeCode, configureOAuthStorage, validOAuthToken, logout, ScopeOAuth, ScopeInference, type ClaudeOAuthToken } from "../../src/main/providers/claude-oauth.ts";

const expectedBetas = [
  "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13",
  "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "mid-conversation-system-2026-04-07",
  "claude-code-20250219", "per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01",
  "inline-tools-2026-09-15", "advisor-tool-2026-03-01", "effort-2025-11-24", "extended-cache-ttl-2025-04-11",
];

test("2.1.296 login identity has 13 ordered betas and leaves stainless to the installed SDK", () => {
  assert.equal(CLICurrentVersion, "2.1.296");
  assert.deepEqual(FullClaudeCodeMimicryBetas(), expectedBetas);
  assert.equal(DefaultUserAgent(), `claude-cli/${CLIVersion()} (external, sdk-cli)`);
  assert.equal(DefaultHeaders()["User-Agent"], DefaultUserAgent());
  assert.ok(Object.keys(DefaultHeaders()).every(key => !/^x-stainless-/i.test(key)));
  const betas = FullClaudeCodeMimicryBetas(); betas.pop();
  assert.deepEqual(FullClaudeCodeMimicryBetas(), expectedBetas);
});

test("billing cf4 vector, zero padding and UTF-16 indexing match the verified algorithm", () => {
  assert.equal(BillingFingerprint("say hi", "2.1.296"), "cf4");
  const digest = (sample: string) => createHash("sha256").update(`59cf53e54c78${sample}2.1.296`).digest("hex").slice(0, 3);
  assert.equal(BillingFingerprint("", "2.1.296"), digest("000"));
  const unicode = "abcd😀x😀abcdefghijk😀";
  assert.equal(BillingFingerprint(unicode, "2.1.296"), digest(unicode[4] + unicode[7] + unicode[20]));
  assert.notEqual(BillingFingerprint(unicode, "2.1.296"), digest([4, 7, 20].map(i => [...unicode][i] ?? "0").join("")));
});

test("model aliases stay exact and haiku-5-5 passes through", () => {
  assert.equal(NormalizeModelID("claude-haiku-4-5"), "claude-haiku-4-5-20251001");
  for (const id of ["claude-haiku-5-5", "haiku-5-5", "claude-haiku-4-5-20251001", "custom", "__proto__", "toString"])
    assert.equal(NormalizeModelID(id), id);
  assert.ok(!Object.hasOwn(ModelIDOverrides, "claude-haiku-5-5"));
});

test("CLI version override preserves the baseline floor and is resolved once", () => {
  for (const value of ["2.1.296", "2.1.297", "2.2.0", "3.0.0"]) assert.ok(IsSupportedCLIVersion(value));
  for (const value of ["2.1.295", "2.0.999", "v2.1.296", "2.1.296-beta", "02.1.296", "2.1", ""]) assert.ok(!IsSupportedCLIVersion(value));
  const moduleURL = new URL("../../src/main/providers/claude-mimic.ts", import.meta.url).href;
  for (const [raw, version] of [["", "2.1.296"], [" 2.1.297 ", "2.1.297"], ["2.1.295", "2.1.296"], ["bad", "2.1.296"]]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const m = await import(${JSON.stringify(moduleURL)});
      process.env.SIKEOOP_CLAUDE_CLI_VERSION = '9.0.0';
      console.log(JSON.stringify([m.CLIVersion(), m.DefaultUserAgent(), m.BillingFingerprint('say hi')]));
    `], { encoding: "utf8", env: { ...process.env, SIKEOOP_CLAUDE_CLI_VERSION: raw }, timeout: 2000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [version, `claude-cli/${version} (external, sdk-cli)`, BillingFingerprint("say hi", version)]);
  }
});

test("billing uses the first user text block, preserves system/cache and replaces stale billing", () => {
  const system = [{ type: "text", text: "original system", cache_control: { type: "ephemeral" } }];
  const body = JSON.stringify({ system, messages: [
    { role: "assistant", content: "not user" },
    { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "say hi" }, { type: "text", text: "not first" }] },
    { role: "user", content: "later" },
  ], model: "claude-haiku-5-5", tools: [{ name: "test" }], cache_control: { type: "ephemeral" } });
  const result = JSON.parse(WithClaudeCodeBilling(body) as string);
  assert.equal(result.system[0].text, `x-anthropic-billing-header: cc_version=${CLIVersion()}.${BillingFingerprint("say hi")}; cc_entrypoint=sdk-cli;`);
  assert.deepEqual(result.system.slice(1), system);
  assert.deepEqual({ ...result, system }, JSON.parse(body));
  assert.equal(WithClaudeCodeBilling(JSON.stringify(result)), JSON.stringify(result));
  result.system[0].text = "x-anthropic-billing-header: cc_version=old; cc_entrypoint=cli;";
  assert.equal(JSON.parse(WithClaudeCodeBilling(JSON.stringify(result)) as string).system.length, 2);
  const stringSystem = JSON.parse(WithClaudeCodeBilling(JSON.stringify({ system: "plain system", messages: [{ role: "user", content: "say hi" }] })) as string);
  assert.deepEqual(stringSystem.system.slice(1), [{ type: "text", text: "plain system" }]);
  const noText = JSON.parse(WithClaudeCodeBilling(JSON.stringify({ messages: [{ role: "user", content: [{ type: "tool_result", content: "ignored" }] }] })) as string);
  assert.ok(noText.system[0].text.includes(`${CLIVersion()}.${BillingFingerprint("")};`));
  for (const body of [undefined, "not json", "null", "[]", '{"model":"test"}']) assert.equal(WithClaudeCodeBilling(body), body);
});

test("real login client sends sdk-cli identity, stable client session, SDK stainless and refreshed bearer on retries", async t => {
  // Only unrelated Electron/OpenAI integration modules are stubbed; exercise the actual client and SDK transport.
  const indexURL = new URL("../../src/main/providers/index.ts", import.meta.url).href;
  const stubs: Record<string, string> = {
    "./store": "export const installId = () => 'test-install';",
    "./openai-compatible": "export class OpenAICompatibleAdapter {}",
    "./openai-responses": "export class OpenAIResponsesAdapter {}",
  };
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === indexURL) {
      if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      if (specifier === "./anthropic") return nextResolve("./anthropic.ts", context);
    }
    return nextResolve(specifier, context);
  } });
  let module: typeof import("../../src/main/providers/index.ts");
  try { module = await import(indexURL); } finally { hooks.deregister(); }
  const { anthropicClient, createAdapter } = module;
  let saved: ClaudeOAuthToken | undefined = { access_token: "test-initial", refresh_token: "test-refresh", expires_at: Date.now() + 3600_000 };
  configureOAuthStorage(() => saved, async token => { saved = token; });
  t.after(() => configureOAuthStorage(() => undefined, async () => {}));
  const provider = { preset: { id: "anthropic", name: "Claude", kind: "anthropic" as const, baseURL: "https://api.anthropic.com", needsKey: true,
    keyHint: "", defaultModel: "claude-haiku-5-5", suggestedModels: [] }, baseURL: "https://api.anthropic.com", model: "claude-haiku-5-5",
    apiKey: "test-api-key", authMode: "login" as const };
  const calls: { headers: Headers; body: Record<string, any> }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (calls.length === 1) {
      saved = { ...saved!, access_token: "test-next" };
      return new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } });
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const client = anthropicClient(provider);
  const params = { model: "claude-haiku-5-5", max_tokens: 1, system: "original system", messages: [{ role: "user" as const, content: "say hi" }],
    betas: ["fine-grained-tool-streaming-2025-05-14"] };
  await client.beta.messages.create(params, { maxRetries: 1, headers: { "x-client-request-id": "remove-me", "user-agent": "override-me", "x-api-key": "remove-me" } });
  await client.beta.messages.create(params);
  await anthropicClient(provider).beta.messages.create(params);
  const session = calls[0].headers.get("X-Claude-Code-Session-Id");
  assert.match(session!, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  for (const [i, { headers, body }] of calls.entries()) {
    assert.equal(headers.get("User-Agent"), DefaultUserAgent());
    assert.equal(headers.get("anthropic-beta"), expectedBetas.join(","));
    assert.equal(headers.get("x-client-request-id"), null);
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("authorization"), i === 0 ? "Bearer test-initial" : "Bearer test-next");
    assert.equal(headers.get("X-Stainless-Package-Version"), SDKVersion);
    assert.equal(headers.get("X-Stainless-OS"), ({ darwin: "MacOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[process.platform]);
    assert.equal(headers.get("X-Stainless-Arch"), process.arch);
    assert.equal(headers.get("X-Stainless-Runtime"), "node");
    assert.equal(headers.get("X-Stainless-Runtime-Version"), process.version);
    assert.equal(headers.get("X-Stainless-Retry-Count"), i === 1 ? "1" : "0");
    assert.equal(headers.get("X-Stainless-Timeout"), "600");
    assert.equal(body.system[0].text, `x-anthropic-billing-header: cc_version=${CLIVersion()}.${BillingFingerprint("say hi")}; cc_entrypoint=sdk-cli;`);
    assert.equal(body.model, "claude-haiku-5-5");
    if (i < 3) assert.equal(headers.get("X-Claude-Code-Session-Id"), session);
    else assert.notEqual(headers.get("X-Claude-Code-Session-Id"), session);
  }
  // Model normalization is login-only, even if a compatible provider has authMode=login.
  for (const [authMode, compat, model, expected] of [
    ["login", false, "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    ["api_key", false, "claude-haiku-4-5", "claude-haiku-4-5"],
    ["login", true, "claude-haiku-4-5", "claude-haiku-4-5"],
    ["login", false, "claude-haiku-5-5", "claude-haiku-5-5"],
  ] as const) {
    const adapter = createAdapter({ ...provider, authMode, model, preset: { ...provider.preset, compat } }, "system", []);
    assert.equal((adapter as unknown as { upstreamModel: string }).upstreamModel, expected);
  }
  for (const p of [{ ...provider, authMode: "api_key" as const }, { ...provider, preset: { ...provider.preset, compat: true } }]) {
    await anthropicClient(p).messages.create(params);
    const { headers, body } = calls.at(-1)!;
    assert.notEqual(headers.get("User-Agent"), DefaultUserAgent());
    assert.equal(headers.get("X-Claude-Code-Session-Id"), null);
    assert.equal(headers.get("anthropic-beta"), null);
    assert.equal(body.system, "original system");
    assert.equal(headers.get(p.preset.compat ? "authorization" : "x-api-key"), p.preset.compat ? "Bearer test-api-key" : "test-api-key");
  }
  await logout();
  const sent = calls.length;
  await assert.rejects(client.beta.messages.create(params, { maxRetries: 0 }), error =>
    error instanceof Error && error.cause instanceof Error && /重新登录/.test(error.cause.message));
  assert.equal(calls.length, sent);
});
test("PKCE URL and session TTL match upstream", () => {
  assert.equal(GenerateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  for (const scope of ["full", "inference"] as const) {
    const result = generateAuthUrl(scope), url = new URL(result.auth_url);
    assert.match(result.session_id, /^[a-f0-9]{32}$/);
    assert.equal(url.searchParams.get("scope"), scope === "full" ? ScopeOAuth : ScopeInference);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  }
  const store = new SessionStore();
  store.set("expired", { state: "s", codeVerifier: "v", scope: "", createdAt: Date.now() - SessionTTL });
  assert.equal(store.get("expired"), undefined);
});
test("exchange state, single use, deduplicated refresh, logout and sanitized errors", async () => {
  let saved: ClaudeOAuthToken | undefined;
  configureOAuthStorage(() => saved, async token => { saved = token; });
  const original = globalThis.fetch, bodies: Record<string, string>[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(new Headers(init?.headers).get("User-Agent"), "axios/1.13.6");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ access_token: `token-${bodies.length}`, refresh_token: "refresh", expires_in: 3600, account: { email_address: "a@example.invalid" } }));
  };
  try {
    const result = generateAuthUrl("full"), state = new URL(result.auth_url).searchParams.get("state");
    await assert.rejects(exchangeCode({ sessionId: result.session_id, code: "code#wrong" }), /state/);
    await exchangeCode({ sessionId: result.session_id, code: `code#${state}` });
    assert.equal(saved?.email, "a@example.invalid"); assert.equal(bodies[0].code, "code");
    await assert.rejects(exchangeCode({ sessionId: result.session_id, code: "code" }), /会话/);
    saved!.expires_at = 0;
    await Promise.all([validOAuthToken(), validOAuthToken()]);
    assert.equal(bodies.length, 2); assert.equal(bodies[1].grant_type, "refresh_token");
    await logout(); assert.equal(saved, undefined);
    globalThis.fetch = async () => new Response("secret-token", { status: 400 });
    const failed = generateAuthUrl("inference");
    await assert.rejects(exchangeCode({ sessionId: failed.session_id, code: "code" }), error => error instanceof Error && /HTTP 400/.test(error.message) && !error.message.includes("secret-token"));
  } finally { globalThis.fetch = original; }
});
