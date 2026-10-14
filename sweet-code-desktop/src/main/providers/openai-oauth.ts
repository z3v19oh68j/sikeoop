import { randomBytes, createHash } from "node:crypto";

export const ClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AuthorizeURL = "https://auth.openai.com/oauth/authorize";
export const TokenURL = "https://auth.openai.com/oauth/token";
export const RedirectURI = "http://localhost:1455/auth/callback";
export const ScopeOAuth = "openid profile email offline_access";
export const ScopeRefresh = "openid profile email";
export const SessionTTL = 30 * 60_000;
export const RefreshSkew = 3 * 60_000;
export const GenerateState = () => randomBytes(32).toString("base64url");
export const GenerateSessionID = () => randomBytes(16).toString("hex");
export const GenerateCodeVerifier = () => randomBytes(64).toString("hex");
export const GenerateCodeChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export function BuildAuthorizationURL(state: string, challenge: string): string {
  return `${AuthorizeURL}?${new URLSearchParams({ client_id: ClientID, response_type: "code", redirect_uri: RedirectURI,
    scope: ScopeOAuth, code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true" })}`;
}

export interface OAuthSession { state: string; codeVerifier: string; createdAt: number }
export class SessionStore {
  private sessions = new Map<string, OAuthSession>();
  set(id: string, session: OAuthSession): void { this.cleanup(); this.sessions.set(id, session); }
  get(id: string): OAuthSession | undefined { this.cleanup(); return this.sessions.get(id); }
  delete(id: string): void { this.sessions.delete(id); }
  clear(): void { this.sessions.clear(); }
  private cleanup(): void {
    for (const [id, session] of this.sessions) if (Date.now() - session.createdAt >= SessionTTL) this.sessions.delete(id);
  }
}
const sessions = new SessionStore();
export interface OpenAIIdentity { email?: string; chatgpt_account_id?: string; plan_type?: string }
export interface OpenAIOAuthToken extends OpenAIIdentity {
  access_token: string; refresh_token: string; expires_at: number;
}
export interface OpenAILogin extends OpenAIIdentity { loggedIn: boolean; expired?: boolean; error?: string }
const object = (raw: unknown): Record<string, unknown> | undefined =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;

/** Display metadata only: decode the payload, not the signature; never use these fields for authorization. */
export function DecodeIDToken(raw: unknown): OpenAIIdentity {
  if (typeof raw !== "string") return {};
  const parts = raw.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return {};
  try {
    const claims = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    if (!claims) return {};
    const auth = object(claims["https://api.openai.com/auth"]);
    const result: OpenAIIdentity = {};
    if (typeof claims.email === "string") result.email = claims.email;
    if (typeof auth?.chatgpt_account_id === "string") result.chatgpt_account_id = auth.chatgpt_account_id;
    if (typeof auth?.chatgpt_plan_type === "string") result.plan_type = auth.chatgpt_plan_type;
    return result;
  } catch { return {}; }
}

let readToken: () => OpenAIOAuthToken | undefined = () => undefined;
let writeToken: (token: OpenAIOAuthToken | undefined) => Promise<void> = async () => { throw new Error("OpenAI OAuth storage is not initialized"); };
let generation = 0;
/** Bumped when the storage is replaced: a refresh started on the old storage must not write to the new one. */
let storageEpoch = 0;
/** One refresh per account credential at a time: a refresh token is spent by its first use. */
const refreshes = new Map<string, { accessToken: string; promise: Promise<OpenAIOAuthToken> }>();
/** Every kept account by id. The current one is also the token `readToken` returns. */
export type OpenAIOAuthAccounts = Record<string, OpenAIOAuthToken>;
let readAccounts: (() => OpenAIOAuthAccounts) | undefined;
let writeAccounts: ((current: OpenAIOAuthToken | undefined, accounts: OpenAIOAuthAccounts) => Promise<void>) | undefined;
export function configureOAuthStorage(read: typeof readToken, write: typeof writeToken): void {
  generation++; storageEpoch++; sessions.clear(); refreshes.clear(); readToken = read; writeToken = write;
  readAccounts = writeAccounts = undefined;
}
/** Optional: without it only the current account is kept. `write` must persist the current slot and the table together. */
export function configureOAuthAccountStorage(read: NonNullable<typeof readAccounts>, write: NonNullable<typeof writeAccounts>): void { readAccounts = read; writeAccounts = write; }
export function oauthToken(): OpenAIOAuthToken | undefined { return readToken(); }
/** Stable id of a token's account. Logins without a ChatGPT account id fall back to the email, then "legacy". */
export function accountId(token: OpenAIOAuthToken): string {
  if (token.chatgpt_account_id) return token.chatgpt_account_id;
  const email = token.email?.trim().toLowerCase();
  return email ? `email:${email}` : "legacy";
}
/** The stored table with the current token laid over it, so a login from before the table existed is never lost. */
function table(): OpenAIOAuthAccounts {
  const accounts: OpenAIOAuthAccounts = Object.create(null);
  let stored: OpenAIOAuthAccounts = {};
  try { stored = readAccounts?.() ?? {}; } catch {}
  for (const [id, token] of Object.entries(stored)) accounts[id] = token;
  const current = readToken();
  if (current) accounts[accountId(current)] = current;
  return accounts;
}
async function persist(current: OpenAIOAuthToken | undefined, accounts: OpenAIOAuthAccounts): Promise<void> {
  if (writeAccounts) await writeAccounts(current, accounts); else await writeToken(current);
}
export function generateAuthUrl(): { auth_url: string; session_id: string } {
  const state = GenerateState(), codeVerifier = GenerateCodeVerifier(), session_id = GenerateSessionID();
  sessions.set(session_id, { state, codeVerifier, createdAt: Date.now() });
  return { auth_url: BuildAuthorizationURL(state, GenerateCodeChallenge(codeVerifier)), session_id };
}

async function requestToken(body: Record<string, string>, previous?: OpenAIOAuthToken): Promise<OpenAIOAuthToken> {
  let response: Response;
  try {
    response = await fetch(TokenURL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString() });
  } catch { throw new Error("OpenAI OAuth 网络请求失败"); }
  if (!response.ok) throw new Error(`OpenAI OAuth 请求失败 (HTTP ${response.status})`);
  let data: Record<string, unknown> | undefined;
  try { data = object(await response.json()); } catch { throw new Error("OpenAI OAuth 返回无效 JSON"); }
  if (!data || typeof data.access_token !== "string" || !data.access_token.trim() || typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 || !Number.isFinite(Date.now() + data.expires_in * 1000))
    throw new Error("OpenAI OAuth 返回无效 token");
  const identity = DecodeIDToken(data.id_token);
  return { access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : previous?.refresh_token ?? "",
    expires_at: Date.now() + data.expires_in * 1000,
    ...(identity.email !== undefined || previous?.email !== undefined ? { email: identity.email ?? previous?.email } : {}),
    ...(identity.chatgpt_account_id !== undefined || previous?.chatgpt_account_id !== undefined
      ? { chatgpt_account_id: identity.chatgpt_account_id ?? previous?.chatgpt_account_id } : {}),
    ...(identity.plan_type !== undefined || previous?.plan_type !== undefined ? { plan_type: identity.plan_type ?? previous?.plan_type } : {}) };
}

function pastedCode(raw: string, expectedState: string): string {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("OAuth callback URL 无效"); }
    const redirect = new URL(RedirectURI);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash ||
        url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1 ||
        !url.searchParams.get("code") || url.searchParams.get("state") !== expectedState) throw new Error("OAuth code/state 无效");
    return url.searchParams.get("code")!;
  }
  const [code, state, extra] = value.split("#");
  if (!code || extra !== undefined || (state !== undefined && state !== expectedState)) throw new Error("OAuth code/state 无效");
  return code;
}

export async function exchangeCode(input: { sessionId: string; code: string }): Promise<OpenAIOAuthToken> {
  if (!input || typeof input.sessionId !== "string" || typeof input.code !== "string") throw new Error("无效的 OAuth 参数");
  const session = sessions.get(input.sessionId);
  if (!session) throw new Error("OAuth 会话已失效，请重新登录");
  const code = pastedCode(input.code, session.state);
  sessions.delete(input.sessionId);
  const version = ++generation;
  const token = await requestToken({ code, grant_type: "authorization_code", client_id: ClientID, redirect_uri: RedirectURI,
    code_verifier: session.codeVerifier });
  if (version !== generation) throw new Error("OAuth 登录已取消");
  const accounts = table();
  accounts[accountId(token)] = token;
  await persist(token, accounts);
  return token;
}
export async function refreshToken(token: OpenAIOAuthToken): Promise<OpenAIOAuthToken> {
  if (!token.refresh_token) throw new Error("OpenAI OAuth 已过期，请重新登录");
  return requestToken({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: ClientID, scope: ScopeRefresh }, token);
}
/** Refresh one account and write the result to that account only; the current slot follows when it still is that account. */
function refreshAccount(id: string, token: OpenAIOAuthToken): Promise<OpenAIOAuthToken> {
  let slot = refreshes.get(id);
  if (!slot || slot.accessToken !== token.access_token) {
    const epoch = storageEpoch;
    const created: NonNullable<typeof slot> = { accessToken: token.access_token,
      promise: refreshToken(token).then(async next => {
        if (epoch !== storageEpoch) throw new Error("OAuth 登录已变更");
        const accounts = table();
        // Logged out, removed or logged in again meanwhile: this result belongs to nobody.
        if (accounts[id]?.access_token !== token.access_token) throw new Error("OAuth 登录已变更");
        const current = readToken();
        delete accounts[id];
        accounts[accountId(next)] = next;
        await persist(current && accountId(current) === id ? next : current, accounts);
        return next;
      }).finally(() => { if (refreshes.get(id) === created) refreshes.delete(id); }) };
    refreshes.set(id, created);
    slot = created;
  }
  return slot.promise;
}
export async function validOAuthToken(): Promise<OpenAIOAuthToken | undefined> {
  const token = readToken();
  if (!token) return undefined;
  if (token.expires_at > Date.now() + RefreshSkew) return token;
  const next = await refreshAccount(accountId(token), token);
  // Another account became current while this one refreshed: its token must not be used as the current one.
  if (readToken()?.access_token !== next.access_token) throw new Error("OAuth 登录已变更");
  return next;
}
/** A usable token for any kept account. Refreshing a non-current account never touches the current slot. */
export async function validAccountToken(id: string): Promise<OpenAIOAuthToken | undefined> {
  const token = table()[id];
  if (!token) return undefined;
  if (token.expires_at > Date.now() + RefreshSkew) return token;
  return refreshAccount(id, token);
}
/** Kept accounts, the current one first. No tokens. */
export function listAccounts(): { id: string; email?: string; plan_type?: string; active: boolean }[] {
  const current = readToken(), activeId = current ? accountId(current) : undefined;
  return Object.entries(table())
    .map(([id, token]) => ({ id, ...(token.email ? { email: token.email } : {}), ...(token.plan_type ? { plan_type: token.plan_type } : {}), active: id === activeId }))
    .sort((a, b) => Number(b.active) - Number(a.active));
}
export async function switchAccount(id: string): Promise<void> {
  const accounts = table(), target = typeof id === "string" ? accounts[id] : undefined;
  if (!target) throw new Error("找不到这个 ChatGPT 账号");
  const current = readToken();
  if (current && accountId(current) === id) return;
  await persist(target, accounts);
}
/** Log one account out. Removing the current one makes another current, if any is left. */
export async function removeAccount(id: string): Promise<void> {
  const accounts = table();
  if (typeof id !== "string" || !accounts[id]) return;
  const current = readToken();
  delete accounts[id];
  refreshes.delete(id);
  if (current && accountId(current) === id) {
    generation++; sessions.clear();
    await persist(Object.values(accounts)[0], accounts);
  } else await persist(current, accounts);
}
/** Log the current account out. */
export async function logout(): Promise<void> {
  const current = readToken();
  if (current) return removeAccount(accountId(current));
  generation++; sessions.clear(); await persist(undefined, table());
}
export async function loginStatus(): Promise<OpenAILogin> {
  try {
    const token = await validOAuthToken();
    return token ? { loggedIn: true, email: token.email, chatgpt_account_id: token.chatgpt_account_id, plan_type: token.plan_type }
      : { loggedIn: false };
  } catch {
    return { loggedIn: false, expired: true, error: "OpenAI OAuth 登录不可用，请重新登录" };
  }
}
