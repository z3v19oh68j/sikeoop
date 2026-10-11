import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { bashEnv, findBash } from "../shell-env";

// Runs one command hook: bash -c "<command>" in the project folder, the event as JSON on
// stdin, stdout and stderr collected. Exit code 2 means "block"; any other non-zero code is a
// failed hook, reported but never blocking.

const MAX_OUTPUT = 64 * 1024;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export function runHookCommand(
  command: string,
  input: object,
  opts: { cwd: string; timeoutS: number; signal: AbortSignal },
): Promise<CommandResult> {
  const bash = findBash();
  if (!bash) {
    return Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, error: "没有找到 bash（Windows 上需要安装 Git for Windows）" });
  }
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let child: ChildProcess;
    try {
      child = spawn(bash, [win ? "-lc" : "-c", command], {
        cwd: opts.cwd,
        env: { ...process.env, ...bashEnv(), SWEET_PROJECT_DIR: opts.cwd, CLAUDE_PROJECT_DIR: opts.cwd, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: !win,
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, error: (err as Error).message });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    child.stdout?.on("data", (b: Buffer) => (stdout = (stdout + outDec.write(b)).slice(0, MAX_OUTPUT)));
    child.stderr?.on("data", (b: Buffer) => (stderr = (stderr + errDec.write(b)).slice(0, MAX_OUTPUT)));
    // A hook that doesn't read stdin closes the pipe early; that is not an error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));

    const stop = () => {
      if (child.exitCode !== null || !child.pid) return;
      try {
        if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutS * 1000);
    opts.signal.addEventListener("abort", stop, { once: true });

    let done = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", stop);
      resolve({ exitCode, stdout: stdout + outDec.end(), stderr: stderr + errDec.end(), timedOut, error });
    };
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  });
}
