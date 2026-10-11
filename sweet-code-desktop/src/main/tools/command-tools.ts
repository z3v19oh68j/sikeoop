import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { GIT_BASH_MISSING, bashEnv, findBash } from "../shell-env";
import { getRoot } from "../workspace";
import { defineTool } from "./registry";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
/** Output kept for the model: the start and the end, where errors and summaries usually are. */
const HEAD_CHARS = 16_000;
const TAIL_CHARS = 24_000;

/** Never run these, approval or not. The user can still type them in the terminal. */
const BLOCKED: { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/, why: "needs administrator rights" },
  { re: /\brm\s+(?:-[a-z-]+\s+)*(?:\/|~|\$HOME|\$\{HOME\})\/?\*?(?=\s|$|[;&|])/i, why: "deletes the whole disk or home folder" },
  // Windows drives as Git Bash sees them: /c, /c/, /c/*, and C:\ or C:/
  { re: /\brm\s+(?:-[a-z-]+\s+)*(?:\/[a-z]|[a-z]:[\\/]?)(?:[\\/]\*?)?(?=\s|$|[;&|])/i, why: "deletes a whole drive" },
  // Only when PowerShell is the command being run, not when the word appears in an argument.
  { re: /(?:^|[;&|(]\s*|\$\(\s*)(powershell|pwsh)(\.exe)?(?=\s|$)/i, why: "PowerShell is turned off in this app; use bash commands instead" },
  { re: /\bgit\s+push\b.*(\s-f\b|--force)/, why: "force-push can destroy remote history" },
  { re: /\b(mkfs|diskutil\s+erase|format\s+[a-z]:)/i, why: "erases a disk" },
  { re: /\bdd\s+.*\bof=\/dev\//, why: "writes directly to a device" },
  { re: /\b(shutdown|reboot|halt)\b/, why: "turns the computer off" },
  { re: /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, why: "runs a script straight from the internet" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: "fork bomb" },
];

/** Allowed, but the approval card warns the user in plain words. */
const RISKY: { re: RegExp; warning: string }[] = [
  { re: /\brm\b/, warning: "这条命令会删除文件，删掉的文件不会进废纸篓。" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+(--\s|\.)|restore\b)/, warning: "这条命令会丢掉还没提交的改动。" },
  { re: /\bgit\s+push\b/, warning: "这条命令会把代码推送到远程仓库，别人能看到。" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, warning: "这条命令会把包公开发布到网上。" },
  { re: /\bmv\b/, warning: "这条命令会移动或重命名文件，可能覆盖同名文件。" },
  { re: /\bchmod\b|\bchown\b/, warning: "这条命令会改文件的权限。" },
];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r(?!\n)/g;

export const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a bash command in the project folder and return its output and exit code. " +
    "Commands always run in bash, on every system (Git Bash on Windows): use bash syntax and Unix tools " +
    "(ls, cat, grep, rm, cp, mkdir -p, export VAR=x), never PowerShell or cmd syntax. " +
    "Use it for installing packages, running tests or builds, checking versions, git status and similar one-off commands. " +
    "The user approves every command first. Commands get no keyboard input, so pass flags like --yes for prompts. " +
    "Do not start dev servers, watchers or anything that keeps running: it would be stopped at the timeout. " +
    "For those, tell the user the command and let them run it in the terminal panel. " +
    "Changes made by commands cannot be undone with the app's undo, so prefer edit_file for editing files.",
  schema: z.object({
    command: z.string().min(1),
    explanation: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(MAX_TIMEOUT_S).optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command line to run." },
      explanation: {
        type: "string",
        description:
          "One short sentence, in the user's language, telling a beginner what this command does and why it is needed.",
      },
      timeout_seconds: {
        type: "integer",
        description: `Stop the command after this many seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`,
      },
    },
    required: ["command", "explanation"],
  },
  permission: "always_confirm",
  parallelSafe: false,
  summarize: (i) => `运行 ${i.command.length > 40 ? i.command.slice(0, 40) + "…" : i.command}`,
  async run({ command, explanation, timeout_seconds }, ctx) {
    const bash = findBash();
    if (!bash) throw new Error(`${GIT_BASH_MISSING} (Tell the user this in plain words; do not try other shells.)`);
    const blocked = BLOCKED.find((b) => b.re.test(command));
    if (blocked) {
      throw new Error(
        `This command is blocked for safety (${blocked.why}). If it is really needed, tell the user and let them run it themselves in the terminal.`,
      );
    }
    const warning = RISKY.filter((r) => r.re.test(command)).map((r) => r.warning).join("") || undefined;
    const outcome = await ctx.requestApproval({ kind: "command", command, explanation, warning });
    if (!outcome.approved) {
      const note = outcome.feedback?.trim();
      return note
        ? `The user rejected this command and said: "${note}". Do not run it again; adjust to the feedback.`
        : "The user rejected this command. Do not run it again; ask what they would like instead.";
    }

    const timeoutS = timeout_seconds ?? DEFAULT_TIMEOUT_S;
    const result = await execute(bash, command, getRoot(), timeoutS * 1000, ctx.signal, (chunk) => ctx.commandOutput(chunk));
    ctx.commandDone(result.exitCode, result.timedOut);
    if (!result.cancelled && (result.timedOut || result.exitCode !== 0)) {
      ctx.noteFailure(`运行「${command.slice(0, 120)}」${result.timedOut ? "超时了" : `失败（退出码 ${result.exitCode}）`}。输出末尾：\n${result.output.slice(-400)}`);
    }

    const status = result.cancelled
      ? "Cancelled by the user; the process was stopped."
      : result.timedOut
        ? `Timed out after ${timeoutS}s; the process was stopped. If it is a server or watcher, ask the user to run it in the terminal instead.`
        : `Exit code ${result.exitCode}${result.exitCode === 0 ? "" : " (failed)"}.`;
    return `${status}\n${result.output || "(no output)"}`;
  },
});

/** Why this command is never run (BLOCKED), or null. Also used for automation command steps. */
export function blockedReason(command: string): string | null {
  return BLOCKED.find((b) => b.re.test(command))?.why ?? null;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
}

export function execute(
  bash: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onChunk: (s: string) => void,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(bash, [win ? "-lc" : "-c", command], {
      cwd,
      env: commandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on macOS/Linux, so a timeout stops everything the command started.
      detached: !win,
      // No black console window flashing up on Windows.
      windowsHide: true,
    });

    let head = "";
    let tail = "";
    let total = 0;
    let timedOut = false;
    let cancelled = false;

    // Decode each stream as a whole: a Chinese character split across two chunks stays intact.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    const take = (raw: string) => {
      const text = raw.replace(ANSI, "");
      if (!text) return;
      onChunk(text);
      total += text.length;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += text.slice(0, room);
        tail = (tail + text.slice(room)).slice(-TAIL_CHARS);
      } else {
        tail = (tail + text).slice(-TAIL_CHARS);
      }
    };
    child.stdout?.on("data", (b: Buffer) => take(outDec.write(b)));
    child.stderr?.on("data", (b: Buffer) => take(errDec.write(b)));

    const stop = () => {
      if (child.exitCode !== null || !child.pid) return;
      if (win) return killTreeWindows(child);
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      take(outDec.end() + errDec.end());
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const skipped = total - head.length - tail.length;
      const output = skipped > 0 ? `${head}\n…（中间省略了 ${skipped} 个字符）…\n${tail}` : head + tail;
      resolve({ exitCode, timedOut, cancelled, output: output.trimEnd() });
    };
    child.on("error", (err) => {
      take(`Failed to start: ${err.message}\n`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Windows has no process groups: taskkill /T stops bash and everything it started. */
function killTreeWindows(child: ChildProcess) {
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () =>
    child.kill(),
  );
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...bashEnv(),
    // CI=1 makes npm, create-* tools and test runners skip interactive prompts and watch modes.
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

export const COMMAND_TOOLS = [runCommand];
