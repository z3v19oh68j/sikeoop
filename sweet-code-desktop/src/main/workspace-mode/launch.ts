import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalRoots } from "../session/scope";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashEnv, findGitBash, findOnPath } from "../shell-env";
import { LEAD_PROMPT, type TeamAgent, type WorkspaceConfig, initConfig, loadConfig, loadTeam } from "./config";

// Starts Claude Code in the project folder with sikeoop's workspace rules: a settings file
// with the .sikeoop permission rules (bypass and auto mode switched off, file tools fenced to
// the workspace), the .sikeoop agent team, and an environment narrowed to what it needs.
// This is a rule boundary, not an OS sandbox: a command the user approves still runs with the
// user's own rights.

const isWin = process.platform === "win32";

export interface LaunchSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Shown in the terminal before Claude Code starts. */
  banner: string[];
}

/** Variables every session gets when they're set: system paths, locale, proxy, Claude's own. */
const SAFE_ENV = [
  "PATH", "Path", "PATHEXT", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];
/** Prefixes for Claude Code's own configuration and credentials. */
const SAFE_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "AWS_BEARER_TOKEN_BEDROCK"];

/**
 * Markers a running Claude Code sets for its own child processes. When sikeoop itself was
 * started from Claude Code they would make the new session think it's a child (no saved
 * transcript), so they never pass on.
 */
export function isSessionMarker(key: string): boolean {
  return (
    /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT)$/.test(key) ||
    /^CLAUDE_(PLUGIN_|AGENT_SDK_)/.test(key) ||
    /^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SSE_PORT|SESSION_|EXECPATH|MESSAGING_)/.test(key)
  );
}

/** Windows' command line is capped at 32767 characters; keep well under it. */
const MAX_ARGS_CHARS = 24_000;

export type AgentCli = "claude" | "codex";

/** The CLI isn't installed; the UI offers the one-click install. */
export class CliNotFound extends Error {}

/** Shell commands (run in Git Bash on Windows) that install each CLI with its official method. */
export function installCommand(cli: AgentCli): string {
  if (cli === "codex") return "npm install -g @openai/codex";
  return isWin
    ? 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
    : "curl -fsSL https://claude.ai/install.sh | bash";
}

/** What sikeoop's agent bus adds to a launch: its MCP server and status reporting. */
export interface PeerLink {
  /** Session id: keeps each session's settings file apart. */
  id: string;
  name: string;
  /** Claude Code: hooks and allowed tools merged into --settings, and the MCP server config. */
  claude: { hooks: Record<string, unknown>; allow: string[]; mcp: { command: string; args: string[]; env: Record<string, string> } };
  /** Codex: -c overrides. */
  codexArgs: string[];
}

export async function buildAgentLaunch(cli: AgentCli, root: string, cacheDir: string, peer?: PeerLink): Promise<LaunchSpec> {
  return cli === "codex" ? buildCodexLaunch(root, peer) : buildLaunch(root, cacheDir, peer);
}

/** Dedicated multi-project launch. Existing single-project launches retain their policy. */
export async function buildSessionLaunch(cli: AgentCli, inputRoots: string[], cacheDir: string, peer: PeerLink): Promise<LaunchSpec> {
  const roots = await canonicalRoots(inputRoots);
  if (roots.length < 2) throw new Error("跨项目 session 至少需要两个不同目录");
  if (cli === "codex") {
    const exe = findCodex();
    if (!exe) throw new CliNotFound("没有找到 Codex，请先安装");
    // Probe this executable, rather than assuming an option from a different CLI version.
    const { stdout } = await promisify(execFile)(exe.file, [...exe.args, "--help"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const extra = /--add-dir\b/.test(stdout)
      ? roots.slice(1).flatMap((root) => ["--add-dir", root])
      : ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`];
    const spec = await buildCodexLaunch(roots[0], peer);
    const approval = spec.args.indexOf("--ask-for-approval");
    spec.args[approval + 1] = "never";
    spec.args.push(...extra);
    spec.banner = ["跨项目 session：Codex 只限制写入勾选目录；读取不隔离。越权不弹批准。", peerBanner(peer.name, roots)];
    return spec;
  }
  const exe = findClaude();
  if (!exe) throw new CliNotFound("没有找到 Claude Code，请先安装");
  const gitBash = isWin ? findGitBash() : null;
  if (isWin && !gitBash) throw new Error("Claude Code 需要 Git for Windows");
  const settingsFile = path.join(cacheDir, `session-${peer.id}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify({
    permissions: { allow: peer.claude.allow, disableBypassPermissionsMode: "disable", disableAutoMode: "disable", blockReadsOutsideWorkingDirectories: true },
    hooks: peer.claude.hooks,
  }), "utf8");
  return {
    file: exe.file,
    args: [...exe.args, "--settings", settingsFile, "--permission-mode", "default", "--add-dir", ...roots.slice(1),
      "--mcp-config", JSON.stringify({ mcpServers: { sikeoop: { type: "stdio", ...peer.claude.mcp } } }),
      "--append-system-prompt", `你在跨项目 session 中，只能操作以下目录：${roots.join("、")}。shell 命令无法安全检查路径，禁止运行；使用文件工具。任务完成直接结束这一轮，回复由主进程加入时间线。`],
    env: { ...narrowEnv(process.env, []), ...bashEnv(), ...(gitBash ? { CLAUDE_CODE_GIT_BASH_PATH: gitBash } : {}) },
    banner: ["跨项目 session：Claude 文件工具由 realpath hook 检查目录与全局锁；shell 禁用。", peerBanner(peer.name, roots)],
  };
}

/**
 * Codex in workspace mode: its own sandbox limited to the project folder (workspace-write;
 * an OS sandbox on macOS and Linux, experimental on Windows) and approval when it wants more.
 */
async function buildCodexLaunch(root: string, peer?: PeerLink): Promise<LaunchSpec> {
  const exe = findCodex();
  if (!exe) throw new CliNotFound("没有找到 Codex。点下面的「一键安装」，装好后再启动。");
  const gitBash = isWin ? findGitBash() : null;
  return {
    file: exe.file,
    args: [...exe.args, "--cd", root, "--sandbox", "workspace-write", "--ask-for-approval", "on-request", ...(peer?.codexArgs ?? [])],
    env: { ...narrowEnv(process.env, [], ["OPENAI_", "CODEX_"]), ...bashEnv(), ...(gitBash ? { SHELL: gitBash } : {}) },
    banner: [
      "工作区模式：Codex 运行在它自己的沙盒里，只能写这个文件夹" +
        (isWin ? "（Windows 上的沙盒还是实验功能，隔离不如 Mac 可靠）" : "") +
        "；需要更多权限时会先问你。",
      ...(peer ? [peerBanner(peer.name)] : []),
    ],
  };
}

const peerBanner = (name: string, roots?: string[]) => `这个会话叫 ${name}：可以用 sikeoop 的 list_peers / send_to 工具和${roots ? `本 session（${roots.join("、")}）` : "其他终端"}里的 AI 互相发消息。`;

export async function buildLaunch(root: string, cacheDir: string, peer?: PeerLink): Promise<LaunchSpec> {
  const exe = findClaude();
  if (!exe) throw new CliNotFound("没有找到 Claude Code。点下面的「一键安装」，装好后再启动。");
  const gitBash = isWin ? findGitBash() : null;
  if (isWin && !gitBash) throw new Error("Claude Code 在 Windows 上需要 Git for Windows（https://git-scm.com/download/win），请先安装。");

  const banner: string[] = [];
  const created = await initConfig(root);
  if (created.length) banner.push(`已创建工作区配置：${created.join("、")}`);
  const { config } = await loadConfig(root);
  const { agents, problems } = config.team ? await loadTeam(root) : { agents: [], problems: [] };
  banner.push(...problems.map((p) => `跳过了有问题的团队文件：${p}`));

  // One settings file per session: each carries its own hook address.
  const settingsFile = path.join(cacheDir, createHash("sha256").update(root).digest("hex").slice(0, 16), peer ? `settings-${peer.id}.json` : "settings.json");
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const settings = settingsFor(config);
  if (peer) {
    settings.permissions.allow = [...settings.permissions.allow, ...peer.claude.allow];
    Object.assign(settings, { hooks: peer.claude.hooks });
  }
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");

  const args = ["--settings", settingsFile, "--permission-mode", config.permissionMode];
  if (peer) args.push("--mcp-config", JSON.stringify({ mcpServers: { sikeoop: { type: "stdio", ...peer.claude.mcp } } }));
  if (agents.length) {
    args.push("--agents", JSON.stringify(agentsJson(agents)), "--append-system-prompt", LEAD_PROMPT);
  }
  if (args.join(" ").length > MAX_ARGS_CHARS) throw new Error("团队定义太长了，请精简 .sikeoop/agents 里的提示词");

  if (peer) banner.push(peerBanner(peer.name));
  banner.push(
    (config.permissionMode === "auto"
      ? `工作区模式（auto）：Claude Code 只能直接读写这个文件夹，由它自己判断能不能做，不再逐条问你；deny / ask 规则照旧生效。`
      : `工作区模式：Claude Code 只能直接读写这个文件夹；它要运行的命令会先问你，批准前请看清楚。`) +
      (agents.length ? `团队：${agents.map((a) => a.name).join("、")}。` : ""),
  );
  return {
    file: exe.file,
    args: [...exe.args, ...args],
    env: { ...narrowEnv(process.env, config.envPassthrough), ...bashEnv(), ...(gitBash ? { CLAUDE_CODE_GIT_BASH_PATH: gitBash } : {}) },
    banner,
  };
}

/** The --settings content: the workspace rules, with bypass switched off; auto stays off unless the project chose it. */
export function settingsFor(config: WorkspaceConfig) {
  return {
    permissions: {
      deny: config.deny,
      ask: config.ask,
      allow: config.allow,
      disableBypassPermissionsMode: "disable",
      ...(config.permissionMode === "auto" ? {} : { disableAutoMode: "disable" }),
      blockReadsOutsideWorkingDirectories: true,
    },
  };
}

export function agentsJson(agents: TeamAgent[]): Record<string, Omit<TeamAgent, "name">> {
  return Object.fromEntries(
    agents.map(({ name, ...rest }) => [name, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Omit<TeamAgent, "name">]),
  );
}

export function narrowEnv(env: NodeJS.ProcessEnv, extra: string[], prefixes = SAFE_PREFIXES): Record<string, string> {
  const keep = new Set([...SAFE_ENV, ...extra]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isSessionMarker(k)) continue;
    if (keep.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

/** The Codex executable: on PATH, in ~/.local/bin, or an npm install (run with node on Windows). */
export function findCodex(): { file: string; args: string[] } | null {
  const home = os.homedir();
  if (!isWin) {
    const file = findOnPath("codex") ?? [path.join(home, ".local", "bin", "codex")].find((f) => existsSync(f));
    return file ? { file, args: [] } : null;
  }
  const exe = findOnPath("codex.exe");
  if (exe) return { file: exe, args: [] };
  const shims = [findOnPath("codex.cmd"), process.env.APPDATA && path.join(process.env.APPDATA, "npm", "codex.cmd")];
  for (const shim of shims) {
    if (!shim || !existsSync(shim)) continue;
    const js = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    const node = findOnPath("node.exe");
    if (existsSync(js) && node) return { file: node, args: [js] };
  }
  return null;
}

/**
 * The Claude Code executable. The native installer puts claude(.exe) in ~/.local/bin; an npm
 * install leaves a claude.cmd shim on Windows, which is skipped in favour of running its
 * cli.js with node directly, because cmd.exe would re-parse the JSON arguments.
 */
export function findClaude(): { file: string; args: string[] } | null {
  const override = process.env.SIKEOOP_CLAUDE;
  if (override && existsSync(override)) return { file: override, args: [] };
  const home = os.homedir();
  if (!isWin) {
    const file = findOnPath("claude") ?? [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")].find((f) => existsSync(f));
    return file ? { file, args: [] } : null;
  }
  const exe = findOnPath("claude.exe") ?? [path.join(home, ".local", "bin", "claude.exe")].find((f) => existsSync(f));
  if (exe) return { file: exe, args: [] };
  const shims = [findOnPath("claude.cmd"), process.env.APPDATA && path.join(process.env.APPDATA, "npm", "claude.cmd")];
  for (const shim of shims) {
    if (!shim || !existsSync(shim)) continue;
    const cli = path.join(path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const node = findOnPath("node.exe");
    if (existsSync(cli) && node) return { file: node, args: [cli] };
  }
  return null;
}
