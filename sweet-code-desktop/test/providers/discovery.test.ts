import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelDiscovery, MODEL_CACHE_TTL, MODEL_DISCOVERY_TIMEOUT, modelsURL, parseModelList, type DiscoveryProvider } from "../../src/main/providers/discovery.ts";

const provider = (kind: "openai" | "anthropic" = "openai"): DiscoveryProvider => ({
  id: kind, kind, baseURL: "https://provider.invalid/gateway", apiKey: "test-only", fallback: ["static-main", "static-mini", "auto"],
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("protocol-neutral list parsing trims, deduplicates, preserves order and excludes auto", () => {
  assert.deepEqual(parseModelList({ data: [{ id: " z " }, { id: "a" }, { id: "z" }, { id: "auto" }, { id: "" }, { id: 1 }, null, "raw"] }), ["z", "a"]);
  for (const value of [null, [], {}, { data: "x" }, { data: [null] }]) assert.deepEqual(parseModelList(value), []);
});

test("model URL appends v1 once and preserves gateway prefixes", () => {
  for (const base of ["https://provider.invalid/gateway", "https://provider.invalid/gateway/", "https://provider.invalid/gateway/v1///"])
    assert.equal(modelsURL(base), "https://provider.invalid/gateway/v1/models");
  assert.equal(modelsURL("https://provider.invalid?tenant=x"), "https://provider.invalid/v1/models?tenant=x");
  assert.throws(() => modelsURL("file:///tmp"));
  assert.throws(() => modelsURL("https://user:pass@provider.invalid"));
});

for (const kind of ["openai", "anthropic"] as const) {
  test(`${kind}: GET correct headers, parsed ids and single-flight cached response`, async () => {
    let calls = 0;
    const discovery = new ModelDiscovery({ fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://provider.invalid/gateway/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.deepEqual(init?.headers, kind === "openai" ? { Authorization: "Bearer test-only" }
        : { "x-api-key": "test-only", "anthropic-version": "2023-06-01" });
      return response({ data: [{ id: "last" }, { id: "first" }, { id: "last" }] });
    } });
    const p = provider(kind);
    const [a, b] = await Promise.all([discovery.discover(p), discovery.discover(p)]);
    assert.deepEqual(a, ["last", "first"]);
    assert.deepEqual(b, a);
    a.push("mutation");
    assert.deepEqual(await discovery.discover(p), ["last", "first"]);
    assert.equal(calls, 1);
  });
  for (const failure of ["http", "json", "empty", "shape", "network"] as const) {
    test(`${kind}: ${failure} failure returns only preset fallback, without transport/key errors`, async () => {
      const discovery = new ModelDiscovery({ fetch: async () => {
        if (failure === "network") throw new Error("transport test-only");
        if (failure === "json") return new Response("not json");
        if (failure === "http") return response({ error: "test-only" }, 401);
        return response(failure === "empty" ? { data: [] } : { models: ["x"] });
      } });
      assert.deepEqual(await discovery.discover(provider(kind)), ["static-main", "static-mini"]);
      assert.deepEqual(await discovery.discover({ ...provider(kind), id: "no-static", fallback: [] }), []);
    });
  }
}

test("cache expires exactly after six hours and isolates provider/config/credentials", async () => {
  let now = 0, calls = 0;
  const discovery = new ModelDiscovery({ now: () => now, fetch: async () => response({ data: [{ id: `model-${++calls}` }] }) });
  const p = provider();
  assert.deepEqual(await discovery.discover(p), ["model-1"]);
  now = MODEL_CACHE_TTL - 1;
  assert.deepEqual(await discovery.discover(p), ["model-1"]);
  now++;
  assert.equal(discovery.cached(p), undefined);
  assert.deepEqual(await discovery.discover(p), ["model-2"]);
  await discovery.discover({ ...p, id: "another" });
  await discovery.discover({ ...p, apiKey: "changed-test-only" });
  await discovery.discover({ ...p, baseURL: p.baseURL + "/v1" });
  await discovery.discover({ ...p, kind: "anthropic" });
  assert.equal(calls, 6);
  discovery.invalidate(p.id);
  assert.equal(discovery.cached(p), undefined);
});

test("failed discovery is briefly cached then retried, rather than using stale successful ids", async () => {
  let now = 0, calls = 0;
  const discovery = new ModelDiscovery({ now: () => now, fetch: async () => ++calls === 1
    ? response({ data: [{ id: "old" }] }) : response({}, 503) });
  const p = provider();
  await discovery.discover(p);
  now = MODEL_CACHE_TTL;
  assert.deepEqual(await discovery.discover(p), ["static-main", "static-mini"]);
  await discovery.discover(p);
  assert.equal(calls, 2);
  now += 60_000;
  await discovery.discover(p);
  assert.equal(calls, 3);
});

test("discovery deadline is 10s, aborts hung transport and returns static fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  const discovery = new ModelDiscovery({ fetch: async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  } });
  const pending = discovery.discover(provider());
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(MODEL_DISCOVERY_TIMEOUT - 1);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, ["static-main", "static-mini"]);
  assert.equal(signal?.aborted, true);
});

test("pagination follows after_id without sorting or duplicating ids", async () => {
  let calls = 0;
  const discovery = new ModelDiscovery({ fetch: async url => {
    if (++calls === 1) return response({ data: [{ id: "z" }], has_more: true, last_id: "z" });
    assert.equal(new URL(String(url)).searchParams.get("after_id"), "z");
    return response({ data: [{ id: "z" }, { id: "a" }], has_more: false });
  } });
  assert.deepEqual(await discovery.discover(provider("anthropic")), ["z", "a"]);
});

test("anthropic login: Bearer + 13 beta + sdk-cli UA; empty/401 fall back to static", async t => {
  const { configureOAuthStorage } = await import("../../src/main/providers/claude-oauth.ts");
  const { FullClaudeCodeMimicryBetas, DefaultUserAgent } = await import("../../src/main/providers/claude-mimic.ts");
  let saved: { access_token: string; refresh_token: string; expires_at: number } | undefined = {
    access_token: "login-token", refresh_token: "r", expires_at: Date.now() + 3_600_000,
  };
  configureOAuthStorage(() => saved, async t => { saved = t as typeof saved; });
  t.after(() => configureOAuthStorage(() => undefined, async () => {}));
  const login = (): DiscoveryProvider => ({
    id: "anthropic-login", kind: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "",
    fallback: ["static-main", "static-mini"], login: true,
  });
  const expected = FullClaudeCodeMimicryBetas();
  assert.equal(expected.length, 13);
  const okFetch = new ModelDiscovery({ fetch: async (_url, init) => {
    const h = init?.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer login-token");
    assert.equal(h["anthropic-beta"], expected.join(","));
    assert.equal(h["User-Agent"], DefaultUserAgent());
    assert.equal(h["anthropic-version"], "2023-06-01");
    return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-5" }] }), { status: 200 });
  } });
  assert.deepEqual(await okFetch.discover(login()), ["claude-sonnet-4-5", "claude-opus-4-5"]);
  const http401 = new ModelDiscovery({ fetch: async () => new Response("err", { status: 401 }) });
  assert.deepEqual(await http401.discover(login()), ["static-main", "static-mini"]);
  const empty = new ModelDiscovery({ fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  assert.deepEqual(await empty.discover(login()), ["static-main", "static-mini"]);
  saved = undefined;
  const noToken = new ModelDiscovery({ fetch: async () => { throw new Error("should not call"); } });
  assert.deepEqual(await noToken.discover(login()), ["static-main", "static-mini"]);
});

test("openai login: codex models with Bearer + account id + identity; empty/401/no token fall back to static", async t => {
  const { configureOAuthStorage } = await import("../../src/main/providers/openai-oauth.ts");
  const { CodexModelsURL, codexIdentity } = await import("../../src/main/providers/openai-codex.ts");
  let saved: { access_token: string; refresh_token: string; expires_at: number; chatgpt_account_id?: string } | undefined = {
    access_token: "chatgpt-token", refresh_token: "r", expires_at: Date.now() + 3_600_000, chatgpt_account_id: "acct-1",
  };
  configureOAuthStorage(() => saved, async token => { saved = token; });
  t.after(() => configureOAuthStorage(() => undefined, async () => {}));
  const login = (): DiscoveryProvider => ({
    id: "openai", kind: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-unused",
    fallback: ["static-gpt"], login: true,
  });
  const identity = codexIdentity();
  let calls = 0;
  const okFetch = new ModelDiscovery({ fetch: async (url, init) => {
    calls++;
    const target = new URL(String(url));
    assert.equal(target.origin + target.pathname, CodexModelsURL);
    assert.equal(target.searchParams.get("client_version"), identity.version);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const h = init?.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer chatgpt-token");
    assert.equal(h["chatgpt-account-id"], "acct-1");
    assert.equal(h["User-Agent"], identity.userAgent);
    assert.equal(h.originator, identity.originator);
    assert.equal(JSON.stringify(h).includes("sk-unused"), false);
    return new Response(JSON.stringify({ models: [{ slug: "gpt-sub-a" }, { slug: "gpt-sub-b" }, { slug: "auto" }] }), { status: 200 });
  } });
  assert.deepEqual(await okFetch.discover(login()), ["gpt-sub-a", "gpt-sub-b"]);
  assert.deepEqual(await okFetch.discover(login()), ["gpt-sub-a", "gpt-sub-b"]);
  assert.equal(calls, 1);
  // The same provider with a key keeps using the ordinary API list.
  const keyFetch = new ModelDiscovery({ fetch: async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.deepEqual(init?.headers, { Authorization: "Bearer sk-unused" });
    return new Response(JSON.stringify({ data: [{ id: "gpt-api" }] }), { status: 200 });
  } });
  assert.deepEqual(await keyFetch.discover({ ...login(), login: false }), ["gpt-api"]);

  const http401 = new ModelDiscovery({ fetch: async () => new Response("err", { status: 401 }) });
  assert.deepEqual(await http401.discover(login()), ["static-gpt"]);
  const empty = new ModelDiscovery({ fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }) });
  assert.deepEqual(await empty.discover(login()), ["static-gpt"]);
  saved = undefined;
  const noToken = new ModelDiscovery({ fetch: async () => { throw new Error("should not call"); } });
  assert.deepEqual(await noToken.discover(login()), ["static-gpt"]);
});
