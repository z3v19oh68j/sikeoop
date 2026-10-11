// What an extension CLI tells sikeoop, and what sikeoop answers. The CLI (a plugin or hook script
// of it) POSTs JSON to the session's hookUrl:
//   { "event": "ready" }                              started, can take a prompt
//   { "event": "turn-start" }                         began working on a prompt
//   { "event": "turn-end", "text": "its last reply" } finished the turn
//   { "event": "waiting", "text": "why" }             needs the user (a permission prompt)
//   { "event": "tool", "tool": "edit", "write": true, "file": "/abs/or/relative", "cwd": "…" }
//                                                     about to use a tool; answered with
//   { "decision": "allow" } or { "decision": "deny", "reason": "…" }
// Inside, PeerBus speaks Claude Code's hook dialect; this is the translation, kept pure for tests.

export type NeutralEvent = "ready" | "turn-start" | "turn-end" | "waiting" | "tool";

const EVENTS: Record<NeutralEvent, string> = {
  ready: "Ready",
  "turn-start": "UserPromptSubmit",
  "turn-end": "Stop",
  waiting: "Notification",
  tool: "PreToolUse",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The hook body in PeerBus's own terms, or null when it isn't a neutral event (Claude Code's and Codex's own bodies pass through untouched). */
export function fromNeutral(body: Record<string, unknown>): Record<string, unknown> | null {
  const event = body.event;
  if (typeof event !== "string" || !(event in EVENTS)) return null;
  const name = EVENTS[event as NeutralEvent];
  const text = str(body.text);
  if (event === "turn-end") return { hook_event_name: name, last_assistant_message: text ?? "" };
  if (event === "waiting") return { hook_event_name: name, message: text ?? "在等你" };
  if (event !== "tool") return { hook_event_name: name };
  const file = str(body.file);
  // A write is checked like Claude Code's Write: the file's lock, and the job's file ownership.
  return {
    hook_event_name: name,
    tool_name: body.write === true ? "Write" : (str(body.tool) ?? "tool"),
    tool_input: { ...(file ? { file_path: file } : {}), ...(str(body.command) ? { command: body.command } : {}) },
    ...(str(body.cwd) ? { cwd: body.cwd } : {}),
  };
}

/** PeerBus's answer to a hook, as the neutral reply. */
export function toNeutral(answer: unknown): { decision: "allow" } | { decision: "deny"; reason: string } {
  const out = (answer as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null)?.hookSpecificOutput;
  return out?.permissionDecision === "deny" ? { decision: "deny", reason: out.permissionDecisionReason ?? "sikeoop 拒绝了这次操作" } : { decision: "allow" };
}
