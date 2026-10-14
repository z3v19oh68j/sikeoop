import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchCheck } from "@shared/types";
import { diffSnapshots, snapshot, type Snapshot } from "./verify.ts";

// A sandbox for one task that writes code: a copy of the project in a folder of its own. The task
// works in the copy and is checked there; only when it passes do the files it changed go back into
// the project. A task that goes wrong never touches the project: its copy is thrown away and a new
// one, with a new session, starts over.
//
// The copy is cheap where the disk can clone files (APFS). Dependencies are linked, not copied;
// version history and build output are left out.

/** Left out of the copy: history, build output, caches. A task has no use for them and they can be huge. */
const SKIPPED = new Set([
  ".git", "dist", "out", "build", "target", "coverage",
  ".next", ".nuxt", ".output", ".svelte-kit", ".vite", ".turbo", ".parcel-cache", ".cache", ".npm-cache", ".gradle", ".hvigor",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".idea",
]);
/** Linked to the project's own: installed dependencies, so a typecheck or a test still runs in the copy. */
const LINKED = new Set(["node_modules", "oh_modules", ".venv"]);
const SKIPPED_FILE = /^(\.DS_Store|Thumbs\.db)$/;
/** A project with more files than this is not copied; the task then runs in the project as before. */
export const MAX_SANDBOX_FILES = 50_000;
/** How many times a task starts over in a new sandbox after its first one failed. */
export const MAX_RESTARTS = 2;

export interface Sandbox {
  /** The copy: the task's project folder. */
  dir: string;
  /** The project it was copied from. */
  root: string;
  /** Each copied file as it was in the project then ("mtime:size"), by path relative to the root. */
  base: Map<string, string>;
  /** The copy right after it was made, to tell what the task changed. */
  snap: Snapshot;
}

const sig = (s: { mtimeMs: number; size: number }) => `${s.mtimeMs}:${s.size}`;

/** Copies the project at `root` into the new folder `dir` (which must be outside the project). */
export async function createSandbox(root: string, dir: string): Promise<Sandbox> {
  const from = path.resolve(root), to = path.resolve(dir);
  const rel = path.relative(from, to);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("沙盒不能建在项目文件夹里面");
  await fs.mkdir(to, { recursive: true });
  const base = new Map<string, string>();
  const files: [string, string, string][] = [];
  const walk = async (src: string, dst: string): Promise<void> => {
    for (const e of await fs.readdir(src, { withFileTypes: true })) {
      if (SKIPPED.has(e.name) || SKIPPED_FILE.test(e.name)) continue;
      const a = path.join(src, e.name), b = path.join(dst, e.name);
      if (LINKED.has(e.name)) {
        await fs.symlink(a, b, "junction");
      } else if (e.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(a), b).catch(() => {});
      } else if (e.isDirectory()) {
        await fs.mkdir(b, { recursive: true });
        await walk(a, b);
      } else if (e.isFile()) {
        if (files.length >= MAX_SANDBOX_FILES) throw new Error(`项目文件太多（超过 ${MAX_SANDBOX_FILES} 个），没有建沙盒`);
        files.push([a, b, path.relative(from, a)]);
      }
    }
  };
  try {
    await walk(from, to);
    let next = 0;
    // A few at a time: thousands of clones in one go run out of file handles.
    await Promise.all(Array.from({ length: 24 }, async () => {
      for (let i = next++; i < files.length; i = next++) {
        const [a, b, r] = files[i];
        base.set(r, sig(await fs.stat(a)));
        await fs.copyFile(a, b, constants.COPYFILE_FICLONE);
      }
    }));
    const snap = await snapshot([to]);
    if (!snap) throw new Error("沙盒建好后没法清点文件");
    return { dir: to, root: from, base, snap };
  } catch (err) {
    await fs.rm(to, { recursive: true, force: true });
    throw err;
  }
}

export interface SandboxChanges {
  /** Paths relative to the project root. written: new or changed; removed: deleted in the copy. */
  written: string[];
  removed: string[];
}

/** What the task changed in its copy. */
export async function sandboxChanges(sb: Sandbox): Promise<SandboxChanges> {
  const now = await snapshot([sb.dir]);
  if (!now) throw new Error("沙盒里的文件太多，没法比对改动");
  const d = diffSnapshots(sb.snap, now);
  const rel = (abs: string) => path.relative(sb.dir, abs);
  return { written: [...d.added, ...d.changed].map(rel).sort(), removed: d.removed.map(rel).sort() };
}

/**
 * Puts the task's changes into the project. Nothing is written if any of those files changed in
 * the project since the copy was made (someone else got there first): the conflicts are returned.
 */
export async function mergeSandbox(sb: Sandbox, changes: SandboxChanges): Promise<{ merged: string[]; conflicts: string[] }> {
  const conflicts: string[] = [];
  for (const rel of [...changes.written, ...changes.removed]) {
    const then = sb.base.get(rel);
    const now = await fs.stat(path.join(sb.root, rel)).then(sig, () => undefined);
    if (then !== now) conflicts.push(rel);
  }
  if (conflicts.length) return { merged: [], conflicts };
  for (const rel of changes.written) {
    const target = path.join(sb.root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sb.dir, rel), target);
  }
  for (const rel of changes.removed) await fs.rm(path.join(sb.root, rel), { force: true });
  return { merged: [...changes.written, ...changes.removed], conflicts: [] };
}

/** Throws the copy away. Linked dependencies are unlinked, not deleted. */
export async function discardSandbox(sb: Pick<Sandbox, "dir">): Promise<void> {
  await fs.rm(sb.dir, { recursive: true, force: true, maxRetries: 3 });
}

export interface SandboxRun<State> {
  /** A new copy of the project as it is now. */
  open(): Promise<Sandbox>;
  /** Called before the task starts in a copy: what the checks compare against. */
  begin(sb: Sandbox, signal: AbortSignal): Promise<State>;
  /** A new session does the task in the copy and reports. */
  work(sb: Sandbox, input: string, signal: AbortSignal): Promise<string>;
  /** The acceptance checks, run in the copy. */
  check(sb: Sandbox, state: State, report: string, signal: AbortSignal): Promise<DispatchCheck[]>;
  /** A line for whoever is watching the task. */
  note(text: string): void;
}

const problemsOf = (checks: DispatchCheck[]): string[] =>
  checks.filter((c) => c.level === "fail").flatMap((c) => [c.summary, ...(c.details ?? []).slice(0, 12).map((d) => `  ${d}`)]);

/** What a session is told when its work is sent back in the same copy. */
export function reworkInput(input: string, problems: string[]): string {
  return `${input}\n\n（这个任务已经做过一轮，验收没有通过，改动还在你面前的文件里。只修下面这些问题，不要重做：\n${problems.join("\n")}\n）`;
}

/**
 * One task, start to finish: work in a copy, check there, fix once in the same copy if the checks
 * fail, and on a second failure throw the copy away and start over in a new one with a new session
 * (MAX_RESTARTS times). Its changes reach the project only after it passes. Resolves with the
 * report; rejects, with the project untouched, when no attempt passed.
 */
export async function runInSandbox<State>(input: string, signal: AbortSignal, run: SandboxRun<State>): Promise<string> {
  let last = "";
  for (let attempt = 1; attempt <= MAX_RESTARTS + 1; attempt++) {
    if (signal.aborted) throw new Error("已取消");
    const sb = await run.open();
    try {
      run.note(attempt === 1 ? "沙盒已建好，在副本里开工" : `第 ${attempt} 个沙盒已建好，新会话从头重做`);
      const state = await run.begin(sb, signal);
      let report = await run.work(sb, input, signal);
      let problems = problemsOf(await run.check(sb, state, report, signal));
      if (problems.length && !signal.aborted) {
        run.note(`沙盒里验收没过，在原沙盒返工一次：${problems[0]}`);
        report = await run.work(sb, reworkInput(input, problems), signal);
        problems = problemsOf(await run.check(sb, state, report, signal));
      }
      if (signal.aborted) throw new Error("已取消");
      if (!problems.length) {
        const changes = await sandboxChanges(sb);
        const { merged, conflicts } = await mergeSandbox(sb, changes);
        if (!conflicts.length) {
          run.note(merged.length ? `沙盒验收通过，${merged.length} 个文件已合并回项目` : "沙盒验收通过，没有要合并的改动");
          return `${report}\n\n（在沙盒里完成，第 ${attempt} 次通过${merged.length ? `，${merged.length} 个文件已合并回项目` : "，没有改动文件"}。）`;
        }
        problems = [`合并时发现项目里这些文件在它干活期间被别人改过：${conflicts.slice(0, 12).join("、")}`];
      }
      last = problems.join("\n");
      run.note(`沙盒已丢弃：${problems[0]}`);
    } finally {
      await discardSandbox(sb).catch(() => {});
    }
  }
  throw new Error(`在沙盒里做了 ${MAX_RESTARTS + 1} 次都没通过验收，项目没有被改动。最后一次的问题：\n${last}`);
}
