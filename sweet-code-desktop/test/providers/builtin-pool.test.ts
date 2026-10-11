import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedProvider } from "../../src/main/providers/store.ts";
import { ModelDiscovery } from "../../src/main/providers/discovery.ts";
import { autoCandidatesCached, autoFailoverCandidates, builtinFreeOrder, configureBuiltinFreePool,
  modelDiscovery, resolveAuto, withAutoFailover } from "../../src/main/providers/model-routing.ts";

function supplier(id: string, enabled = true, kind: "openai" | "anthropic" = "openai"): ResolvedProvider {
  return { preset: { id, name: id, kind, builtinFree: true, discoverModels: true,
    baseURL: `https://example.invalid/${id}/v1`, builtinKey: "test-placeholder", defaultModel: "auto",
    suggestedModels: [], needsKey: true, keyHint: "" },
    enabled, baseURL: `https://example.invalid/${id}/v1`, model: "auto", apiKey: "test-placeholder", authMode: "api_key", openaiApi: "chat" };
}
const signal = () => new AbortController().signal;

async function setup(t: TestContext, providers: ResolvedProvider[],
  order: ReturnType<typeof builtinFreeOrder> = undefined, emptyId?: string) {
  const fetched: string[] = [];
  // Replace only the discovery transport, restoring it automatically without real network access.
  const fake = new ModelDiscovery({ fetch: async url => {
    const id = new URL(String(url)).pathname.split("/")[1];
    fetched.push(id);
    return new Response(JSON.stringify({ data: id === emptyId ? [] : ["general", "chat-mini", "coder", "reasoner-pro"].map(id => ({ id })) }));
  } });
  t.mock.method(modelDiscovery, "discover", fake.discover.bind(fake));
  t.mock.method(modelDiscovery, "cached", fake.cached.bind(fake));
  configureBuiltinFreePool({ providers: () => providers, order: () => order });
  t.after(() => configureBuiltinFreePool({ providers: () => [], order: () => undefined }));
  return fetched;
}

test("per-purpose order validation deduplicates and rejects malformed IPC", () => {
  assert.equal(builtinFreeOrder(undefined), undefined);
  assert.deepEqual(builtinFreeOrder({ chat: [" b ", "a", "b"], hard: [] }), { chat: ["b", "a"], hard: [] });
  for (const bad of [null, [], 3, { coding: "a" }, { hard: [null] }, { subtask: [""] }])
    assert.throws(() => builtinFreeOrder(bad), /builtinFreeOrder/);
});

test("pool selects same-purpose discovered models across both protocols and adjustable order", async t => {
  const a = supplier("a"), b = supplier("b", true, "anthropic"), c = supplier("c");
  const fetched = await setup(t, [a, b, c], { chat: ["b", "a"], hard: ["c"] });
  assert.equal((await resolveAuto(a, "chat", signal())).preset.id, "b");
  assert.equal((await resolveAuto(a, "chat", signal())).model, "chat-mini");
  assert.equal((await resolveAuto(a, "hard", signal())).preset.id, "c");
  assert.equal((await resolveAuto(a, "hard", signal())).model, "reasoner-pro");
  assert.equal((await resolveAuto(a, "coding", signal())).model, "coder");
  assert.deepEqual([...new Set(fetched)].sort(), ["a", "b", "c"]);
  assert.deepEqual(autoCandidatesCached(a, "chat").filter(x => x.model === "chat-mini").map(x => x.preset.id), ["b", "a", "c"]);
});

for (const status of [429, 402, 401, 403, 503]) {
  test(`provider-wide ${status} goes straight to next supplier, never retries its other models`, async t => {
    const a = supplier("a"), b = supplier("b"), c = supplier("c");
    await setup(t, [a, b, c], { subtask: ["b", "c", "a"] });
    const calls: string[] = [];
    const result = await withAutoFailover(a, "subtask", signal(), async p => {
      calls.push(`${p.preset.id}:${p.model}`);
      if (p.preset.id !== "a") throw { status };
      return "ok";
    });
    assert.equal(result, "ok");
    assert.deepEqual(calls, ["b:chat-mini", "c:chat-mini", "a:chat-mini"]);
    assert.deepEqual(autoFailoverCandidates({ ...b, model: "chat-mini" }, "subtask", { status }).map(x => x.preset.id), ["c", "c", "c", "c", "a", "a", "a", "a"]);
  });
}

test("missing model retries local discovery order before crossing suppliers", async t => {
  const a = supplier("a"), b = supplier("b"); await setup(t, [a, b]);
  const calls: string[] = [];
  await withAutoFailover(a, "coding", signal(), async p => {
    calls.push(`${p.preset.id}:${p.model}`);
    if (p.preset.id === "a") throw { status: 404 };
    return "ok";
  });
  assert.deepEqual(calls, ["a:coder", "a:general", "a:chat-mini", "a:reasoner-pro", "b:coder"]);
});

test("disabled supplier is neither discovered nor routed even as active or ordered first", async t => {
  const a = supplier("a", false), b = supplier("b"), c = supplier("c", false);
  const fetched = await setup(t, [a, b, c], { chat: ["a", "c", "b"] });
  assert.equal((await resolveAuto(a, "chat", signal())).preset.id, "b");
  assert.deepEqual(fetched, ["b"]);
  assert.ok(autoCandidatesCached(a, "chat").every(x => x.preset.id === "b"));
  b.enabled = false;
  assert.deepEqual(autoFailoverCandidates({ ...a, model: "chat-mini" }, "chat", { status: 429 }), []);
  await assert.rejects(resolveAuto(a, "chat", signal()), /没有可用模型/);
});

test("empty discovery on first supplier skips to the next without sending auto", async t => {
  const a = supplier("a"), b = supplier("b"); await setup(t, [a, b], undefined, "a");
  assert.equal((await resolveAuto(a, "coding", signal())).preset.id, "b");
});

test("fixed models do not enter the pool; disabled fixed models fail closed", async t => {
  const a = supplier("a"), b = supplier("b"); const fetched = await setup(t, [a, b], { chat: ["b"] });
  const fixed = { ...a, model: "chosen" };
  assert.equal((await resolveAuto(fixed, "chat", signal())).preset.id, "a");
  assert.deepEqual(fetched, ["a"]);
  await assert.rejects(resolveAuto({ ...fixed, enabled: false }, "chat", signal()), /已关闭/);
});

test("nonretryable errors, cancellation and emitted streams never replay on another supplier", async t => {
  const a = supplier("a"), b = supplier("b"); await setup(t, [a, b]);
  let calls = 0;
  await assert.rejects(withAutoFailover(a, "chat", signal(), async () => { calls++; throw { status: 400 }; }));
  assert.equal(calls, 1);
  await assert.rejects(withAutoFailover(a, "chat", signal(), async () => { calls++; throw { status: 429 }; }, () => false));
  assert.equal(calls, 2);
  const controller = new AbortController();
  await assert.rejects(withAutoFailover(a, "chat", controller.signal, async () => { calls++; controller.abort(); throw { status: 503 }; }));
  assert.equal(calls, 3);
});

test("provider disabled while a side job is failing is removed from remaining retry candidates", async t => {
  const a = supplier("a"), b = supplier("b"), c = supplier("c"); await setup(t, [a, b, c]);
  const calls: string[] = [];
  await withAutoFailover(a, "chat", signal(), async p => {
    calls.push(p.preset.id);
    if (p.preset.id === "a") { b.enabled = false; throw { status: 429 }; }
    return "ok";
  });
  assert.deepEqual(calls, ["a", "c"]);
});

test("entire pool exhaustion preserves final error and forward main-session candidates do not revisit previous suppliers", async t => {
  const a = supplier("a"), b = supplier("b"), c = supplier("c"); await setup(t, [a, b, c]);
  const calls: string[] = [], failure = { status: 402, message: "final-test-error" };
  await assert.rejects(withAutoFailover(a, "hard", signal(), async p => {
    calls.push(p.preset.id); throw failure;
  }), err => err === failure);
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.ok(autoFailoverCandidates({ ...b, model: "reasoner-pro" }, "hard", { status: 429 }).every(x => x.preset.id === "c"));
  assert.deepEqual(autoFailoverCandidates({ ...c, model: "reasoner-pro" }, "hard", { status: 402 }), []);
});
