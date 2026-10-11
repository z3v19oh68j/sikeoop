import { loadConfig, loadCredentials } from "@anthropic-ai/sdk/core/credentials";
import type { AnthropicLogin } from "@shared/types";
import { findOnPath } from "../shell-env";

// "Log in with an Anthropic account" uses the official `ant` CLI: `ant auth login`
// opens the browser, the user signs in to the Anthropic Console, and the CLI stores
// an OAuth profile under ~/.config/anthropic (Windows: %APPDATA%\Anthropic). The SDK
// reads that profile itself and refreshes the token, so this app never sees a
// password or handles tokens. It is billed as API usage on that Console account;
// Claude Pro/Max subscriptions are not usable from third-party apps.

/** What the settings screen shows about the login. Never includes the token itself. */
export async function loginStatus(): Promise<AnthropicLogin> {
  const antInstalled = Boolean(findOnPath(process.platform === "win32" ? "ant.exe" : "ant"));
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
