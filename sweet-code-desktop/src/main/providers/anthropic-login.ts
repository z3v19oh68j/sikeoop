import { validOAuthToken } from "./claude-oauth.ts";
import { loadConfig, loadCredentials } from "@anthropic-ai/sdk/core/credentials";
import type { AnthropicLogin } from "@shared/types";
import { findOnPath } from "../shell-env";

/** What the settings screen shows about the login. Never includes the token itself. */
export async function loginStatus(): Promise<AnthropicLogin> {
  const antInstalled = Boolean(findOnPath(process.platform === "win32" ? "ant.exe" : "ant"));
  try {
    const token = await validOAuthToken();
    if (token) return { loggedIn: true, antInstalled, account: token.org_uuid ?? token.account_uuid, email: token.email };
  } catch { /* Expired or unavailable OAuth: keep the existing CLI fallback. */ }
  try {
    const config = await loadConfig();
    // Only an interactive login counts; workload-identity setups are for servers, not this app.
    if (!config || config.authentication.type !== "user_oauth") return { loggedIn: false, antInstalled };
    const creds = await loadCredentials();
    if (!creds?.access_token) return { loggedIn: false, antInstalled };
    // Without a refresh token the access token can't be renewed once it runs out.
    const expired = !creds.refresh_token && creds.expires_at !== undefined && creds.expires_at * 1000 < Date.now();
    return {
      loggedIn: !expired,
      expired,
      antInstalled,
      account: creds.organization_name ?? creds.account_email,
      email: creds.account_email,
    };
  } catch (err) {
    return { loggedIn: false, antInstalled, error: (err as Error).message };
  }
}
