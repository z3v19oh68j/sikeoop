import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuiltinHookView, HookEventName, HookOutcomeKind, HooksState, HookSourceView } from "@shared/types";
import { runHookCommand } from "./command";
import { type CommandHook, HookFiles, TrustStore, matches } from "./config";

// The hook bus: every point in the agent loop where something may step in (session start, each
// message, before and after each tool call, the end of a turn) goes through run(). Two kinds of
// hooks answer:
//   built-in — the app's own features (project rules, memory, code retrieval). Each is a module
//              imported the first time its event fires, so an unused feature costs nothing.
//   command  — shell commands the user configured (Claude Code compatible), read from their
//              files when an event fires and re-read only when a file changes.

export interface HookContext {
  root: string;
  sessionId: string;
  /** Per-conversation scratch space for built-in hooks (e.g. which memories were already shown). */
  state: Map<string, unknown>;
  autopilot: boolean;
  activeFile?: string;
  signal: AbortSignal;
}

export interface HookInput {
  /** UserPromptSubmit */
  prompt?: string;
  /** SessionStart: a new conversation, a reopened one, or context restored after compaction. */
  source?: "startup" | "resume" | "compact";
  /** PreToolUse / PostToolUse */
  tool_name?: string;
  tool_input?: unknown;
  /** PostToolUse */
  tool_response?: string;
  is_error?: boolean;
  /** Stop: the turn already continued because of a Stop hook. */
  stop_hook_active?: boolean;
}

export interface HookNotice {
  name: string;
  outcome: HookOutcomeKind;
  message: string;
  detail?: string;
}

export interface HookResult {
  /** Text for the model: added to the message, the session start or the tool result. */
  context: string[];
  /** UserPromptSubmit: refuse the message. PostToolUse: feedback. Stop: keep working, with this instruction. */
  block?: { reason: string; by: string };
  /** PreToolUse only. */
  permission?: { decision: "allow" | "deny" | "ask"; reason: string; by: string };
  notices: HookNotice[];
  /** How many command hooks ran (they may have changed files). */
  commands: number;
}

/** What a built-in hook returns: text for the model, and a line for the chat. */
export type BuiltinOutput = { context?: string; notice?: { message: string; detail?: string } } | null;
export type BuiltinHandler = (event: HookEventName, input: HookInput, ctx: HookContext) => Promise<BuiltinOutput>;

export interface BuiltinHook extends Omit<BuiltinHookView, "enabled"> {
  enabled(): boolean;
  /** Imported on first use. */
  load(): Promise<BuiltinHandler>;
}

/** A hook from outside the app's own features (mods): may also allow / deny a tool or block. */
export interface ExtraHook {
  name: string;
  run(
    input: HookInput,
    ctx: HookContext,
  ): Promise<{ context?: string; notice?: string; permission?: { decision: "allow" | "deny" | "ask"; reason: string }; block?: string } | void>;
}

const EMPTY = (): HookResult => ({ context: [], notices: [], commands: 0 });

export class HookBus {
  private files = new HookFiles();
  private loaded = new Map<string, Promise<BuiltinHandler>>();

  constructor(
    private readonly opts: {
      userFile: string;
      trust: TrustStore;
      builtins: BuiltinHook[];
      root(): string | null;
      /** Hooks registered for this event by mods. */
      extra?(event: HookEventName, toolName?: string): ExtraHook[];
    },
  ) {}

  /** Hooks files for the open project, in the order they run. */
  private projectFiles(root: string): { file: string; label: string }[] {
    return [
      { file: path.join(root, ".sweet", "hooks.json"), label: "项目 .sweet/hooks.json" },
      { file: path.join(root, ".claude", "settings.json"), label: "项目 .claude/settings.json（Claude Code）" },
    ];
  }

  /** Command hooks allowed to run right now. */
  private async commandHooks(): Promise<CommandHook[]> {
    const out: CommandHook[] = [];
    const user = await this.files.read(this.opts.userFile);
    for (const h of user?.hooks ?? []) out.push({ ...h, source: "user", file: this.opts.userFile });
    const root = this.opts.root();
    if (root) {
      for (const { file } of this.projectFiles(root)) {
        const p = await this.files.read(file);
        if (!p?.hooks.length || !(await this.opts.trust.isTrusted(file, p.hash))) continue;
        for (const h of p.hooks) out.push({ ...h, source: "project", file });
      }
    }
    return out;
  }

  async run(event: HookEventName, input: HookInput, ctx: HookContext): Promise<HookResult> {
    const builtins = this.opts.builtins.filter((b) => b.events.includes(event) && b.enabled());
    const commands = (await this.commandHooks()).filter(
      (h) => h.event === event && (!input.tool_name || matches(h.matcher, input.tool_name)),
    );
    const extra = this.opts.extra?.(event, input.tool_name) ?? [];
    if (!builtins.length && !commands.length && !extra.length) return EMPTY();

    const result = EMPTY();
    const [fromBuiltins, fromCommands, fromExtra] = await Promise.all([
      Promise.all(builtins.map((b) => this.runBuiltin(b, event, input, ctx))),
      Promise.all(commands.map((h) => this.runCommand(h, event, input, ctx))),
      Promise.all(extra.map((h) => this.runExtra(h, event, input, ctx))),
    ]);
    for (const r of [...fromBuiltins, ...fromCommands, ...fromExtra]) merge(result, r);
    result.commands = commands.length;
    return result;
  }

  private async runBuiltin(b: BuiltinHook, event: HookEventName, input: HookInput, ctx: HookContext): Promise<HookResult> {
    const out = EMPTY();
    try {
      if (!this.loaded.has(b.id)) this.loaded.set(b.id, b.load());
      const handler = await this.loaded.get(b.id)!;
      const r = await handler(event, input, ctx);
      if (r?.context) out.context.push(r.context);
      if (r?.notice) out.notices.push({ name: b.name, outcome: "context", ...r.notice });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      this.loaded.delete(b.id);
      out.notices.push({ name: b.name, outcome: "error", message: `出错了，已跳过：${(err as Error).message}` });
    }
    return out;
  }

  private async runExtra(h: ExtraHook, event: HookEventName, input: HookInput, ctx: HookContext): Promise<HookResult> {
    const out = EMPTY();
    try {
      const r = await h.run(input, ctx);
      if (!r) return out;
      if (r.context) out.context.push(wrap(h.name, r.context));
      if (r.notice) out.notices.push({ name: h.name, outcome: "context", message: r.notice });
      if (r.block) applyBlock(out, event, r.block, h.name);
      else if (r.permission && event === "PreToolUse") {
        if (r.permission.decision === "deny") applyBlock(out, event, r.permission.reason, h.name);
        else out.permission = { ...r.permission, by: h.name };
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      out.notices.push({ name: h.name, outcome: "error", message: `出错了，已跳过：${(err as Error).message}` });
    }
    return out;
  }

  private async runCommand(h: CommandHook, event: HookEventName, input: HookInput, ctx: HookContext): Promise<HookResult> {
    const out = EMPTY();
    const name = h.command.length > 48 ? `${h.command.slice(0, 48)}…` : h.command;
    const payload = {
      session_id: ctx.sessionId,
      hook_event_name: event,
      cwd: ctx.root,
      permission_mode: ctx.autopilot ? "autopilot" : "default",
      ...input,
    };
    const r = await runHookCommand(h.command, payload, { cwd: ctx.root, timeoutS: h.timeout, signal: ctx.signal });
    if (ctx.signal.aborted) return out;
    const stderr = r.stderr.trim();
    if (r.error || r.timedOut || (r.exitCode !== 0 && r.exitCode !== 2)) {
      const why = r.error ?? (r.timedOut ? `超过 ${h.timeout} 秒没结束，已停止` : `退出码 ${r.exitCode}`);
      out.notices.push({ name, outcome: "error", message: `Hook 运行失败（不影响继续）：${why}`, detail: stderr.slice(0, 2000) || undefined });
      return out;
    }

    // Exit 2: block, with stderr as the reason (Claude Code's convention).
    if (r.exitCode === 2) {
      const reason = stderr || "（Hook 没有说明原因）";
      applyBlock(out, event, reason, name);
      return out;
    }

    const text = r.stdout.trim();
    const json = text.startsWith("{") ? tryJson(text) : null;
    if (!json) {
      // Plain text on stdout is extra context where that makes sense.
      if (text && (event === "UserPromptSubmit" || event === "SessionStart")) {
        out.context.push(wrap(name, text));
        out.notices.push({ name, outcome: "context", message: "Hook 补充了一些信息给 AI", detail: text.slice(0, 2000) });
      }
      return out;
    }

    const hso = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const extra = str(hso.additionalContext) ?? str(json.additionalContext);
    if (extra) {
      out.context.push(wrap(name, extra));
      out.notices.push({ name, outcome: "context", message: "Hook 补充了一些信息给 AI", detail: extra.slice(0, 2000) });
    }
    if (str(json.systemMessage)) out.notices.push({ name, outcome: "context", message: str(json.systemMessage)! });

    if (event === "PreToolUse") {
      const pd = str(hso.permissionDecision) ?? (json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined);
      const reason = str(hso.permissionDecisionReason) ?? str(json.reason) ?? "";
      if (pd === "allow" || pd === "deny" || pd === "ask") {
        out.permission = { decision: pd, reason, by: name };
        const label = { allow: "直接放行", deny: "拦下了", ask: "要求你亲自确认" }[pd];
        out.notices.push({ name, outcome: pd === "allow" ? "allowed" : pd === "deny" ? "denied" : "ask", message: `Hook ${label}${reason ? `：${reason}` : ""}` });
      }
    }
    if (json.continue === false) applyBlock(out, event, str(json.stopReason) ?? "Hook 要求停下", name);
    else if (json.decision === "block" && event !== "PreToolUse") applyBlock(out, event, str(json.reason) ?? "（Hook 没有说明原因）", name);
    return out;
  }

  // ---- for the settings UI --------------------------------------------------------

  async state(): Promise<HooksState> {
    const sources: HookSourceView[] = [];
    const user = await this.files.read(this.opts.userFile);
    sources.push({
      kind: "user",
      label: "我的 Hooks（所有项目）",
      path: this.opts.userFile,
      exists: !!user,
      trusted: true,
      hooks: user?.hooks ?? [],
      error: user?.error,
    });
    const root = this.opts.root();
    if (root) {
      for (const { file, label } of this.projectFiles(root)) {
        const p = await this.files.read(file);
        if (!p) continue;
        // A Claude Code settings file without hooks is not worth listing.
        if (file.endsWith("settings.json") && !p.hooks.length && !p.error) continue;
        sources.push({
          kind: "project",
          label,
          path: file,
          exists: true,
          trusted: await this.opts.trust.isTrusted(file, p.hash),
          hooks: p.hooks,
          error: p.error,
        });
      }
    }
    const builtins = this.opts.builtins.map(({ id, name, description, events, enabled }) => ({ id, name, description, events, enabled: enabled() }));
    return { sources, builtins, hasProject: !!root };
  }

  async setTrusted(file: string, trusted: boolean): Promise<void> {
    const root = this.opts.root();
    if (!root || !this.projectFiles(root).some((f) => f.file === file)) throw new Error("只能信任当前项目里的 Hooks 文件");
    const p = await this.files.read(file);
    await this.opts.trust.set(file, trusted && p ? p.hash : null);
  }

  /** The project's .sweet/hooks.json, created with an empty config if missing. */
  async ensureProjectFile(): Promise<string> {
    const root = this.opts.root();
    if (!root) throw new Error("先打开一个项目");
    const file = this.projectFiles(root)[0].file;
    await ensureFile(file);
    return file;
  }

  async ensureUserFile(): Promise<string> {
    await ensureFile(this.opts.userFile);
    return this.opts.userFile;
  }
}

const TEMPLATE = `{
  "hooks": {
  }
}
`;

async function ensureFile(file: string) {
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, TEMPLATE, "utf8");
  }
}

function applyBlock(out: HookResult, event: HookEventName, reason: string, by: string) {
  switch (event) {
    case "PreToolUse":
      out.permission = { decision: "deny", reason, by };
      out.notices.push({ name: by, outcome: "denied", message: `Hook 拦下了这个操作：${reason}` });
      return;
    case "UserPromptSubmit":
      out.block = { reason, by };
      out.notices.push({ name: by, outcome: "blocked", message: `Hook 拦下了这条消息：${reason}` });
      return;
    case "PostToolUse":
      out.context.push(wrap(by, reason));
      out.notices.push({ name: by, outcome: "context", message: `Hook 给了反馈：${reason.slice(0, 200)}` });
      return;
    case "Stop":
      out.block = { reason, by };
      out.notices.push({ name: by, outcome: "continue", message: `Hook 要求接着做：${reason.slice(0, 200)}` });
      return;
    case "SessionStart":
      out.notices.push({ name: by, outcome: "error", message: `SessionStart 不能拦截：${reason.slice(0, 200)}` });
  }
}

function merge(into: HookResult, r: HookResult) {
  into.context.push(...r.context);
  into.notices.push(...r.notices);
  if (r.block && !into.block) into.block = r.block;
  if (r.permission) {
    const rank = { allow: 0, ask: 1, deny: 2 };
    if (!into.permission || rank[r.permission.decision] > rank[into.permission.decision]) into.permission = r.permission;
  }
}

function wrap(name: string, text: string): string {
  return `<hook_context source="${name.replace(/"/g, "'")}">\n${text}\n</hook_context>`;
}

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
