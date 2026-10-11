import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { glob } from "tinyglobby";
import { z } from "zod";
import { IGNORED_DIRS, getRoot, resolveSafe, toRel } from "../workspace";
import { defineTool } from "./registry";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST = 500;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

const IGNORE_GLOBS = [...IGNORED_DIRS].map((d) => `**/${d}/**`);

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const listFiles = defineTool({
  name: "list_files",
  description:
    "List files in the project. Use a glob pattern to filter, e.g. \"src/**/*.ts\" or \"*.json\". " +
    "Common build and dependency folders (node_modules, .git, dist…) are skipped. Paths are relative to the project root.",
  schema: z.object({
    pattern: z.string().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the project root. Defaults to \"**/*\"." },
    },
  },
  permission: "auto",
  parallelSafe: true,
  summarize: (i) => `查看文件列表 ${i.pattern ?? ""}`.trim(),
  async run({ pattern }) {
    const files = await glob(pattern || "**/*", {
      cwd: getRoot(),
      ignore: IGNORE_GLOBS,
      dot: true,
      onlyFiles: true,
    });
    files.sort();
    if (files.length === 0) return "没有匹配的文件。";
    const shown = files.slice(0, MAX_LIST);
    const more = files.length > MAX_LIST ? `\n…还有 ${files.length - MAX_LIST} 个文件，换个更具体的 pattern 再查。` : "";
    return shown.join("\n") + more;
  },
});

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a text file from the project. Returns the content with 1-based line numbers. " +
    "For long files, pass start_line / end_line to read a slice.",
  schema: z.object({
    path: z.string().min(1),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root." },
      start_line: { type: "integer", description: "First line to read (1-based)." },
      end_line: { type: "integer", description: "Last line to read (inclusive)." },
    },
    required: ["path"],
  },
  permission: "auto",
  parallelSafe: true,
  summarize: (i) => `阅读 ${i.path}`,
  async run({ path, start_line, end_line }, ctx) {
    const abs = await resolveSafe(path);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`${path} 是文件夹，请用 list_files 查看里面的内容`);
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) return `${path} 是二进制文件（${stat.size} 字节），无法按文本读取。`;
    const text = buf.toString("utf8");
    // Editing is allowed only against the version the model has seen.
    ctx.readTracker.set(toRel(abs), hashText(text));
    const lines = text.split("\n");
    const from = Math.max(1, start_line ?? 1);
    const to = Math.min(lines.length, end_line ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
    let out = "";
    for (let n = from; n <= to; n++) {
      const line = `${String(n).padStart(5)}\t${lines[n - 1]}\n`;
      if (out.length + line.length > MAX_READ_BYTES) {
        out += `…（内容太长，在第 ${n} 行截断；用 start_line=${n} 继续读）\n`;
        return out;
      }
      out += line;
    }
    if (to < lines.length) out += `…（共 ${lines.length} 行，已显示 ${from}-${to}；用 start_line=${to + 1} 继续读）\n`;
    return out || "（空文件）";
  },
});

export const searchCode = defineTool({
  name: "search",
  description:
    "Search file contents in the project, like grep. Returns matching lines as path:line: text. " +
    "Set is_regex for a regular expression; otherwise the query is matched literally and case-insensitively. " +
    "Use include to limit which files are searched, e.g. \"**/*.css\".",
  schema: z.object({
    query: z.string().min(1),
    is_regex: z.boolean().optional(),
    include: z.string().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text or regular expression to look for." },
      is_regex: { type: "boolean", description: "Treat query as a JavaScript regular expression." },
      include: { type: "string", description: "Glob of files to search. Defaults to all files." },
    },
    required: ["query"],
  },
  permission: "auto",
  parallelSafe: true,
  summarize: (i) => `搜索「${i.query}」`,
  async run({ query, is_regex, include }, { signal }) {
    let re: RegExp;
    try {
      re = is_regex ? new RegExp(query) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      throw new Error(`正则表达式写错了：${(e as Error).message}`);
    }
    const root = getRoot();
    const files = await glob(include || "**/*", { cwd: root, ignore: IGNORE_GLOBS, dot: true, onlyFiles: true, absolute: true });
    files.sort();
    const hits: string[] = [];
    for (const abs of files) {
      if (signal.aborted || hits.length >= MAX_MATCHES) break;
      let buf: Buffer;
      try {
        const st = await fs.stat(abs);
        if (st.size > MAX_SEARCH_FILE_BYTES) continue;
        buf = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) hits.push(`${toRel(abs)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      }
    }
    if (hits.length === 0) return "没有找到匹配的内容。";
    const more = hits.length >= MAX_MATCHES ? `\n…结果太多，只显示前 ${MAX_MATCHES} 条，可以用 include 缩小范围。` : "";
    return hits.join("\n") + more;
  },
});

export const READ_ONLY_TOOLS = [listFiles, readFile, searchCode];
