import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HookEntryView, HookEventName, HookSourceView } from "@shared/types";

// Where command hooks come from, and whether they may run.
//   user:    <userData>/hooks.json — written by the user, always trusted.
//   project: <project>/.sweet/hooks.json and the "hooks" of <project>/.claude/settings.json —
//            they arrive with a downloaded project, so they run only after the user approved
//            that exact file content (any edit needs approval again).
// Both the simple format and Claude Code's nested format are accepted:
//   { "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "…", "timeout": 30 }] } }
//   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…" }] }] } }

export const EVENTS: HookEventName[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

export interface CommandHook extends HookEntryView {
  source: HookSourceView["kind"];
  file: string;
}

interface Parsed {
  hooks: HookEntryView[];
  error?: string;
  /** sha256 of the file content, for trust. */
  hash: string;
}

/** Reads hooks files once per change (by modification time). */
export class HookFiles {
  private cache = new Map<string, { mtime: number; parsed: Parsed | null }>();

  async read(file: string): Promise<Parsed | null> {
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const hit = this.cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.parsed;
    let parsed: Parsed | null;
    try {
      const text = await fs.readFile(file, "utf8");
      parsed = { ...parse(text), hash: createHash("sha256").update(text).digest("hex") };
    } catch (err) {
      parsed = { hooks: [], hash: "", error: (err as Error).message };
    }
    this.cache.set(file, { mtime: st.mtimeMs, parsed });
    return parsed;
  }
}

export function parse(text: string): { hooks: HookEntryView[]; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { hooks: [], error: `不是合法的 JSON：${(err as Error).message}` };
  }
  const root = (json as { hooks?: unknown })?.hooks;
  if (root === undefined) return { hooks: [] };
  if (!root || typeof root !== "object") return { hooks: [], error: "\"hooks\" 应该是一个对象" };
  const out: HookEntryView[] = [];
  const unknown: string[] = [];
  for (const [event, groups] of Object.entries(root as Record<string, unknown>)) {
    if (!EVENTS.includes(event as HookEventName)) {
      unknown.push(event);
      continue;
    }
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== "object") continue;
      const group = g as { matcher?: unknown; command?: unknown; timeout?: unknown; hooks?: unknown };
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      const inner = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const h of inner) {
        const hook = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if (typeof hook.command !== "string" || !hook.command.trim()) continue;
        if (hook.type !== undefined && hook.type !== "command") continue;
        const timeout = typeof hook.timeout === "number" && hook.timeout > 0 ? Math.min(hook.timeout, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S;
        out.push({ event: event as HookEventName, matcher, command: hook.command, timeout });
      }
    }
  }
  return { hooks: out, error: unknown.length ? `不认识的事件：${unknown.join("、")}（可用：${EVENTS.join("、")}）` : undefined };
}

/** Which project hooks files the user approved, by path and content hash. */
export class TrustStore {
  private trusted: Record<string, string> | null = null;

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, string>> {
    if (this.trusted) return this.trusted;
    try {
      this.trusted = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.trusted = {};
    }
    return this.trusted!;
  }

  async isTrusted(file: string, hash: string): Promise<boolean> {
    return !!hash && (await this.load())[file] === hash;
  }

  async set(file: string, hash: string | null): Promise<void> {
    const t = { ...(await this.load()) };
    if (hash) t[file] = hash;
    else delete t[file];
    this.trusted = t;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(t, null, 2), "utf8");
  }
}

/** Tool names as Claude Code calls them, so matchers written for it ("Bash", "Edit|Write") work here. */
export const CLAUDE_TOOL_NAMES: Record<string, string> = {
  run_command: "Bash",
  edit_file: "Edit",
  create_file: "Write",
  read_file: "Read",
  list_files: "Glob",
  search: "Grep",
  search_code: "Grep",
  view_image: "Read",
};

export function matches(matcher: string, tool: string): boolean {
  const m = matcher.trim();
  if (!m || m === "*") return true;
  const names = [tool, CLAUDE_TOOL_NAMES[tool]].filter(Boolean) as string[];
  try {
    const re = new RegExp(`^(?:${m})$`);
    return names.some((n) => re.test(n));
  } catch {
    return names.includes(m);
  }
}
