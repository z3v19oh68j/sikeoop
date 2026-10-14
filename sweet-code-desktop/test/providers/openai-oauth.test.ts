import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AuthorizeURL, BuildAuthorizationURL, ClientID, configureOAuthStorage, DecodeIDToken, exchangeCode,
  GenerateCodeChallenge, GenerateCodeVerifier, generateAuthUrl, loginStatus, logout, oauthToken, RedirectURI,
  refreshToken, RefreshSkew, ScopeOAuth, ScopeRefresh, SessionStore, SessionTTL, TokenURL,
  validOAuthToken, type OpenAIOAuthToken } from "../../src/main/providers/openai-oauth.ts";

const now = Date.parse("2026-10-12T12:00:00Z");
const jwt = (payload: unknown) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.unused`;
const identity = { email: "test@example.invalid", "https://api.openai.com/auth": {
  chatgpt_account_id: "test-account", chatgpt_plan_type: "plus", organizations: [{ id: "private-org" }], chatgpt_user_id: "private-user",
} };
const response = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600, id_token: jwt(identity), ...overrides,
}));
function storage(t: TestContext, initial?: OpenAIOAuthToken) {
  const state = { token: initial, writes: 0 };
  configureOAuthStorage(() => state.token, async token => { state.token = token; state.writes++; });
  t.after(() => configureOAuthStorage(() => undefined, async () => {}));
  return state;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function session() {
  const generated = generateAuthUrl();
  return { ...generated, state: new URL(generated.auth_url).searchParams.get("state")! };
}

test("PKCE uses a 64-byte hex verifier and unpadded SHA256 base64url challenge", () => {
  assert.equal(GenerateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const verifiers = new Set(Array.from({ length: 5 }, GenerateCodeVerifier));
  assert.equal(verifiers.size, 5);
  for (const verifier of verifiers) {
    assert.match(verifier, /^[a-f0-9]{128}$/);
    assert.equal(Buffer.from(verifier, "hex").length, 64);
    const challenge = GenerateCodeChallenge(verifier);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  }
});

test("authorization URL has the fixed ChatGPT client, scopes, callback and Codex flags", t => {
  storage(t);
  assert.equal(ClientID, "app_EMoamEEZ73f0CkXaXp7hrann");
  const expected = { client_id: ClientID, response_type: "code", redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access", code_challenge: "challenge+test", code_challenge_method: "S256",
    state: "state+test", id_token_add_organizations: "true", codex_cli_simplified_flow: "true" };
  const built = new URL(BuildAuthorizationURL(expected.state, expected.code_challenge));
  assert.equal(built.origin + built.pathname, AuthorizeURL);
  assert.deepEqual(Object.fromEntries(built.searchParams), expected);
  const first = session(), second = session();
  assert.match(first.session_id, /^[a-f0-9]{32}$/);
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.session_id, second.session_id); assert.notEqual(first.state, second.state);
  assert.match(new URL(first.auth_url).searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
});

test("sessions expire at exactly 30 minutes, and can be deleted/cleared", t => {
  t.mock.method(Date, "now", () => now);
  const store = new SessionStore();
  store.set("live", { state: "s", codeVerifier: "v", createdAt: now - SessionTTL + 1 });
  store.set("expired", { state: "s", codeVerifier: "v", createdAt: now - SessionTTL });
  assert.ok(store.get("live")); assert.equal(store.get("expired"), undefined);
  store.delete("live"); assert.equal(store.get("live"), undefined);
  store.set("fresh", { state: "s", codeVerifier: "v", createdAt: now });
  store.clear(); assert.equal(store.get("fresh"), undefined);
});

test("ID payload decoding only returns email/account/plan and ignores signature, expiry and extra fields", () => {
  assert.deepEqual(DecodeIDToken(jwt({ ...identity, exp: 1, token: "private-token" })), {
    email: "test@example.invalid", chatgpt_account_id: "test-account", plan_type: "plus",
  });
  assert.deepEqual(DecodeIDToken(jwt({ email: "中文@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: 1, chatgpt_plan_type: null } })), { email: "中文@example.invalid" });
  for (const raw of [undefined, null, 42, "not.jwt", "header.@@@.sig", "header.bm90IGpzb24.sig", jwt([]), jwt(null), jwt({ email: 5 })])
    assert.deepEqual(DecodeIDToken(raw), {});
});

test("exchange posts form-urlencoded PKCE, persists only token plus allowlisted identity, and consumes the session", async t => {
  const saved = storage(t); t.mock.method(Date, "now", () => now);
  let calls = 0;
  const flow = session();
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, TokenURL); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init?.body));
    assert.deepEqual([...form.keys()].sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
    assert.equal(form.get("code"), "code+with&special=value");
    assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(form.get("client_id"), ClientID);
    assert.equal(form.get("redirect_uri"), RedirectURI); assert.match(form.get("code_verifier")!, /^[a-f0-9]{128}$/);
    assert.equal(GenerateCodeChallenge(form.get("code_verifier")!), new URL(flow.auth_url).searchParams.get("code_challenge"));
    return response();
  });
  await assert.rejects(exchangeCode({ sessionId: flow.session_id, code: "code#wrong" }), /state/);
  assert.equal(calls, 0);
  const token = await exchangeCode({ sessionId: flow.session_id, code: `code+with&special=value#${flow.state}` });
  assert.deepEqual(token, { access_token: "test-access", refresh_token: "test-refresh", expires_at: now + 3600_000,
    email: "test@example.invalid", chatgpt_account_id: "test-account", plan_type: "plus" });
  assert.deepEqual(saved.token, token); assert.equal(saved.writes, 1); assert.deepEqual(oauthToken(), token);
  for (const forbidden of ["id_token", "private-org", "private-user"]) assert.ok(!JSON.stringify(saved.token).includes(forbidden));
  await assert.rejects(exchangeCode({ sessionId: flow.session_id, code: "code" }), /会话/);
  assert.equal(calls, 1);
});

test("manual paste accepts bare codes and state-validated callback URLs without following them", async t => {
  storage(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => { assert.equal(url, TokenURL); calls++; return response(); });
  const flow = session();
  for (const code of ["", "code#wrong", `code#${flow.state}#extra`,
    `${RedirectURI}?code=code`, `${RedirectURI}?code=code&state=wrong`,
    `${RedirectURI}?code=code&code=two&state=${flow.state}`, `${RedirectURI}?code=code&state=${flow.state}&state=${flow.state}`,
    `${RedirectURI}?error=access_denied&state=${flow.state}`, `${RedirectURI}?code=code&state=${flow.state}#fragment`,
    `https://invalid.example/auth/callback?code=code&state=${flow.state}`,
    `http://localhost:1455/wrong?code=code&state=${flow.state}`])
    await assert.rejects(exchangeCode({ sessionId: flow.session_id, code }), /code\/state/);
  assert.equal(calls, 0);
  const url = new URL(RedirectURI); url.searchParams.set("code", "callback+code"); url.searchParams.set("state", flow.state);
  await exchangeCode({ sessionId: flow.session_id, code: url.href });
  await exchangeCode({ sessionId: session().session_id, code: "bare-code" });
  assert.equal(calls, 2);
  await assert.rejects(exchangeCode({ sessionId: "missing", code: "code" }), /会话/);
  await assert.rejects(exchangeCode(undefined as never), /参数/);
});

test("refresh form scope excludes offline_access and preserves identity/refresh token when omitted", async t => {
  storage(t); t.mock.method(Date, "now", () => now);
  const previous: OpenAIOAuthToken = { access_token: "old", refresh_token: "refresh+&", expires_at: 0,
    email: "old@example.invalid", chatgpt_account_id: "old-account", plan_type: "pro" };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
    assert.deepEqual(form, { grant_type: "refresh_token", refresh_token: "refresh+&", client_id: ClientID, scope: "openid profile email" });
    assert.equal(form.scope, ScopeRefresh); assert.ok(!form.scope.includes("offline_access"));
    assert.ok(ScopeOAuth.includes("offline_access"));
    return response({ access_token: "new", refresh_token: undefined, id_token: undefined });
  });
  assert.deepEqual(await refreshToken(previous), { ...previous, access_token: "new", expires_at: now + 3600_000 });
  await assert.rejects(refreshToken({ ...previous, refresh_token: "" }), /过期/);
});

test("3-minute skew boundary and concurrent refresh use exactly one pending request and persist rotation", async t => {
  t.mock.method(Date, "now", () => now);
  const saved = storage(t, { access_token: "old", refresh_token: "old-refresh", expires_at: now + RefreshSkew + 1 });
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return gate.promise; });
  assert.equal((await validOAuthToken())?.access_token, "old"); assert.equal(calls, 0);
  saved.token!.expires_at = now + RefreshSkew;
  const reads = [validOAuthToken(), validOAuthToken(), validOAuthToken()];
  assert.equal(calls, 1); assert.equal(saved.writes, 0);
  gate.resolve(response({ access_token: "rotated", refresh_token: "rotated-refresh" }));
  for (const token of await Promise.all(reads)) assert.equal(token?.access_token, "rotated");
  assert.equal(saved.writes, 1); assert.equal(saved.token?.refresh_token, "rotated-refresh");
  assert.equal((await validOAuthToken())?.access_token, "rotated"); assert.equal(calls, 1);
});

test("failed refresh clears pending for retries; malformed/transport failures never disclose secrets", async t => {
  const saved = storage(t, { access_token: "old", refresh_token: "old-refresh", expires_at: 0 });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("secret-token invalid_scope", { status: 400 }); });
  const reads = await Promise.allSettled([validOAuthToken(), validOAuthToken()]);
  assert.equal(calls, 1);
  for (const read of reads) { assert.equal(read.status, "rejected"); if (read.status === "rejected") assert.equal(read.reason.message, "OpenAI OAuth 请求失败 (HTTP 400)"); }
  await assert.rejects(validOAuthToken(), /HTTP 400/); assert.equal(calls, 2); assert.equal(saved.writes, 0);
  for (const body of ["invalid secret-token", "null", "[]", JSON.stringify({ access_token: "secret-token" }),
    JSON.stringify({ access_token: "secret-token", expires_in: "3600" }), JSON.stringify({ access_token: "secret-token", expires_in: -1 })]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(exchangeCode({ sessionId: session().session_id, code: "code" }), error =>
      error instanceof Error && /返回无效/.test(error.message) && !error.message.includes("secret-token"));
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Bearer secret-token"); });
  await assert.rejects(exchangeCode({ sessionId: session().session_id, code: "code" }), /OpenAI OAuth 网络请求失败/);
});

test("logout cancels pending exchange and clears sessions; older concurrent exchanges cannot overwrite a newer login", async t => {
  const saved = storage(t); const gate = deferred();
  t.mock.method(globalThis, "fetch", async () => gate.promise);
  const flow = session(), unused = session();
  const exchange = exchangeCode({ sessionId: flow.session_id, code: "code" });
  const rejected = assert.rejects(exchange, /取消/);
  await logout(); gate.resolve(response()); await rejected;
  assert.equal(saved.token, undefined); assert.equal(await validOAuthToken(), undefined);
  await assert.rejects(exchangeCode({ sessionId: unused.session_id, code: "code" }), /会话/);
  const oldGate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? oldGate.promise : response({ access_token: "latest" }));
  const old = exchangeCode({ sessionId: session().session_id, code: "old" });
  const oldRejected = assert.rejects(old, /取消/);
  await exchangeCode({ sessionId: session().session_id, code: "new" });
  oldGate.resolve(response({ access_token: "older" })); await oldRejected;
  assert.equal(saved.token?.access_token, "latest");
});

test("logout during refresh rejects its late completion and does not clear a new account's refresh slot", async t => {
  const saved = storage(t, { access_token: "old", refresh_token: "old-refresh", expires_at: 0 });
  const oldGate = deferred(), newGate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls++;
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") return response({ access_token: "new", refresh_token: "new-refresh" });
    return form.get("refresh_token") === "old-refresh" ? oldGate.promise : newGate.promise;
  });
  const old = validOAuthToken(), oldRejected = assert.rejects(old, /变更/);
  await logout(); await exchangeCode({ sessionId: session().session_id, code: "new" });
  saved.token!.expires_at = 0;
  const next = validOAuthToken(); assert.equal(calls, 3);
  oldGate.resolve(response({ access_token: "stale" })); await oldRejected;
  const concurrent = validOAuthToken(); assert.equal(calls, 3);
  newGate.resolve(response({ access_token: "current" }));
  assert.equal((await next)?.access_token, "current"); assert.equal((await concurrent)?.access_token, "current");
  assert.equal(saved.token?.access_token, "current");
});

test("login status exposes only display fields, never OAuth credentials", async t => {
  const saved = storage(t); assert.deepEqual(await loginStatus(), { loggedIn: false });
  saved.token = { access_token: "private-access", refresh_token: "private-refresh", expires_at: Date.now() + 3600_000,
    email: "test@example.invalid", chatgpt_account_id: "account", plan_type: "plus" };
  assert.deepEqual(await loginStatus(), { loggedIn: true, email: "test@example.invalid", chatgpt_account_id: "account", plan_type: "plus" });
  saved.token.expires_at = 0; saved.token.refresh_token = "";
  assert.deepEqual(await loginStatus(), { loggedIn: false, expired: true, error: "OpenAI OAuth 登录不可用，请重新登录" });
});
