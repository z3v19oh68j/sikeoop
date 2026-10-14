import { promises as fs, constants } from "node:fs";
import path from "node:path";
import type { DispatchCheck, DispatchJob } from "@shared/types";
import { realFile } from "../session/scope.ts";

// Guarding a job: is everything it needs there before it starts (preflight), and may it write this
// file (ownership). Pure functions over the job, so the scheduler, PeerBus's hook and sikeoop's own
// write tools all ask the same question.

/** What an executor can do, for preflight. network "ask": it may get it, but someone has to approve. */
export interface ExecutorEnv {
  writableRoots?: string[];
  network?: boolean | "ask";
}

/** macOS and Windows file systems don't tell Src/a.ts from src/a.ts; neither do the checks here, there. */
export const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

// "a/b.ts" exact, "a/" a folder and everything in it, * and ** globs. A ** between slashes also
// stands for no folder at all: "a/**/x.ts" matches "a/x.ts". Paths use "/".
export function matchOwns(owns: string[], rel: string, foldCase: boolean = FOLD_CASE): boolean {
  const fold = (s: string) => (foldCase ? s.toLowerCase() : s);
  const file = fold(rel.split(path.sep).join("/"));
  return owns.some((pattern) => {
    const p = fold(pattern.split(path.sep).join("/").replace(/^\.\//, ""));
    if (p.endsWith("/")) return file.startsWith(p);
    if (!p.includes("*")) return file === p;
    // "**/" is any number of folders, none included; a "**" elsewhere is anything; "*" stays in its folder.
    const re = p
      .split("**/")
      .map((seg) =>
        seg
          .split("**")
          .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
          .join(".*"),
      )
      .join("(?:.*/)?");
    return new RegExp(`^${re}$`).test(file);
  });
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why the job may not write `abs`, or null when it may (or the job sets no limits). Compares the
 * paths as written: where a symlink could lead the write elsewhere, ask realWriteViolation.
 */
export function writeViolation(job: Pick<DispatchJob, "scope">, abs: string, foldCase: boolean = FOLD_CASE): string | null {
  const scope = job.scope;
  if (!scope?.roots.length) return null;
  const root = scope.roots.find((r) => isInside(r, abs, foldCase));
  if (!root) return `${abs} 不在这个任务的工作目录里（${scope.roots.join("、")}）`;
  if (!scope.owns?.length) return null;
  // owns is relative to the first folder. Cut rather than computed, so a root written in another
  // case (where case doesn't count) still gives the path below it.
  const first = path.resolve(scope.roots[0]);
  const inFirst = isInside(first, abs, foldCase);
  const rel = inFirst ? path.resolve(abs).slice(first.length).replace(/^[\\/]+/, "") : path.relative(first, abs);
  if (!inFirst || !matchOwns(scope.owns, rel, foldCase)) return `${rel} 不归这个任务负责（只能改：${scope.owns.join("、")}）`;
  return null;
}

/**
 * writeViolation for a write that is about to happen: the file and the job's folders are resolved
 * to where they really are first, so a symlink inside the folder can't carry the write out of it,
 * or into files the job doesn't own. A path that can't be resolved is refused.
 */
export async function realWriteViolation(job: Pick<DispatchJob, "scope">, abs: string, foldCase: boolean = FOLD_CASE): Promise<string | null> {
  const scope = job.scope;
  if (!scope?.roots.length) return null;
  let real: string;
  try {
    real = await realFile(path.resolve(abs));
  } catch (err) {
    return `没法确认 ${abs} 实际指向哪里（${err instanceof Error ? err.message : String(err)}），不能写`;
  }
  const roots = await Promise.all(scope.roots.map((r) => fs.realpath(r).catch(() => path.resolve(r))));
  return writeViolation({ scope: { ...scope, roots } }, real, foldCase);
}

export function isInside(root: string, p: string, foldCase: boolean = FOLD_CASE): boolean {
  const fold = (s: string) => (foldCase ? s.toLowerCase() : s);
  const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(p)));
  // ".." or "../x" is outside; a name that merely begins with two dots ("..cache") is not.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Conservative lexical write ranges, relative to the first scope root. */
export function writeSet(job: Pick<DispatchJob, "scope">): string[] | "all" | null {
  const scope = job.scope;
  if (!scope || scope.readOnly || !scope.roots.length) return null;
  if (!scope.owns?.length) return "all";
  return scope.owns.map(pattern => {
    const normalized = pattern.split(path.sep).join("/");
    const star = normalized.indexOf("*");
    // Exact paths remain exact; glob prefixes stop at the last complete directory.
    const literal = star < 0 ? normalized : normalized.slice(0, star);
    const prefix = star < 0 ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
    return path.resolve(scope.roots[0], prefix);
  });
}

/** True when two jobs might write the same path (case rules match ownership guards). */
export function mayOverlap(a: Pick<DispatchJob, "scope">, b: Pick<DispatchJob, "scope">, foldCase: boolean = FOLD_CASE): boolean {
  const aw = writeSet(a), bw = writeSet(b);
  if (aw === null || bw === null) return false;
  const contains = (x: string, y: string) => isInside(x, y, foldCase) || isInside(y, x, foldCase);
  if (!a.scope!.roots.some(x => b.scope!.roots.some(y => contains(x, y)))) return false;
  if (aw === "all" || bw === "all") return true;
  return aw.some(x => bw.some(y => contains(x, y)));
}

/**
 * Before a job starts: its folders exist and are writable by the executor, its dependencies are
 * installed, and it can reach the network if it needs to. fail = don't start it.
 */
export async function preflight(job: Pick<DispatchJob, "scope" | "needs" | "executor">, env: ExecutorEnv): Promise<DispatchCheck> {
  const fails: string[] = [];
  const warns: string[] = [];
  const roots = job.scope?.roots ?? [];
  for (const root of roots) {
    try {
      await fs.access(root, constants.W_OK);
    } catch {
      fails.push(`工作目录不存在或不能写：${root}`);
      continue;
    }
    if (env.writableRoots && !env.writableRoots.some((w) => isInside(w, root))) {
      fails.push(`${job.executor.name} 只能写 ${env.writableRoots.join("、")}，写不了 ${root}`);
    }
  }
  for (const own of job.scope?.owns ?? []) {
    const abs = path.resolve(roots[0] ?? "", own.replace(/\*.*$/, ""));
    if (env.writableRoots && !env.writableRoots.some((w) => isInside(w, abs))) fails.push(`${job.executor.name} 写不了它负责的 ${own}`);
  }
  for (const dir of job.needs?.deps ?? []) {
    const abs = path.resolve(roots[0] ?? "", dir);
    const has = await fs.stat(path.join(abs, "node_modules")).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!has) fails.push(`${dir} 还没装依赖（没有 node_modules），先装好再派`);
  }
  if (job.needs?.network) {
    if (env.network === false) fails.push(`${job.executor.name} 没有网络，这个任务需要联网`);
    else if (env.network === "ask") warns.push(`${job.executor.name} 默认没有网络，联网时会请你批准`);
  }
  if (fails.length) return { kind: "preflight", level: "fail", summary: "派活前检查没通过", details: [...fails, ...warns] };
  if (warns.length) return { kind: "preflight", level: "warn", summary: "派活前检查：有需要留意的地方", details: warns };
  return { kind: "preflight", level: "pass", summary: "派活前检查通过" };
}
