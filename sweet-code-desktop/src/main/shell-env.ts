import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// One shell everywhere: bash. Models write bash far more reliably (and more
// tersely) than PowerShell or cmd, so the agent's commands always run in bash,
// and on Windows the terminal uses Git Bash too. PowerShell is never used.

const isWin = process.platform === "win32";

/**
 * Apps opened from the Dock or Finder get a bare PATH, so `node`, `npm` or
 * `python` installed through nvm, Homebrew or pyenv would be "command not found".
 * Ask the user's own shell for its environment once at startup, like VS Code does.
 * Windows apps already get the full PATH from the registry.
 */
export async function loadShellEnv(): Promise<void> {
  if (isWin) return;
  const shell = process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
  const mark = "__SWEET_ENV__";
  const out = await new Promise<string>((resolve) => {
    let buf = "";
    const child = spawn(shell, ["-ilc", `echo ${mark}; env; echo ${mark}`], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, SWEET_RESOLVING_ENV: "1" },
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, 5000);
    child.stdout.on("data", (d) => (buf += d));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
  const body = out.split(mark)[1];
  if (!body) return;
  for (const line of body.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i);
    if (key === "SWEET_RESOLVING_ENV" || key === "_" || key === "SHLVL" || key === "PWD" || key === "OLDPWD") continue;
    process.env[key] = line.slice(i + 1);
  }
}

let bashCache: string | null | undefined;

/** Path to bash, or null when there is none (Windows without Git for Windows). */
export function findBash(): string | null {
  if (bashCache !== undefined) return bashCache;
  bashCache = isWin ? findGitBash() : findOnPath("bash") ?? (existsSync("/bin/bash") ? "/bin/bash" : null);
  return bashCache;
}

export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/**
 * Git for Windows ships bash. Use its bin\bash.exe launcher, which sets up PATH
 * for git and the usual Unix tools. C:\Windows\System32\bash.exe is WSL, a
 * separate Linux system with its own files, so it is never used.
 */
export function findGitBash(): string | null {
  const env = process.env;
  const candidates = [
    env.SWEET_BASH,
    env.ProgramFiles && path.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe"),
    "C:\\msys64\\usr\\bin\\bash.exe",
  ];
  // Wherever git.exe is on PATH (…\Git\cmd or …\Git\bin), bash.exe sits in …\Git\bin.
  for (const dir of (env.PATH ?? "").split(";")) {
    if (!dir || /\\(System32|WindowsApps)\\?$/i.test(dir)) continue;
    if (existsSync(path.join(dir, "git.exe"))) {
      candidates.push(path.resolve(dir, "..", "bin", "bash.exe"), path.join(dir, "bash.exe"));
    }
  }
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? null;
}

export const GIT_BASH_MISSING =
  "这台电脑上没有找到 bash。请先安装 Git for Windows（https://git-scm.com/download/win），装好后重启 sikeoop。";

/** Extra environment so Git Bash behaves: stay in the project folder, speak UTF-8. */
export function bashEnv(): Record<string, string> {
  const extra: Record<string, string> = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  // Only fill in a locale when there is none (typical for Git Bash); never override the user's own.
  if (!process.env.LANG && !process.env.LC_ALL) extra.LANG = "C.UTF-8";
  // Git Bash's login profile jumps to the home folder unless this is set.
  if (isWin) extra.CHERE_INVOKING = "1";
  return extra;
}

/** The shell for the user's terminal panel, or null when Windows has no Git Bash. */
export function terminalShell(): { file: string; args: string[] } | null {
  if (isWin) {
    const bash = findBash();
    return bash ? { file: bash, args: ["--login", "-i"] } : null;
  }
  // On macOS and Linux the user keeps their own shell (zsh, fish…) in their terminal.
  return { file: process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l"] };
}
