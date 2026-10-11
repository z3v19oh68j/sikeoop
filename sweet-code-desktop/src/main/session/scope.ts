import { promises as fs } from "node:fs";
import path from "node:path";

/** Canonicalize even a new nested file; never follow a dangling symlink as a missing directory. */
export async function realFile(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("文件路径必须是绝对路径");
  let current = path.resolve(file);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const entry = await fs.lstat(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
        return null;
      });
      if (entry?.isSymbolicLink()) throw new Error("拒绝无法解析的软链接");
      const parent = path.dirname(current);
      if (parent === current) throw e;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

export async function canonicalRoots(roots: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new Error("目录必须是绝对路径");
    const real = await fs.realpath(root);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("请选择目录");
    if (!result.includes(real)) result.push(real);
  }
  return result;
}

export async function checkScope(file: string, roots: string[]): Promise<{ allowed: boolean; path: string }> {
  const real = await realFile(file);
  const canonical = await canonicalRoots(roots);
  return { allowed: canonical.some((root) => within(root, real)), path: real };
}
