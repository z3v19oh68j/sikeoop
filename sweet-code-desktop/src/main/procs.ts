import { execFile } from "node:child_process";
import os from "node:os";
import type { ProcInfo } from "@shared/types";

// Every process on the computer, for the island's process card. macOS/Linux read `ps`; Windows
// reads Get-Process, whose CPU is cumulative seconds, so the percentage comes from the change
// between two reads.

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/** Windows: CPU seconds per pid at the last read, to turn into a percentage. */
let lastCpu = new Map<number, number>();
let lastAt = 0;

export async function listProcs(): Promise<ProcInfo[]> {
  if (process.platform !== "win32") {
    const out = await run("ps", ["-Ao", "pid=,pcpu=,rss=,comm="]);
    return out
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024, name: m[4].split("/").pop() || m[4] }));
  }
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Process | ForEach-Object { \"$($_.Id)`t$($_.CPU)`t$($_.WorkingSet64)`t$($_.ProcessName)\" }",
  ]);
  const at = Date.now();
  const secs = lastAt ? (at - lastAt) / 1000 : 0;
  const cores = os.cpus().length || 1;
  const cpuNow = new Map<number, number>();
  const list = out
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((p) => p.length >= 4 && p[0])
    .map(([pid, cpu, mem, name]) => {
      const id = Number(pid);
      const total = Number(cpu) || 0;
      cpuNow.set(id, total);
      const before = lastCpu.get(id);
      const pct = secs && before !== undefined ? Math.max(0, ((total - before) / secs / cores) * 100) : 0;
      return { pid: id, cpu: Math.round(pct * 10) / 10, mem: Number(mem) || 0, name };
    });
  lastCpu = cpuNow;
  lastAt = at;
  return list;
}
