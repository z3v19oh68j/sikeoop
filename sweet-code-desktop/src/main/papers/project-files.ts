import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IGNORED_DIRS, isInside, realpathOfNew } from "../workspace.ts";

// Files of the open project, for the workshop's third batch (references.bib, documents to typeset,
// the new-paper template). Every path is given relative to the project and checked to stay in it,
// also through symlinks.

export class ProjectFiles {
  private readonly root: () => string;

  constructor(root: () => string) {
    this.root = root;
  }

  /** The file's real place on disk. Throws when the path leaves the project. */
  async resolve(relative: unknown): Promise<string> {
    if (typeof relative !== "string" || !relative.trim() || relative.length > 1000 || relative.includes("\0")) throw new Error("文件路径不正确");
    const root = await fs.realpath(this.root());
    const target = path.resolve(root, relative);
    const real = await realpathOfNew(target);
    if (!isInside(root, target) || !isInside(root, real) || real === root) throw new Error("路径超出了项目文件夹");
    return real;
  }

  /** A path inside the project as it is written in the window: relative, with forward slashes. */
  async relative(absolute: string): Promise<string> {
    return path.relative(await fs.realpath(this.root()), absolute).split(path.sep).join("/");
  }

  async isFile(relative: string): Promise<boolean> {
    return fs.stat(await this.resolve(relative)).then((s) => s.isFile(), () => false);
  }

  async modified(relative: string): Promise<number | undefined> {
    return fs.stat(await this.resolve(relative)).then((s) => s.mtimeMs, () => undefined);
  }

  async readText(relative: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    const file = await this.resolve(relative);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`没有找到 ${relative}`);
    if (stat.size > maxBytes) throw new Error(`${relative} 太大了（超过 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
    return fs.readFile(file, "utf8");
  }

  /** Adds a file; never replaces one that is there. */
  async writeNew(relative: string, content: string): Promise<void> {
    const file = await this.resolve(relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Resolved again: the folder exists now, so a symlink on the way would show.
    await fs.writeFile(await this.resolve(relative), content, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "EEXIST" ? new Error(`${relative} 已经存在，没有覆盖`) : e;
    });
  }

  /** Writes a file whole (temporary file, then renamed over it). */
  async writeText(relative: string, content: string): Promise<void> {
    const file = await this.resolve(relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const target = await this.resolve(relative);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await fs.writeFile(tmp, content, { flag: "wx" });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** The project's files whose name matches, nearest first; dependency and build folders are skipped. */
  async list(name: RegExp, max = 200): Promise<string[]> {
    const root = await fs.realpath(this.root());
    const out: string[] = [];
    let level = [root];
    for (let depth = 0; depth < 6 && level.length && out.length < max; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
          if (e.isDirectory()) next.push(path.join(dir, e.name));
          else if (e.isFile() && name.test(e.name) && out.length < max) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
        }
      }
      level = next;
    }
    return out;
  }
}
