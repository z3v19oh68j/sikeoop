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
