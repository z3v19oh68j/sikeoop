import path from "node:path";
import { pathToFileURL } from "node:url";

// CLI extensions: a coding CLI that sikeoop doesn't know (opencode, Cursor CLI, …) described by one
// JSON file, so it can run in a terminal tab as an agent session like Claude Code and Codex do.
// This file is the format: checking a definition, and turning it into a command line for one
// session. Pure (no Electron, no disk), so it runs under node --test. The format is documented for
// users in docs/cli-扩展开发文档.md; keep the two in step.

/** How sikeoop learns that the CLI finished a turn. */
export type TurnEnd = "hook" | "quiet";

export interface CliDefinition {
  /** Lowercase id, e.g. "opencode". Also what start_agent / the tab menu use. */
  id: string;
  /** Shown in menus: "opencode". */
  name: string;
  /** Session names are <label>-1, <label>-2…: letters and digits only. */
  label: string;
  description?: string;
  /** Executable names looked up on PATH, in order. */
  bin: string[];
  /** Extra places to look, "~" allowed. */
  paths?: string[];
  /** A shell command that installs it, typed into a terminal tab for the user to watch. */
  install?: string;
  args: unknown[];
  env?: Record<string, unknown>;
  /** Variables of sikeoop's own environment the CLI may see: exact names, or a prefix ending in "*". */
  envPassthrough?: string[];
  /** Files written into the session's own folder before the CLI starts. */
  files?: { path: string; content: unknown }[];
  turnEnd: TurnEnd;
  /** turnEnd "quiet": the turn is over after this long without output. */
  quietMs?: number;
  /** Lines shown above the terminal. */
  notes?: string[];
}

/** What one session's command line is built from. */
export interface LaunchContext {
  root: string;
  /** The session's name on the agent bus: OpenCode-1. */
  name: string;
  /** A folder of the session's own, for `files`. */
  sessionDir: string;
  hookUrl: string;
  mcpUrl: string;
  /** The stdio MCP server that reaches the bus: an executable and its arguments. */
  mcpCommand: string[];
  mcpEnv: Record<string, string>;
  /** Who the session is and how to reach the others, for the CLI's system prompt. */
  instructions: string;
}

export const RESERVED_IDS = ["claude", "codex", "shell"];
export const DEFAULT_QUIET_MS = 8000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Checks a parsed JSON file. Every problem is listed, in words the file's author can act on. */
export function parseDefinition(raw: unknown): { ok: true; def: CliDefinition } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ["文件内容必须是一个 JSON 对象"] };
  const r = raw;

  if (!isText(r.id) || !/^[a-z][a-z0-9-]{1,23}$/.test(r.id)) problems.push("id：必填，2–24 位，小写字母开头，只能有小写字母、数字和 -");
  else if (RESERVED_IDS.includes(r.id)) problems.push(`id：${r.id} 是内置的，换一个`);
  if (!isText(r.name) || r.name.length > 40) problems.push("name：必填，显示在菜单里的名字，最多 40 个字");
  if (!isText(r.label) || !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(r.label)) problems.push("label：必填，会话名前缀（如 OpenCode，会话叫 OpenCode-1），只能有字母和数字，最多 16 位");
  else if (/^(claude|codex)$/i.test(r.label)) problems.push("label：不能用 Claude 或 Codex，会和内置会话重名");
  if (r.description !== undefined && typeof r.description !== "string") problems.push("description：必须是字符串");
  if (!Array.isArray(r.bin) || !r.bin.length || !r.bin.every((b) => isText(b) && !/[\\/]/.test(b))) problems.push("bin：必填，可执行文件名的数组（不带路径），如 [\"opencode\"]");
  if (r.paths !== undefined && !(Array.isArray(r.paths) && r.paths.every(isText))) problems.push("paths：必须是路径字符串的数组");
  if (r.install !== undefined && !isText(r.install)) problems.push("install：必须是一条 shell 命令");
  if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === "string"))) problems.push("args：必须是字符串数组");
  if (r.env !== undefined && !(isRecord(r.env) && Object.values(r.env).every((v) => typeof v === "string" || (isRecord(v) && "json" in v)))) {
    problems.push("env：每个值必须是字符串，或 { \"json\": … }");
  }
  if (r.envPassthrough !== undefined && !(Array.isArray(r.envPassthrough) && r.envPassthrough.every(isText))) problems.push("envPassthrough：必须是变量名的数组");
  if (r.files !== undefined) {
    if (!Array.isArray(r.files)) problems.push("files：必须是数组");
    else {
      r.files.forEach((f, i) => {
        if (!isRecord(f) || !isText(f.path)) return void problems.push(`files[${i}].path：必填`);
        if (!insideSession(f.path)) problems.push(`files[${i}].path：只能写在会话自己的目录里，用相对路径，不能有 ..`);
        if (!(typeof f.content === "string" || (isRecord(f.content) && "json" in f.content))) problems.push(`files[${i}].content：必须是字符串，或 { "json": … }`);
      });
    }
  }
  if (r.turnEnd !== "hook" && r.turnEnd !== "quiet") problems.push("turnEnd：必填，\"hook\"（CLI 自己上报）或 \"quiet\"（按终端安静时间判断）");
  if (r.quietMs !== undefined && !(typeof r.quietMs === "number" && r.quietMs >= 1000 && r.quietMs <= 600_000)) problems.push("quietMs：1000 到 600000 之间的毫秒数");
  if (r.notes !== undefined && !(Array.isArray(r.notes) && r.notes.every((n) => typeof n === "string"))) problems.push("notes：必须是字符串数组");

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    def: {
      id: r.id as string,
      name: (r.name as string).trim(),
      label: r.label as string,
      description: r.description as string | undefined,
      bin: r.bin as string[],
      paths: r.paths as string[] | undefined,
      install: r.install as string | undefined,
      args: (r.args as unknown[] | undefined) ?? [],
      env: r.env as Record<string, unknown> | undefined,
      envPassthrough: r.envPassthrough as string[] | undefined,
      files: r.files as CliDefinition["files"],
      turnEnd: r.turnEnd as TurnEnd,
      quietMs: r.quietMs as number | undefined,
      notes: r.notes as string[] | undefined,
    },
  };
}

/** A file path that stays in the session's folder. */
function insideSession(p: string): boolean {
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** The values placeholders stand for. Arrays and objects keep their shape when a placeholder is the whole string. */
export function placeholders(ctx: LaunchContext): Record<string, unknown> {
  return {
    root: ctx.root,
    name: ctx.name,
    sessionDir: ctx.sessionDir,
    sessionDirUrl: pathToFileURL(ctx.sessionDir).href,
    hookUrl: ctx.hookUrl,
    mcpUrl: ctx.mcpUrl,
    mcpCommand: ctx.mcpCommand,
    mcpBin: ctx.mcpCommand[0],
    mcpArgs: ctx.mcpCommand.slice(1),
    mcpEnv: ctx.mcpEnv,
    instructions: ctx.instructions,
  };
}

const TOKEN = /\{(json:)?([A-Za-z]+)\}/g;

/**
 * Fills placeholders in a string, or in every string inside an array / object.
 * - "{root}" inside a longer string: the value as text (arrays and objects as JSON)
 * - a string that is exactly one placeholder: the value itself, so "{mcpCommand}" becomes an array
 * - "{json:name}": the value as JSON, quotes included, for dropping into code or a config file
 * Braces that aren't a known placeholder are left alone (file contents are often code).
 */
export function expand(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{([A-Za-z]+)\}$/.exec(value);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return value.replace(TOKEN, (m, json: string | undefined, key: string) => {
      if (!(key in vars)) return m;
      const v = vars[key];
      return json || typeof v !== "string" ? JSON.stringify(v) : v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}

/** A string, or { json } serialized after its placeholders were filled. */
function text(value: unknown, vars: Record<string, unknown>, pretty: boolean): string {
  if (isRecord(value) && "json" in value) return JSON.stringify(expand(value.json, vars), null, pretty ? 2 : undefined);
  const v = expand(value, vars);
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** One session's command line, environment and files, from the definition. Nothing is written here. */
export function planLaunch(def: CliDefinition, ctx: LaunchContext): { args: string[]; env: Record<string, string>; files: { path: string; content: string }[] } {
  const vars = placeholders(ctx);
  const args: string[] = [];
  for (const a of def.args) {
    const v = expand(a, vars);
    // "{mcpArgs}" on its own is several arguments, not one.
    if (Array.isArray(v)) args.push(...v.map(String));
    else args.push(typeof v === "string" ? v : JSON.stringify(v));
  }
  const env = Object.fromEntries(Object.entries(def.env ?? {}).map(([k, v]) => [k, text(v, vars, false)]));
  const files = (def.files ?? []).map((f) => {
    const rel = String(expand(f.path, vars));
    if (!insideSession(rel)) throw new Error(`files 里的路径跑出了会话目录：${rel}`);
    return { path: path.join(ctx.sessionDir, rel), content: text(f.content, vars, true) };
  });
  return { args, env, files };
}

/** Which of sikeoop's own variables the CLI gets, from envPassthrough (exact names, or "PREFIX_*"). */
export function passthrough(def: CliDefinition): { keys: string[]; prefixes: string[] } {
  const list = def.envPassthrough ?? [];
  return { keys: list.filter((k) => !k.endsWith("*")), prefixes: list.filter((k) => k.endsWith("*")).map((k) => k.slice(0, -1)) };
}
