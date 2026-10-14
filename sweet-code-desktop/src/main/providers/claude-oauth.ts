import { randomBytes, createHash } from "node:crypto";

export const ClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AuthorizeURL = "https://claude.com/cai/oauth/authorize";
export const TokenURL = "https://platform.claude.com/v1/oauth/token";
export const RedirectURI = "https://platform.claude.com/oauth/code/callback";
export const ScopeOAuth = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const ScopeInference = "user:inference";
export const SessionTTL = 30 * 60 * 1000;
export const GenerateState = () => randomBytes(32).toString("base64url");
export const GenerateSessionID = () => randomBytes(16).toString("hex");
export const GenerateCodeVerifier = () => randomBytes(32).toString("base64url");
export const GenerateCodeChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export function BuildAuthorizationURL(state: string, challenge: string, scope: string): string {
  return `${AuthorizeURL}?${new URLSearchParams({ code: "true", client_id: ClientID, response_type: "code", redirect_uri: RedirectURI, scope, code_challenge: challenge, code_challenge_method: "S256", state })}`;
}
export interface OAuthSession { state: string; codeVerifier: string; scope: string; createdAt: number }
export class SessionStore {
  private sessions = new Map<string, OAuthSession>();
  set(id: string, session: OAuthSession): void { this.cleanup(); this.sessions.set(id, session); }
  get(id: string): OAuthSession | undefined { this.cleanup(); return this.sessions.get(id); }
  delete(id: string): void { this.sessions.delete(id); }
  clear(): void { this.sessions.clear(); }
  private cleanup(): void { for (const [id, s] of this.sessions) if (Date.now() - s.createdAt >= SessionTTL) this.sessions.delete(id); }
}
const sessions = new SessionStore();
export interface ClaudeOAuthToken {
  access_token: string; refresh_token: string; expires_at: number;
  org_uuid?: string; account_uuid?: string; email?: string;
}
let readToken: () => ClaudeOAuthToken | undefined = () => undefined;
let writeToken: (token: ClaudeOAuthToken | undefined) => Promise<void> = async () => { throw new Error("OAuth storage is not initialized"); };
/** Every kept account by id. The current one is also the token `readToken` returns. */
export type ClaudeOAuthAccounts = Record<string, ClaudeOAuthToken>;
let readAccounts: (() => ClaudeOAuthAccounts) | undefined;
let writeAccounts: ((current: ClaudeOAuthToken | undefined, accounts: ClaudeOAuthAccounts) => Promise<void>) | undefined;
export function configureOAuthStorage(read: typeof readToken, write: typeof writeToken): void { readToken = read; writeToken = write; readAccounts = writeAccounts = undefined; }
/** Optional: without it only the current account is kept. `write` must persist the current slot and the table together. */
export function configureOAuthAccountStorage(read: NonNullable<typeof readAccounts>, write: NonNullable<typeof writeAccounts>): void { readAccounts = read; writeAccounts = write; }
export function oauthToken(): ClaudeOAuthToken | undefined { return readToken(); }
/** Stable id of a token's account. Logins from before account ids were stored fall back to the email, then "legacy". */
export function accountId(token: ClaudeOAuthToken): string {
  if (token.account_uuid) return token.account_uuid;
  const email = token.email?.trim().toLowerCase();
  return email ? `email:${email}` : "legacy";
}
/** The stored table with the current token laid over it, so a login from before the table existed is never lost. */
function table(): ClaudeOAuthAccounts {
  const accounts: ClaudeOAuthAccounts = Object.create(null);
  let stored: ClaudeOAuthAccounts = {};
  try { stored = readAccounts?.() ?? {}; } catch {}
  for (const [id, token] of Object.entries(stored)) accounts[id] = token;
  const current = readToken();
  if (current) accounts[accountId(current)] = current;
  return accounts;
}
async function persist(current: ClaudeOAuthToken | undefined, accounts: ClaudeOAuthAccounts): Promise<void> {
  if (writeAccounts) await writeAccounts(current, accounts); else await writeToken(current);
}
export function generateAuthUrl(scope: "full" | "inference" = "full"): { auth_url: string; session_id: string } {
  if (scope !== "full" && scope !== "inference") throw new Error("无效的 OAuth scope");
  const state = GenerateState(), codeVerifier = GenerateCodeVerifier(), session_id = GenerateSessionID();
  const resolved = scope === "full" ? ScopeOAuth : ScopeInference;
  sessions.set(session_id, { state, codeVerifier, scope: resolved, createdAt: Date.now() });
  return { auth_url: BuildAuthorizationURL(state, GenerateCodeChallenge(codeVerifier), resolved), session_id };
}
async function requestToken(body: Record<string, string>, previous?: ClaudeOAuthToken): Promise<ClaudeOAuthToken> {
  let response: Response;
  try {
    response = await fetch(TokenURL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000), headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "User-Agent": "axios/1.13.6" }, body: JSON.stringify(body) });
  } catch { throw new Error("Claude OAuth 网络请求失败"); }
  if (!response.ok) throw new Error(`Claude OAuth 请求失败 (HTTP ${response.status})`);
  let data: { access_token?: string; refresh_token?: string; expires_in?: number; organization?: { uuid?: string }; account?: { uuid?: string; email_address?: string } };
  try { data = await response.json(); } catch { throw new Error("Claude OAuth 返回无效 JSON"); }
  if (!data || typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Claude OAuth 返回无效 token");
  return { access_token: data.access_token, refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh_token ?? "", expires_at: Date.now() + data.expires_in * 1000, org_uuid: data.organization?.uuid ?? previous?.org_uuid, account_uuid: data.account?.uuid ?? previous?.account_uuid, email: data.account?.email_address ?? previous?.email };
}
let generation = 0;
export async function exchangeCode(input: { sessionId: string; code: string }): Promise<ClaudeOAuthToken> {
  if (!input || typeof input.sessionId !== "string" || typeof input.code !== "string") throw new Error("无效的 OAuth 参数");
  const session = sessions.get(input.sessionId);
  if (!session) throw new Error("OAuth 会话已失效，请重新登录");
  const [code, state, extra] = input.code.trim().split("#");
  if (!code || extra !== undefined || (state !== undefined && state !== session.state)) throw new Error("OAuth code/state 无效");
  sessions.delete(input.sessionId);
  const version = ++generation;
  const token = await requestToken({ code, grant_type: "authorization_code", client_id: ClientID, redirect_uri: RedirectURI, code_verifier: session.codeVerifier, ...(state ? { state } : {}) });
  if (version !== generation) throw new Error("OAuth 登录已取消");
  const accounts = table();
  accounts[accountId(token)] = token;
  await persist(token, accounts);
  return token;
}
export async function refreshToken(token: ClaudeOAuthToken): Promise<ClaudeOAuthToken> {
  if (!token.refresh_token) throw new Error("Claude OAuth 已过期，请重新登录");
  return requestToken({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: ClientID }, token);
}
const FRESH = 3 * 60_000;
/** One refresh per account at a time: a refresh token is spent by its first use. */
const refreshes = new Map<string, Promise<ClaudeOAuthToken>>();
/** Refresh one account and write the result to that account only; the current slot follows when it still is that account. */
function refreshAccount(id: string, token: ClaudeOAuthToken): Promise<ClaudeOAuthToken> {
  let pending = refreshes.get(id);
  if (!pending) {
    pending = refreshToken(token).then(async next => {
      const accounts = table();
      // Logged out, removed or logged in again meanwhile: this result belongs to nobody.
      if (accounts[id]?.access_token !== token.access_token) throw new Error("OAuth 登录已变更");
      const current = readToken();
      delete accounts[id];
      accounts[accountId(next)] = next;
      await persist(current && accountId(current) === id ? next : current, accounts);
      return next;
    }).finally(() => { refreshes.delete(id); });
    refreshes.set(id, pending);
  }
  return pending;
}
export async function validOAuthToken(): Promise<ClaudeOAuthToken | undefined> {
  const token = readToken();
  if (!token) return undefined;
  if (token.expires_at > Date.now() + FRESH) return token;
  const next = await refreshAccount(accountId(token), token);
  // Another account became current while this one refreshed: its token must not be used as the current one.
  if (readToken()?.access_token !== next.access_token) throw new Error("OAuth 登录已变更");
  return next;
}
/** A usable token for any kept account. Refreshing a non-current account never touches the current slot. */
export async function validAccountToken(id: string): Promise<ClaudeOAuthToken | undefined> {
  const token = table()[id];
  if (!token) return undefined;
  if (token.expires_at > Date.now() + FRESH) return token;
  return refreshAccount(id, token);
}
/** Kept accounts, the current one first. No tokens. */
export function listAccounts(): { id: string; email?: string; active: boolean }[] {
  const current = readToken(), activeId = current ? accountId(current) : undefined;
  return Object.entries(table())
    .map(([id, token]) => ({ id, ...(token.email ? { email: token.email } : {}), active: id === activeId }))
    .sort((a, b) => Number(b.active) - Number(a.active));
}
export async function switchAccount(id: string): Promise<void> {
  const accounts = table(), target = typeof id === "string" ? accounts[id] : undefined;
  if (!target) throw new Error("找不到这个 Claude 账号");
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
