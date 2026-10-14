import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileNode } from "@shared/types";

/** Folders that are never shown in the tree or searched by the agent. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".cache", ".venv", "__pycache__", ".DS_Store",
]);

const MAX_TREE_ENTRIES = 2000;

let root: string | null = null;
/**
 * A root for the work going on in one async task, instead of the open project: a sub-agent whose
 * task runs in a sandbox copy (dispatch/sandbox.ts). Everything it calls sees the copy as the project.
 */
const scoped = new AsyncLocalStorage<string>();

export function getRoot(): string {
  const here = scoped.getStore() ?? root;
  if (!here) throw new Error("还没有打开项目文件夹");
  return here;
}

/** Runs `fn` with `dir` as the project folder for everything it does, awaited work included. */
export function withRoot<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return scoped.run(dir, fn);
}

export async function setRoot(dir: string): Promise<void> {
  root = await fs.realpath(dir);
}

export function hasRoot(): boolean {
  return (scoped.getStore() ?? root) !== null;
}

/**
 * Resolve a workspace-relative path and refuse anything that escapes the root,
 * including through symlinks. Every file access by the editor or the agent goes through here.
 */
export async function resolveSafe(rel: string): Promise<string> {
  const base = getRoot();
  const target = path.resolve(base, rel);
  const real = await realpathOfNew(target);
  if (!isInside(base, target) || !isInside(base, real)) {
    throw new Error(`路径 "${rel}" 在项目文件夹外面，不能访问`);
  }
  return real;
}

/** True when `p` is `dir` itself or somewhere below it. */
export function isInside(dir: string, p: string): boolean {
  const r = path.relative(dir, p);
  return !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r));
}

/**
 * The real path of `p`, even when it doesn't exist yet: the nearest existing folder above it
 * is resolved (so a symlinked parent can't lead out of the project) and the rest appended.
 */
export async function realpathOfNew(p: string): Promise<string> {
  let dir = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(dir), ...rest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const up = path.dirname(dir);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || up === dir) throw err;
      // There but unresolvable: a symlink to a missing place, which writing would create.
      if (await fs.lstat(dir).then(() => true, () => false)) throw new Error(`"${dir}" 是指向不存在位置的快捷方式，不能访问`);
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

export function toRel(abs: string): string {
  return path.relative(getRoot(), abs).split(path.sep).join("/");
}

export async function buildTree(maxDepth = 8): Promise<FileNode[]> {
  let count = 0;
  async function walk(dir: string, depth: number): Promise<FileNode[]> {
    if (depth > maxDepth || count > MAX_TREE_ENTRIES) return [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      if (++count > MAX_TREE_ENTRIES) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: toRel(abs), kind: "dir", children: await walk(abs, depth + 1) });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: toRel(abs), kind: "file" });
      }
    }
    return nodes;
  }
  return walk(getRoot(), 0);
}

/** A compact indented listing of the tree for the model, cut off at maxDepth / maxLines. */
export function treeToText(nodes: FileNode[], maxDepth = 3, maxLines = 300): string {
  const lines: string[] = [];
  function walk(list: FileNode[], depth: number) {
    for (const n of list) {
      if (lines.length >= maxLines) return;
      lines.push("  ".repeat(depth) + n.name + (n.kind === "dir" ? "/" : ""));
      if (n.kind === "dir" && n.children) {
        if (depth + 1 < maxDepth) walk(n.children, depth + 1);
        else if (n.children.length) lines.push("  ".repeat(depth + 1) + `…（${n.children.length} 项）`);
      }
    }
  }
  walk(nodes, 0);
  if (lines.length >= maxLines) lines.push("…（还有更多文件，用 list_files 查看）");
  return lines.join("\n");
}

export async function readWorkspaceFile(rel: string): Promise<string> {
  return fs.readFile(await resolveSafe(rel), "utf8");
}

export async function writeWorkspaceFile(rel: string, content: string): Promise<void> {
  await fs.writeFile(await resolveSafe(rel), content, "utf8");
}
