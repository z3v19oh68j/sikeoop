import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchCheck, DispatchJob } from "@shared/types";
import { isInside, writeViolation } from "./guard.ts";

// Acceptance that runs by itself when a job ends, so nobody has to take a report on trust:
// - which files changed (a snapshot of the job's folders before and after)
// - changed files outside what the job owns (how Codex, with no pre-write hook, is caught)
// - new type errors only, measured against a baseline taken before the job
// - files the report mentions that don't exist
// Several jobs working in the same folder at once see each other's changes: a change outside what
// this job owns, in files a job running at the same time may write, is put down to that one.

/** Folders nobody edits by hand: dependencies, build output, tool caches, editor state. */
const IGNORED = new Set([
  "node_modules", "oh_modules", ".git", "dist", "out", "build", "target", "coverage",
  ".next", ".nuxt", ".output", ".svelte-kit", ".vite", ".turbo", ".parcel-cache", ".cache", ".npm-cache", ".gradle", ".hvigor",
  ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".idea",
]);
/** Files the system or a compiler leaves behind. */
const IGNORED_FILE = /^(\.DS_Store|Thumbs\.db)$|\.tsbuildinfo$/;
/** A folder bigger than this isn't snapshotted (the check says it was skipped). */
const MAX_FILES = 50_000;
const MAX_DETAILS = 30;

/** Absolute path → "mtime:size". */
export type Snapshot = Map<string, string>;

export async function snapshot(roots: string[]): Promise<Snapshot | null> {
  const out: Snapshot = new Map();
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!(await walk(abs))) return false;
      } else if (e.isFile() && !IGNORED_FILE.test(e.name)) {
        const st = await fs.stat(abs).catch(() => null);
        if (st) out.set(abs, `${st.mtimeMs}:${st.size}`);
        if (out.size > MAX_FILES) return false;
      }
    }
    return true;
  };
  for (const root of roots) if (!(await walk(root))) return null;
  return out;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [file, sig] of after) {
    const old = before.get(file);
    if (old === undefined) added.push(file);
    else if (old !== sig) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file);
  return { added, changed, removed };
}

/**
 * Type errors as keys that survive line shifts: file + code + message, without line:col.
 * Understands tsc's "file(line,col): error TSxxxx: msg" and "file:line:col - error TSxxxx: msg".
 */
export function typeErrors(output: string): Set<string> {
  const keys = new Set<string>();
  for (const line of output.split("\n")) {
    const m = /^(.+?)(?:\(\d+,\d+\)|:\d+:\d+)\s*[:-]\s*error (TS\d+): (.*)$/.exec(line.trim());
    if (m) keys.add(`${m[1]} ${m[2]}: ${m[3].trim()}`);
  }
  return keys;
}

/** Paths a report mentions that look like files of the job (with a folder and an extension). */
export function mentionedFiles(text: string, roots: string[]): string[] {
  const found = new Set<string>();
  const re = /(?:^|[\s`'"(（：:])((?:\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[a-zA-Z]{1,5})(?=$|[\s`'")）:：,，。;；])/gm;
  for (const m of text.matchAll(re)) {
    const p = m[1];
    if (/^https?:/.test(p) || p.includes("://")) continue;
    found.add(path.isAbsolute(p) ? p : path.resolve(roots[0] ?? "", p));
  }
  return [...found];
}

export interface CommandRunner {
  (command: string, cwd: string, signal: AbortSignal): Promise<{ output: string; exitCode: number | null }>;
}

interface Before {
  snap: Snapshot | null;
  baseline: Set<string> | null;
}

export class Verifier {
  /** Last typecheck per root + command, reused while nothing in the folders changed. */
  private readonly cache = new Map<string, { sig: string; errors: Set<string> }>();
  private readonly run: CommandRunner;
  /** Jobs between `before` and `end`, each with the jobs that were going at some point while it was. */
  private readonly active = new Map<string, { job: DispatchJob; meanwhile: Map<string, DispatchJob> }>();

  constructor(run: CommandRunner) {
    this.run = run;
  }

  async before(job: DispatchJob, signal: AbortSignal): Promise<Before> {
    const roots = job.scope?.roots ?? [];
    if (!roots.length) return { snap: null, baseline: null };
    const mine = { job, meanwhile: new Map<string, DispatchJob>() };
    for (const other of this.active.values()) {
      other.meanwhile.set(job.id, job);
      mine.meanwhile.set(other.job.id, other.job);
    }
    this.active.set(job.id, mine);
    const snap = await snapshot(roots);
    const baseline = job.verify?.typecheck ? await this.typecheck(job.verify.typecheck, roots[0], snap, signal) : null;
    return { snap, baseline };
  }

  async after(job: DispatchJob, state: Before, signal: AbortSignal): Promise<DispatchCheck[]> {
    const roots = job.scope?.roots ?? [];
    if (!roots.length) return [];
    const checks: DispatchCheck[] = [];
    const snap = await snapshot(roots);
    const rel = (abs: string) => path.relative(roots[0], abs) || abs;

    if (!state.snap || !snap) {
      checks.push({ kind: "files", level: "warn", summary: `文件太多（超过 ${MAX_FILES} 个），没有对比改动` });
    } else {
      const d = diffSnapshots(state.snap, snap);
      job.result ??= { text: "" };
      job.result.files = { changed: d.changed.map(rel), created: d.added.map(rel), deleted: d.removed.map(rel) };
      const touched = [...d.added, ...d.changed, ...d.removed];
      const lines = [...d.added.map((f) => `新建 ${rel(f)}`), ...d.changed.map((f) => `修改 ${rel(f)}`), ...d.removed.map((f) => `删除 ${rel(f)}`)];
      checks.push({
        kind: "files",
        level: "pass",
        summary: touched.length ? `改了 ${touched.length} 个文件（同一目录里同时进行的其他任务的改动也会算进来）` : "没有改文件",
        details: cap(lines),
      });
      if (job.scope?.owns?.length) {
        // A file another job may write, changed while that job was going, is not held against this one.
        const others = [...(this.active.get(job.id)?.meanwhile.values() ?? [])];
        const theirs = (f: string) => others.filter((o) => o.scope?.roots.length && !writeViolation(o, f));
        const outside = touched.filter((f) => writeViolation(job, f));
        const unexplained = outside.filter((f) => !theirs(f).length);
        const explained = outside.filter((f) => theirs(f).length);
        checks.push(
          unexplained.length
            ? { kind: "owns", level: "fail", summary: `有 ${unexplained.length} 个文件不归这个任务负责，却被改了`, details: cap(unexplained.map(rel)) }
            : { kind: "owns", level: "pass", summary: "改动都在它负责的文件里" },
        );
        if (explained.length) {
          const names = [...new Set(explained.flatMap((f) => theirs(f).map((o) => o.executor.name)))];
          checks.push({
            kind: "owns",
            level: "warn",
            summary: `另有 ${explained.length} 个不归它的文件被改了：同时在干活的 ${names.join("、")} 可以改这些文件，没有算在它头上`,
            details: cap(explained.map(rel)),
          });
        }
      }
    }

    if (job.verify?.typecheck) {
      const baseline = state.baseline;
      const now = baseline && (await this.typecheck(job.verify.typecheck, roots[0], snap, signal));
      if (baseline && now) {
        const added = [...now].filter((e) => !baseline.has(e));
        const fixed = [...baseline].filter((e) => !now.has(e)).length;
        checks.push(
          added.length
            ? { kind: "typecheck", level: "fail", summary: `类型检查新增 ${added.length} 个错误${fixed ? `（另修好了 ${fixed} 个）` : ""}`, details: cap(added) }
            : { kind: "typecheck", level: "pass", summary: `类型检查没有新增错误${fixed ? `，修好了 ${fixed} 个` : ""}（原有 ${baseline.size} 个不计）` },
        );
      } else {
        // Asked for and not delivered: said, not left out as if it had passed.
        checks.push({ kind: "typecheck", level: "warn", summary: "类型检查没有跑成，新增错误没有比较", details: [`命令：${job.verify.typecheck}`, baseline ? "任务结束后这次没跑成" : "任务开始前的基线就没跑成"] });
      }
    }

    const text = job.result?.text ?? "";
    if (text) {
      const missing: string[] = [];
      for (const f of mentionedFiles(text, roots)) {
        if (!roots.some((r) => isInside(r, f))) continue;
        if (!(await fs.stat(f).then(() => true, () => false))) missing.push(rel(f));
      }
      if (missing.length) checks.push({ kind: "claims", level: "warn", summary: `汇报里提到的 ${missing.length} 个文件不存在`, details: cap(missing) });
    }
    return checks;
  }

  /** The job is over: it no longer counts as working alongside the ones that start from now on. */
  end(job: DispatchJob): void {
    this.active.delete(job.id);
  }

  private async typecheck(command: string, cwd: string, snap: Snapshot | null, signal: AbortSignal): Promise<Set<string> | null> {
    const key = `${cwd}\n${command}`;
    const sig = snap ? signature(snap) : "";
    const hit = this.cache.get(key);
    if (snap && hit?.sig === sig) return hit.errors;
    try {
      const { output, exitCode } = await this.run(command, cwd, signal);
      const errors = typeErrors(output);
      // It failed and printed no error we can read (command not found, another checker's format):
      // that is "don't know", not "no errors".
      if (exitCode !== 0 && !errors.size) return null;
      if (snap) this.cache.set(key, { sig, errors });
      return errors;
    } catch {
      return null;
    }
  }
}

function signature(snap: Snapshot): string {
  const h = createHash("sha256");
  for (const [f, s] of [...snap].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${f}\0${s}\n`);
  return h.digest("hex");
}

function cap(lines: string[]): string[] {
  return lines.length > MAX_DETAILS ? [...lines.slice(0, MAX_DETAILS), `…还有 ${lines.length - MAX_DETAILS} 条`] : lines;
}

const MARK: Record<DispatchCheck["level"], string> = { pass: "✓", warn: "⚠", fail: "✗" };

/** The checks as plain lines, for a tool result or a report. */
export function checksText(checks: DispatchCheck[] | undefined): string {
  if (!checks?.length) return "";
  // Nothing to look into: one line. The reader pays for every line, and the details matter only when a check didn't pass.
  if (checks.every((c) => c.level === "pass")) return `自动验收通过：${checks.map((c) => c.summary).join("；")}`;
  const lines = ["自动验收："];
  for (const c of checks) {
    lines.push(`${MARK[c.level]} ${c.summary}`);
    for (const d of c.details ?? []) lines.push(`    ${d}`);
  }
  return lines.join("\n");
}
