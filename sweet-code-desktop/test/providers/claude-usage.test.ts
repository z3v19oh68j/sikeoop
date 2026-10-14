import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedClaudeUsage, clearClaudeUsageSnapshot, ClaudePassiveUsageStore, ClaudeUsageCache, claudeUsageWithPassiveFallback, fetchClaudeUsage,
  parseClaudeUsage, parseClaudeUsageSnapshot, parsePassiveUsageHeaders, projectClaudeResetCredits, projectPassiveClaudeUsage,
  queryClaudeResetCredits, RESET_CREDITS_URL, USAGE_CACHE_TTL, USAGE_ERROR_CACHE_TTL, USAGE_URL, type ClaudeUsage,
  type ClaudeUsageSnapshot } from "../../src/main/providers/claude-usage.ts";
import { DefaultUserAgent } from "../../src/main/providers/claude-mimic.ts";

const sample: ClaudeUsage = {
  five_hour: { utilization: 42.5, resets_at: "2026-10-12T15:00:00Z" },
  seven_day: { utilization: 18, resets_at: "2026-10-19T00:00:00Z" },
  seven_day_sonnet: { utilization: 12.25, resets_at: "2026-10-19T00:00:00Z" },
  seven_day_overage_included: { utilization: 7, resets_at: "2026-10-19T00:00:00Z" },
};

test("sends GET with Bearer, oauth beta and sdk-cli UA, decodes the four windows", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const fetchMock: typeof fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify(sample), { status: 200 });
  };
  const result = await fetchClaudeUsage("test-token", { fetch: fetchMock });
  assert.equal(seen?.url, USAGE_URL);
  assert.equal(seen?.init?.method, "GET");
  assert.equal(seen?.init?.redirect, "error");
  assert.ok(seen?.init?.signal instanceof AbortSignal);
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-token");
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(headers["User-Agent"], DefaultUserAgent());
  assert.deepEqual(result, sample);
});

test("rejects empty token without a network call", async () => {
  let called = false;
  const fetchMock: typeof fetch = async () => { called = true; return new Response("{}"); };
  await assert.rejects(fetchClaudeUsage("", { fetch: fetchMock }), /未登录/);
  await assert.rejects(fetchClaudeUsage("   ", { fetch: fetchMock }).then(() => {}, e => { throw e; }).catch(e => { throw e; }));
  assert.equal(called, false);
});

test("non-200 and invalid JSON throw sanitized errors (no body leak)", async () => {
  const http401: typeof fetch = async () => new Response("sensitive-token-echo", { status: 401 });
  await assert.rejects(fetchClaudeUsage("tok", { fetch: http401 }), err =>
    err instanceof Error && /HTTP 401/.test(err.message) && !err.message.includes("sensitive-token-echo"));
  const badJson: typeof fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(fetchClaudeUsage("tok", { fetch: badJson }), /无效 JSON/);
});

test("parse fills missing/invalid windows with safe defaults", () => {
  assert.deepEqual(parseClaudeUsage(null), {
    five_hour: { utilization: 0, resets_at: "" },
    seven_day: { utilization: 0, resets_at: "" },
    seven_day_sonnet: { utilization: 0, resets_at: "" },
    seven_day_overage_included: { utilization: 0, resets_at: "" },
  });
  const mixed = parseClaudeUsage({
    five_hour: { utilization: "bad", resets_at: 1 },
    seven_day: { utilization: 50, resets_at: "later" },
    seven_day_sonnet: null,
    seven_day_overage_included: { utilization: NaN, resets_at: "x" },
  });
  assert.deepEqual(mixed.five_hour, { utilization: 0, resets_at: "" });
  assert.deepEqual(mixed.seven_day, { utilization: 50, resets_at: "later" });
  assert.deepEqual(mixed.seven_day_sonnet, { utilization: 0, resets_at: "" });
  assert.equal(mixed.seven_day_overage_included.utilization, 0);
  assert.equal(mixed.seven_day_overage_included.resets_at, "x");
});

const usageResponse = (value: ClaudeUsage = sample) => new Response(JSON.stringify(value));
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

test("successful usage hits the 3-minute cache, expires exactly at TTL and returns independent copies", async () => {
  assert.equal(USAGE_CACHE_TTL, 180_000);
  let now = 1000, calls = 0;
  const cache = new ClaudeUsageCache({ now: () => now, fetch: async () => {
    calls++;
    return usageResponse({ ...sample, five_hour: { ...sample.five_hour, utilization: calls } });
  } });
  const first = await cache.get("cache-test-token");
  first.five_hour.utilization = 999;
  now += USAGE_CACHE_TTL - 1;
  const hit = await cache.get("cache-test-token");
  assert.equal(hit.five_hour.utilization, 1);
  assert.equal(calls, 1);
  now++;
  assert.equal((await cache.get("cache-test-token")).five_hour.utilization, 2);
  assert.equal(calls, 2);
  assert.equal((await cache.get("cache-test-token")).five_hour.utilization, 2);
  assert.equal(calls, 2);
});

test("concurrent cold reads share one pending request; success TTL starts when it completes", async () => {
  let now = 0, calls = 0;
  const deferred = deferredResponse();
  const cache = new ClaudeUsageCache({ now: () => now, fetch: async () => {
    calls++;
    return calls === 1 ? deferred.promise : usageResponse();
  } });
  const pending = Array.from({ length: 12 }, () => cache.get("pending-test-token"));
  assert.equal(calls, 1);
  now = USAGE_CACHE_TTL * 2;
  deferred.resolve(usageResponse());
  const values = await Promise.all(pending);
  assert.ok(values.every(value => value.five_hour.utilization === sample.five_hour.utilization));
  assert.notEqual(values[0], values[1]);
  values[0].five_hour.utilization = 999;
  assert.equal(values[1].five_hour.utilization, sample.five_hour.utilization);
  now += USAGE_CACHE_TTL - 1;
  assert.deepEqual(await cache.get("pending-test-token"), sample);
  assert.equal(calls, 1);
  now++;
  assert.deepEqual(await cache.get("pending-test-token"), sample);
  assert.equal(calls, 2);
});

test("HTTP and invalid-JSON failures hit the 1-minute negative cache then recover", async () => {
  assert.equal(USAGE_ERROR_CACHE_TTL, 60_000);
  for (const failure of ["401", "429", "json"]) {
    let now = 500, calls = 0;
    const cache = new ClaudeUsageCache({ now: () => now, fetch: async () => {
      calls++;
      if (calls > 1) return usageResponse();
      return failure === "json" ? new Response("not json") : new Response("sensitive-response", { status: Number(failure) });
    } });
    const pattern = failure === "json" ? /无效 JSON/ : new RegExp(`HTTP ${failure}`);
    await assert.rejects(cache.get("negative-test-token"), pattern);
    now += USAGE_ERROR_CACHE_TTL - 1;
    await assert.rejects(cache.get("negative-test-token"), pattern);
    assert.equal(calls, 1);
    now++;
    assert.deepEqual(await cache.get("negative-test-token"), sample);
    assert.equal(calls, 2);
    assert.deepEqual(await cache.get("negative-test-token"), sample);
    assert.equal(calls, 2);
  }
});

test("concurrent failure shares one pending request and retains a negative result until completion-based expiry", async () => {
  let now = 0, calls = 0;
  const deferred = deferredResponse();
  const cache = new ClaudeUsageCache({ now: () => now, fetch: async () => {
    calls++;
    return calls === 1 ? deferred.promise : usageResponse();
  } });
  const all = Promise.allSettled(Array.from({ length: 8 }, () => cache.get("failure-test-token")));
  assert.equal(calls, 1);
  now = USAGE_ERROR_CACHE_TTL * 2;
  deferred.resolve(new Response("sensitive-response", { status: 429 }));
  const results = await all;
  assert.ok(results.every(result => result.status === "rejected" && /HTTP 429/.test(result.reason.message)));
  now += USAGE_ERROR_CACHE_TTL - 1;
  await assert.rejects(cache.get("failure-test-token"), /HTTP 429/);
  assert.equal(calls, 1);
  now++;
  assert.deepEqual(await cache.get("failure-test-token"), sample);
  assert.equal(calls, 2);
});

test("transport failures are negatively cached without retaining credentials or raw error data", async () => {
  let calls = 0;
  const cache = new ClaudeUsageCache({ fetch: async () => { calls++; throw new Error("Bearer secret-test-token transport detail"); } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(cache.get("secret-test-token"), error => error instanceof Error &&
      error.message === "Claude 用量查询失败" && error.cause === undefined);
  }
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(cache).includes("secret-test-token"));
  assert.ok(!JSON.stringify(cache).includes("transport detail"));
});

test("changing credentials invalidates positive/negative entries and old pending completions cannot replace the new slot", async () => {
  for (const oldFails of [false, true]) {
    const deferred = deferredResponse();
    const calls: string[] = [];
    const other = { ...sample, five_hour: { ...sample.five_hour, utilization: 7 } };
    const cache = new ClaudeUsageCache({ fetch: async (_url, init) => {
      const authorization = new Headers(init?.headers).get("Authorization")!;
      calls.push(authorization);
      return authorization === "Bearer old-test-token" ? deferred.promise : usageResponse(other);
    } });
    const old = cache.get("old-test-token");
    const settledOld = Promise.allSettled([old]);
    assert.deepEqual(await cache.get("new-test-token"), other);
    deferred.resolve(oldFails ? new Response("{}", { status: 401 }) : usageResponse());
    const [settled] = await settledOld;
    assert.equal(settled.status, oldFails ? "rejected" : "fulfilled");
    assert.deepEqual(await cache.get("new-test-token"), other);
    assert.deepEqual(calls, ["Bearer old-test-token", "Bearer new-test-token"]);
  }
  let calls = 0;
  const cache = new ClaudeUsageCache({ fetch: async () => { calls++; return calls === 1 ? new Response("{}", { status: 401 }) : usageResponse(); } });
  await assert.rejects(cache.get("negative-old-token"), /HTTP 401/);
  assert.deepEqual(await cache.get("positive-new-token"), sample);
  assert.equal(calls, 2);
  assert.deepEqual(await cache.get("another-new-token"), sample);
  assert.equal(calls, 3);
});

test("empty credentials never hit cached data, send a request or evict a valid token's entry", async () => {
  let calls = 0;
  const cache = new ClaudeUsageCache({ fetch: async () => { calls++; return usageResponse(); } });
  assert.deepEqual(await cache.get("valid-test-token"), sample);
  for (const token of ["", "   ", null, undefined, 0])
    await assert.rejects(cache.get(token as string), /未登录/);
  assert.deepEqual(await cache.get("valid-test-token"), sample);
  assert.equal(calls, 1);
});

test("the IPC-facing cachedClaudeUsage wrapper shares the default in-memory cache", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return usageResponse(); });
  const results = await Promise.all([cachedClaudeUsage("wrapper-test-token"), cachedClaudeUsage("wrapper-test-token")]);
  assert.deepEqual(results, [sample, sample]);
  assert.equal(calls, 1);
  assert.deepEqual(await cachedClaudeUsage("wrapper-test-token"), sample);
  assert.equal(calls, 1);
});

const sampleTime = Date.parse("2026-10-12T12:00:00Z");
const futureSeconds = Math.trunc(sampleTime / 1000) + 3600;
function passiveHeaders(values: Record<string, string>): Headers {
  return new Headers(Object.fromEntries(Object.entries(values).map(([key, value]) => [`anthropic-ratelimit-unified-${key}`, value])));
}

test("passive headers sample 5h/7d/7d_oi fractions as percent and normalize milliseconds to Unix seconds", () => {
  const snapshot = parsePassiveUsageHeaders(passiveHeaders({
    "5h-utilization": "0.125", "5h-reset": String(futureSeconds),
    "7d-utilization": "0.5", "7d-reset": String(futureSeconds * 1000 + 999),
    "7d_oi-utilization": "1.25", "7d_oi-reset": "100000000000",
  }), sampleTime);
  assert.deepEqual(snapshot, {
    five_hour: { utilization: 12.5, reset: futureSeconds },
    seven_day: { utilization: 50, reset: futureSeconds },
    seven_day_overage_included: { utilization: 125, reset: 100000000000 },
    sampled_at: "2026-10-12T12:00:00.000Z",
  });
  assert.equal(parsePassiveUsageHeaders(passiveHeaders({ "7d-reset": "100000000001" }), sampleTime)?.seven_day?.reset, 100000000);
});

test("passive malformed/absent headers are ignored, and persisted snapshots retain only allowlisted data", () => {
  for (const value of ["NaN", "Infinity", "garbage", "1 trailing", "0x10"])
    assert.equal(parsePassiveUsageHeaders(passiveHeaders({ "5h-utilization": value, "7d-reset": value }), sampleTime), undefined);
  assert.equal(parsePassiveUsageHeaders(new Headers(), sampleTime), undefined);
  assert.equal(parsePassiveUsageHeaders(passiveHeaders({ "7d-reset": "1.2" }), sampleTime), undefined);
  const raw = { sampled_at: "2026-10-12T12:00:00Z", five_hour: { utilization: 0, reset: futureSeconds, token: "secret" },
    token: "secret", headers: { Authorization: "Bearer secret" }, seven_day: { utilization: NaN, reset: Infinity } };
  assert.deepEqual(parseClaudeUsageSnapshot(raw), { sampled_at: raw.sampled_at, five_hour: { utilization: 0, reset: futureSeconds } });
  assert.ok(!JSON.stringify(parseClaudeUsageSnapshot(raw)).includes("secret"));
  for (const raw of [null, {}, { sampled_at: "invalid", five_hour: { utilization: 10 } }])
    assert.equal(projectPassiveClaudeUsage(raw, sampleTime), undefined);
});

test("serialized passive sampling merges concurrent windows, handles reset rollover and does not mutate inputs", async () => {
  let saved: ClaudeUsageSnapshot | undefined, writes = 0, now = sampleTime;
  const store = new ClaudePassiveUsageStore({ now: () => now, read: () => saved, write: async snapshot => {
    await Promise.resolve(); saved = snapshot; writes++;
  } });
  await store.sample(new Headers()); assert.equal(writes, 0);
  await Promise.all([
    store.sample(passiveHeaders({ "5h-utilization": "0.8", "5h-reset": String(futureSeconds) })),
    store.sample(passiveHeaders({ "7d-utilization": "0.4", "7d-reset": String(futureSeconds + 1000) })),
  ]);
  assert.equal(writes, 2);
  assert.equal(saved?.five_hour?.utilization, 80);
  assert.equal(saved?.seven_day?.utilization, 40);
  const before = structuredClone(saved);
  now++;
  await store.sample(passiveHeaders({ "5h-reset": String(futureSeconds + 18_000) }));
  assert.deepEqual(saved?.five_hour, { reset: futureSeconds + 18_000, utilization: 0 });
  assert.deepEqual(saved?.seven_day, before?.seven_day);
  assert.equal(before?.five_hour?.utilization, 80);
});

test("passive sampling failures do not reject, and logout/account-change epochs reject late samples", async () => {
  const failing = new ClaudePassiveUsageStore({ now: () => sampleTime, write: async () => { throw new Error("disk unavailable"); } });
  await assert.doesNotReject(failing.sample(passiveHeaders({ "5h-utilization": "0.5" })));
  const badRead = new ClaudePassiveUsageStore({ now: () => sampleTime, read: () => { throw new Error("bad store"); } });
  await assert.doesNotReject(badRead.sample(passiveHeaders({ "5h-utilization": "0.5" })));
  assert.equal(await badRead.passive(), undefined);
  const badHeaders = new Headers(); badHeaders.get = () => { throw new Error("bad header"); };
  await assert.doesNotReject(failing.sample(badHeaders));
  const store = new ClaudePassiveUsageStore({ now: () => sampleTime });
  const oldEpoch = store.generation();
  const queued = store.sample(passiveHeaders({ "5h-utilization": "0.5" }), oldEpoch);
  await store.clear(); await queued;
  await store.sample(passiveHeaders({ "5h-utilization": "0.9" }), oldEpoch);
  assert.equal(await store.passive(), undefined);
  await store.sample(passiveHeaders({ "5h-utilization": "0.1" }));
  assert.equal((await store.passive())?.five_hour.utilization, 10);
});

test("passive fallback projects four windows, sample time and expired-window zeroing without inventing Sonnet headers", () => {
  const raw = { sampled_at: "2026-10-12T12:00:00Z", five_hour: { utilization: 80, reset: futureSeconds },
    seven_day: { utilization: 35, reset: futureSeconds + 1000 }, seven_day_overage_included: { utilization: 12, reset: futureSeconds + 2000 } };
  const projected = projectPassiveClaudeUsage(raw, sampleTime)!;
  assert.equal(projected.source, "passive");
  assert.equal(projected.sampled_at, raw.sampled_at);
  assert.deepEqual(projected.five_hour, { utilization: 80, resets_at: new Date(futureSeconds * 1000).toISOString() });
  assert.deepEqual(projected.seven_day_sonnet, { utilization: 0, resets_at: "" });
  assert.equal(projected.seven_day_overage_included.utilization, 12);
  assert.equal(projectPassiveClaudeUsage(raw, futureSeconds * 1000)?.five_hour.utilization, 0);
  assert.equal(raw.five_hour.utilization, 80);
});

test("active query failures including negative-cache hits project the latest passive snapshot", async () => {
  let calls = 0, passiveCalls = 0;
  const cache = new ClaudeUsageCache({ fetch: async () => { calls++; return new Response("{}", { status: 429 }); } });
  const store = new ClaudePassiveUsageStore({ now: () => sampleTime });
  await store.sample(passiveHeaders({ "5h-utilization": "0.25", "5h-reset": String(futureSeconds) }));
  const passive = async () => { passiveCalls++; return store.passive(); };
  assert.equal((await claudeUsageWithPassiveFallback("token", token => cache.get(token), passive)).five_hour.utilization, 25);
  await store.sample(passiveHeaders({ "5h-utilization": "0.5" }));
  assert.equal((await claudeUsageWithPassiveFallback("token", token => cache.get(token), passive)).five_hour.utilization, 50);
  assert.equal(calls, 1); assert.equal(passiveCalls, 2);
  assert.deepEqual(await claudeUsageWithPassiveFallback("token", async () => sample, passive), sample);
  assert.equal(passiveCalls, 2);
  await assert.rejects(claudeUsageWithPassiveFallback("token", token => cache.get(token), async () => undefined), /HTTP 429/);
  await assert.rejects(claudeUsageWithPassiveFallback("token", token => cache.get(token), async () => { throw new Error("store failure"); }), /HTTP 429/);
  await assert.rejects(claudeUsageWithPassiveFallback("", async () => sample, passive), /未登录/);
  assert.equal(passiveCalls, 2);
});

function resetGrant(overrides: Record<string, unknown> = {}) {
  return { id: "grant_next", label: "Monthly reset", resets_left: 2, clears: ["five_hour"], paused: false, usable_now: true,
    percent_used: { five_hour: 100, seven_day: 30, negative: -1, excess: 101 }, blocking: [], ...overrides };
}

test("account changes while a passive read is pending cannot return the next account's snapshot", async () => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = new Error("Claude 用量请求失败 (HTTP 429)");
  const pending = claudeUsageWithPassiveFallback("old-token", async () => { throw original; }, async () => {
    entered(); await gate;
    return projectPassiveClaudeUsage({ sampled_at: new Date(sampleTime).toISOString(), five_hour: { utilization: 99 } }, sampleTime);
  });
  const rejected = assert.rejects(pending, error => error === original);
  await reading;
  await clearClaudeUsageSnapshot();
  release();
  await rejected;
});
function resetBlock(overrides: Record<string, unknown> = {}) {
  return { eligible: true, at_limit: true, next_grant_id: "grant_next", grants: [resetGrant()], ...overrides };
}

test("reset projection exposes held credits and available count without raw grant/organization IDs", () => {
  const block = resetBlock({ organization_id: "private-org", grants: [resetGrant(),
    resetGrant({ id: "grant_other", label: "Another", resets_left: 3, use_requires_limit: false }),
    resetGrant({ id: "INVALID!" }), resetGrant({ id: "paused", paused: true }), resetGrant({ id: "zero", resets_left: 0 }),
    resetGrant({ id: "no_clear", clears: [] }), resetGrant({ id: "future", starts_at: "2026-10-13T12:00:00Z" }),
    resetGrant({ id: "expired", ends_at: "2026-10-12T12:00:00Z" }),
  ] });
  const projected = projectClaudeResetCredits(block, sampleTime);
  assert.equal(projected.eligible, true);
  assert.equal(projected.available_count, 2);
  assert.equal(projected.credits.length, 2);
  assert.deepEqual(projected.credits[0], { label: "Monthly reset", resets_left: 2, clears: ["five_hour"], percent_used: { five_hour: 100, seven_day: 30 },
    blocking: [], use_requires_limit: true, redeemable: true });
  assert.equal(projected.credits[1].redeemable, false);
  assert.ok(!JSON.stringify(projected).includes("grant_next"));
  assert.ok(!JSON.stringify(projected).includes("private-org"));
  assert.equal(projected.fetched_at, "2026-10-12T12:00:00.000Z");
});

test("reset projection enforces all redeemability gates and exact start/expiry/cooldown boundaries", () => {
  for (const block of [resetBlock({ eligible: false }), resetBlock({ at_limit: false }), resetBlock({ next_grant_id: "other" }),
    resetBlock({ cooldown_until: "2026-10-12T12:00:01Z" }), resetBlock({ grants: [resetGrant({ usable_now: false })] }),
    resetBlock({ grants: [resetGrant({ blocking: ["weekly_limit"] })] })]) {
    const projected = projectClaudeResetCredits(block, sampleTime);
    assert.equal(projected.credits.length, 1);
    assert.equal(projected.credits[0].redeemable, false);
    assert.equal(projected.available_count, 0);
  }
  const atBoundary = projectClaudeResetCredits(resetBlock({ at_limit: false, cooldown_until: "2026-10-12T12:00:00Z",
    weekly_resets_at: "2026-10-19T12:00:00Z", grants: [resetGrant({ starts_at: "2026-10-12T12:00:00Z", use_requires_limit: false })] }), sampleTime);
  assert.equal(atBoundary.available_count, 2);
  assert.ok(!Object.hasOwn(atBoundary, "cooldown_until"));
  assert.equal(atBoundary.weekly_resets_at, "2026-10-19T12:00:00Z");
  assert.equal(atBoundary.credits[0].starts_at, "2026-10-12T12:00:00Z");
  assert.deepEqual(projectClaudeResetCredits(undefined, sampleTime), { eligible: false, available_count: 0, credits: [], fetched_at: "2026-10-12T12:00:00.000Z" });
});

test("reset query is GET cedar_ember=1&skip_spend=1 with OAuth headers, and returns only the projection", async () => {
  let calls = 0;
  const result = await queryClaudeResetCredits("test-token", { now: () => sampleTime, fetch: async (url, init) => {
    calls++;
    assert.equal(url, RESET_CREDITS_URL);
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer test-token");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(headers.get("x-app"), "cli"); assert.equal(headers.get("User-Agent"), DefaultUserAgent());
    return new Response(JSON.stringify({ cedar_ember: resetBlock() }));
  } });
  assert.equal(calls, 1); assert.ok(!("error" in result));
  if (!("error" in result)) assert.equal(result.available_count, 2);
  for (const envelope of [{}, { cedar_ember: null }]) {
    const result = await queryClaudeResetCredits("test-token", { now: () => sampleTime, fetch: async () => new Response(JSON.stringify(envelope)) });
    assert.deepEqual(result, { eligible: false, available_count: 0, credits: [], fetched_at: "2026-10-12T12:00:00.000Z" });
  }
});

test("reset query rejects malformed status/types, HTTP errors and oversized payloads without leaking upstream data", async () => {
  let calls = 0;
  for (const token of ["", " "]) assert.deepEqual(await queryClaudeResetCredits(token, { fetch: async () => { calls++; return new Response("{}"); } }), { error: "Claude OAuth 未登录" });
  assert.equal(calls, 0);
  for (const response of [new Response("sensitive-token", { status: 401 }), new Response("sensitive-token", { status: 201 }),
    new Response("bad sensitive-token"), new Response("null"), new Response("[]"),
    new Response(JSON.stringify({ error: "sensitive-token" })),
    ...[{ cedar_ember: {} }, { cedar_ember: { grants: null } }, { cedar_ember: resetBlock({ eligible: "yes" }) },
      { cedar_ember: resetBlock({ grants: [resetGrant({ resets_left: 1.5 })] }) },
      { cedar_ember: resetBlock({ grants: [resetGrant({ percent_used: { bad: "not-number" } })] }) },
      { cedar_ember: resetBlock({ grants: [resetGrant({ starts_at: "invalid" })] }) },
      { cedar_ember: resetBlock({ grants: [resetGrant({ starts_at: "2026-02-30T00:00:00Z" })] }) },
      { cedar_ember: resetBlock({ grants: [resetGrant({ starts_at: "2026-10-12T24:00:00Z" })] }) },
    ].map(envelope => new Response(JSON.stringify(envelope))),
    new Response(" ".repeat((1 << 20) + 1)),
  ]) {
    const result = await queryClaudeResetCredits("test-token", { fetch: async () => response });
    assert.ok("error" in result);
    assert.ok(!JSON.stringify(result).includes("sensitive-token"));
  }
  assert.deepEqual(await queryClaudeResetCredits("test-token", { fetch: async () => { throw new Error("Bearer sensitive-token"); } }), { error: "Claude reset 查询失败" });
});
