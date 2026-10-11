// uiohook-napi is one global native hook shared by the screenshot gesture and dictation: each
// user acquires it and releases it, and it only stops when nobody needs it any more.

export type Hook = typeof import("uiohook-napi").uIOhook;

let hook: Hook | null = null;
const users = new Set<string>();

/** Starts the hook for `who` (idempotent). Throws when the native module can't load or start. */
export function acquireHook(who: string): Hook {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hook ??= (require("uiohook-napi") as typeof import("uiohook-napi")).uIOhook;
  if (!users.size) hook.start();
  users.add(who);
  return hook;
}

export function releaseHook(who: string): void {
  if (!users.delete(who) || users.size || !hook) return;
  try {
    hook.stop();
  } catch {
    // Already stopped.
  }
}

/** The key code table (UiohookKey), loaded with the hook. */
export function hookKeys(): typeof import("uiohook-napi").UiohookKey {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("uiohook-napi") as typeof import("uiohook-napi")).UiohookKey;
}
