import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheatshopFile, CheatshopResult, CheatshopSection, CheatshopTree } from "../../shared/types.ts";

/**
 * Read-only service for the external `game-cheat-workshop` directory. It lives next to
 * sweet-code-desktop in development, and ships as an extraResource (`resources/cheatshop`) in the
 * installer. Everything is text; the service never writes.
 */

const TEXT_EXTS = new Set([
  ".md", ".mdx", ".txt",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hh", ".ino",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".cs", ".java", ".kt", ".go", ".rs", ".swift",
  ".php", ".rb", ".lua",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".aa", ".ct", ".asm", ".s",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".xml", ".html", ".css",
]);
/** 1 MiB — a single teaching template; anything larger is almost certainly the wrong file. */
const MAX_READ_BYTES = 1_048_576;

export class CheatshopService {
  constructor(private readonly rootPath: string) {}

  private async rootExists(): Promise<boolean> {
    try {
      const s = await fs.stat(this.rootPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /** Resolve a user-supplied relative path, confirming it stays under the workshop root. */
  private resolveSafe(rel: string): string | null {
    if (typeof rel !== "string" || !rel.length) return null;
    // Reject NUL and absolute paths outright; path.resolve handles ".." but we double-check below.
    if (rel.includes("\0") || path.isAbsolute(rel)) return null;
    const abs = path.resolve(this.rootPath, rel);
    const rootWithSep = this.rootPath.endsWith(path.sep) ? this.rootPath : this.rootPath + path.sep;
    if (abs !== this.rootPath && !abs.startsWith(rootWithSep)) return null;
    return abs;
  }

  async tree(): Promise<CheatshopResult<CheatshopTree>> {
    if (!(await this.rootExists())) {
      return { ok: false, message: `未找到外挂工坊目录：${this.rootPath}` };
    }
    try {
      const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
      let readme: string | null = null;
      let index: string | null = null;
      const dirs: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!e.name.startsWith(".")) dirs.push(e.name);
        } else if (e.isFile()) {
          if (/^readme\.mdx?$/i.test(e.name)) readme = e.name;
          else if (/^index\.mdx?$/i.test(e.name)) index = e.name;
        }
      }
      dirs.sort();
      const sections: CheatshopSection[] = [];
      for (const dir of dirs) {
        const abs = path.join(this.rootPath, dir);
        const inner = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
        const files: CheatshopFile[] = [];
        for (const f of inner) {
          if (!f.isFile()) continue;
          if (f.name.startsWith(".")) continue;
          const ext = path.extname(f.name).toLowerCase();
          if (!TEXT_EXTS.has(ext)) continue;
          const stat = await fs.stat(path.join(abs, f.name)).catch(() => null);
          if (!stat) continue;
          files.push({ path: `${dir}/${f.name}`, name: f.name, ext, size: stat.size });
        }
        // README first in each section, then alphabetical.
        files.sort((a, b) => {
          const ar = /^readme\.mdx?$/i.test(a.name) ? 0 : 1;
          const br = /^readme\.mdx?$/i.test(b.name) ? 0 : 1;
          return ar - br || a.name.localeCompare(b.name);
        });
        const title = await readSectionTitle(abs, dir);
        const order = /^(\d+)/.exec(dir)?.[1] ?? "";
        sections.push({ dir, order, title, files });
      }
      return { ok: true, data: { rootPath: this.rootPath, readme, index, sections } };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async read(rel: unknown): Promise<CheatshopResult<{ text: string; ext: string; size: number }>> {
    const relStr = typeof rel === "string" ? rel : "";
    const abs = this.resolveSafe(relStr);
    if (!abs) return { ok: false, message: "非法路径" };
    const ext = path.extname(abs).toLowerCase();
    if (!TEXT_EXTS.has(ext)) return { ok: false, message: `不支持的文件类型：${ext || "(无扩展名)"}` };
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return { ok: false, message: "文件不存在" };
    }
    if (!stat.isFile()) return { ok: false, message: "不是普通文件" };
    if (stat.size > MAX_READ_BYTES) return { ok: false, message: `文件过大（${stat.size} 字节），已拒绝读取` };
    try {
      const text = await fs.readFile(abs, "utf8");
      return { ok: true, data: { text, ext, size: stat.size } };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Pull the first `# heading` out of the section README; fall back to the directory name. */
async function readSectionTitle(dir: string, fallback: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    const p = path.join(dir, name);
    try {
      const text = await fs.readFile(p, "utf8");
      const match = /^#\s+(.+?)\s*$/m.exec(text);
      if (match) return match[1].trim();
    } catch {
      // next candidate
    }
  }
  return fallback;
}
