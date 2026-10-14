// The approver's fixed rules (approver.ts): what always goes to the user, and what needs nobody.
// Kept apart from the server so they can be used, and tested, on their own.

import path from "node:path";

export type Decision = "allow" | "deny" | "ask";

export interface ToolCall {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Always the user's call, whatever the model says. */
const DANGER: RegExp[] = [
  /\brm\s+(-\w*\s+)*-\w*[rf]/i, // rm -rf / rm -r / rm -f
  /\bsudo\b|\bsu\s/,
  /\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|rebase|filter-branch|checkout\s+--\s|branch\s+-D|tag\s+-d)/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(mkfs|dd\s+if=|diskutil\s+erase|shutdown|reboot|launchctl|crontab)\b/,
  /\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\/|\bchown\s+-R/,
  /\b(npm|pnpm|yarn)\s+publish\b|\b(wrangler|vercel|netlify|cf)\s+.*\b(deploy|publish|delete)\b/,
  /\b(drop\s+(table|database)|truncate\s+table)\b/i,
  /\bkill(all)?\s+-9\b|\bpkill\b/,
  /~\/\.(ssh|aws|gnupg|config\/gh)|\/\.ssh\/|id_rsa|\.env\b|keychain|security\s+find-/,
  /\beval\b|\bbase64\s+(-d|--decode)\b.*\|/,
  />\s*\/(etc|usr|System|Library)\//,
];

/** Read-only or routine: no need to ask anyone. Must also pass DANGER and have no chaining. */
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|grep|rg|find|which|echo|tree|file|stat|du|df|diff|date|whoami|env|printenv)\b/,
  /^git\s+(status|diff|log|show|branch|remote|fetch|add|commit|stash|blame|rev-parse)\b/,
  /^(npm|pnpm|yarn)\s+(run\s+)?(typecheck|lint|test|build|install|ci|ls|list|outdated)\b/,
  /^(node|tsc|npx\s+tsc|python3?\s+-m\s+pytest|pytest|cargo\s+(check|build|test)|go\s+(build|test|vet))\b/,
];

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "ToolSearch", "TodoWrite"]);

// The credential folders count with everything inside them (~/.ssh/authorized_keys), not only by name.
const SENSITIVE_PATH = /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)|(^|\/)(\.env[^/]*|\.npmrc|\.claude\/settings[^/]*\.json)$|^\/(etc|usr|System|Library)\//;

export function rules(call: ToolCall): { decision: Decision; reason: string } | null {
  const input = call.tool_input ?? {};
  if (call.tool_name === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const hit = DANGER.find((re) => re.test(cmd));
    if (hit) return { decision: "ask", reason: `高风险命令（规则 ${hit.source.slice(0, 40)}）` };
    // Pipes / chains / substitutions can hide anything after the first word: let the model look.
    if (!/[;&|`$<>]/.test(cmd) && SAFE.some((re) => re.test(cmd))) return { decision: "allow", reason: "常规只读/构建命令" };
    return null;
  }
  if (call.tool_name === "Write" || call.tool_name === "Edit" || call.tool_name === "MultiEdit" || call.tool_name === "NotebookEdit") {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    if (SENSITIVE_PATH.test(file)) return { decision: "ask", reason: "改动敏感文件" };
    return { decision: "allow", reason: "写入文件" };
  }
  // Searching and reading — files or the web — always passes.
  if (call.tool_name && READ_TOOLS.has(call.tool_name)) {
    const file = String(input.file_path ?? input.path ?? "");
    if (file && SENSITIVE_PATH.test(file)) return { decision: "ask", reason: "读取敏感文件" };
    return { decision: "allow", reason: "搜索/读取" };
  }
  return null;
}

/**
 * The decision when nobody is there to ask (super-dispatch mode): what the fixed rules would have
 * taken to the user is refused, everything else goes through. No model call and no waiting.
 */
export function unattendedDecision(call: { tool_name?: string; tool_input?: unknown; cwd?: string }): { decision: "allow" | "deny"; reason: string } {
  const input = call.tool_input && typeof call.tool_input === "object" ? (call.tool_input as Record<string, unknown>) : {};
  const hit = rules({ tool_name: call.tool_name, tool_input: input });
  if (hit?.decision === "ask") return { decision: "deny", reason: hit.reason };
  // Unattended work changes files in its own project only.
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(call.tool_name ?? "")) {
    const file = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    if (!file) return { decision: "deny", reason: "文件工具缺少路径" };
    const root = call.cwd ? path.resolve(call.cwd) : "";
    const abs = path.resolve(root || "/", file);
    if (!root || (abs !== root && !abs.startsWith(root + path.sep))) return { decision: "deny", reason: "要改的文件在项目文件夹之外" };
  }
  return { decision: "allow", reason: hit?.reason ?? "无人值守，规则未命中高风险" };
}
