import { spawn } from "node:child_process";
import { promises as fs, watch } from "node:fs";
import path from "node:path";
import type { RunProcess } from "./quarto.ts";

// What typesetting needs from the machine: running Quarto, and noticing a saved document.

/**
 * Runs a program without a shell and hands over everything it prints. On `signal` the program and
 * whatever it started are stopped (Quarto runs Pandoc and Typst as children).
 */
export const runProcess: RunProcess = (bin, args, cwd, onOutput, signal) =>
  new Promise<number>((resolve, reject) => {
    if (signal.aborted) return resolve(-1);
    const win = process.platform === "win32";
    // A .cmd can only be run through cmd.exe; its arguments must then not be able to change the command.
    const viaCmd = win && /\.(cmd|bat)$/i.test(bin);
    if (viaCmd && [bin, ...args].some((a) => /["%^&|<>!\r\n]/.test(a))) return reject(new Error("文件名里有 Windows 命令行不能安全处理的符号（\" % ^ & | < > !），请改个名字"));
    const child = viaCmd
      ? spawn(`"${bin}" ${args.map((a) => `"${a}"`).join(" ")}`, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(bin, args, { cwd, shell: false, windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.pid === undefined) return;
      if (win) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
        return;
      }
      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          child.kill(sig);
        }
      };
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 3000);
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (d: Buffer) => onOutput(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onOutput(d.toString("utf8")));
    const end = () => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", (err) => {
      end();
      reject(err);
    });
    child.on("close", (code) => {
      end();
      resolve(code ?? -1);
    });
  });

export const isFile = (file: string): Promise<boolean> => fs.stat(file).then((s) => s.isFile(), () => false);

/**
 * Calls `changed` when the file is written. The folder is watched, not the file: editors often
 * save by writing a new file and renaming it over the old one. An event only counts when the
 * file's time or size really differs (systems also report changes from just before watching began,
 * and Quarto writing its output beside the document). Returns how to stop.
 */
export function watchFile(file: string, changed: () => void): () => void {
  const name = path.basename(file);
  const stamp = () => fs.stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => "");
  let last: Promise<string> = stamp();
  let closed = false;
  const check = () => {
    if (closed) return;
    const before = last;
    const now = stamp();
    last = now;
    void Promise.all([before, now]).then(([a, b]) => {
      if (!closed && b && a !== b) changed();
    });
  };
  const watcher = watch(path.dirname(file), { persistent: false }, (_event, changedName) => {
    if (changedName === null || changedName === name) check();
  });
  // Some macOS/sandbox filesystems silently omit native events. Poll only this file
  // as a fallback; the shared stamp prevents duplicate native/poll notifications.
  const poll = setInterval(check, 250);
  poll.unref();
  watcher.on("error", () => watcher.close());
  return () => {
    closed = true;
    clearInterval(poll);
    watcher.close();
  };
}
