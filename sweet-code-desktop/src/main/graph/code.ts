import { promises as fs } from "node:fs";
import path from "node:path";
import { readGitignore } from "../rag/code-index";
import { sha } from "../wiki/store";
import { IGNORED_DIRS } from "../workspace";

// The code side of the knowledge graph, read without a model: every source file's imports
// (resolved to project files) and exported names, then files grouped into at most MAX_MODULES
// modules (single files for small projects, folders for big ones) with import counts between them.
// The model only names and sorts these afterwards, so the edges are facts, not guesses.

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 300 * 1024;
export const MAX_MODULES = 60;

const SRC_EXT = new Set(
  "js jsx mjs cjs ts tsx mts cts vue svelte astro py go rs java kt kts swift dart rb php cs c h cc cpp cxx hpp hh lua ex exs scala".split(" "),
);
const JS_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"];
const SKIP = /\.(min|d)\.[cm]?[jt]s$|\.(test|spec|stories)\.[cm]?[jt]sx?$/;

export interface CodeFile {
  path: string;
  /** Project files it imports. */
  imports: string[];
  /** Exported or top-level names, a few. */
  symbols: string[];
}

export interface CodeModule {
  id: string;
  /** The file, or the folder ("." for the project root). */
  key: string;
  files: string[];
  symbols: string[];
}

export interface CodeScan {
  modules: CodeModule[];
  /** Import counts between modules. */
  links: { from: string; to: string; weight: number }[];
  fingerprint: string;
  files: number;
  truncated: boolean;
}

export async function scanCode(root: string, signal: AbortSignal): Promise<CodeScan> {
  const { files, stamp, truncated } = await listSources(root, signal);
  const all = new Set(files);
  const byBase = indexByStem(files);
  const parsed: CodeFile[] = [];
  for (const f of files) {
    if (signal.aborted) throw new Error("已停止");
    const text = await fs.readFile(path.join(root, f), "utf8").catch(() => "");
    parsed.push({ path: f, imports: resolveImports(f, text, all, byBase), symbols: symbolsOf(f, text) });
  }

  const keyOf = groupKeys(files);
  const modules = new Map<string, CodeModule>();
  for (const f of parsed) {
    const key = keyOf(f.path);
    let m = modules.get(key);
    if (!m) modules.set(key, (m = { id: `m${modules.size + 1}`, key, files: [], symbols: [] }));
    m.files.push(f.path);
    for (const s of f.symbols) if (m.symbols.length < 8 && !m.symbols.includes(s)) m.symbols.push(s);
  }
  const counts = new Map<string, number>();
  for (const f of parsed) {
    const from = modules.get(keyOf(f.path))!.id;
    for (const i of f.imports) {
      const to = modules.get(keyOf(i))?.id;
      if (!to || to === from) continue;
      const k = `${from}>${to}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return {
    modules: [...modules.values()],
    links: [...counts].map(([k, weight]) => {
      const [from, to] = k.split(">");
      return { from, to, weight };
    }),
    fingerprint: sha(stamp),
    files: files.length,
    truncated,
  };
}

/** Only the fingerprint: whether the code changed since a graph was built. */
export async function codeFingerprint(root: string): Promise<string> {
  return sha((await listSources(root, new AbortController().signal)).stamp);
}

async function listSources(root: string, signal: AbortSignal) {
  const ignore = await readGitignore(root);
  const files: string[] = [];
  const stamp: string[] = [];
  const queue = [""];
  let truncated = false;
  while (queue.length) {
    if (signal.aborted) throw new Error("已停止");
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".") && !ignore(rel, true)) queue.push(rel);
        continue;
      }
      const ext = e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase();
      if (!e.isFile() || !SRC_EXT.has(ext) || SKIP.test(e.name) || ignore(rel, false)) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const st = await fs.stat(path.join(root, rel)).catch(() => null);
      if (!st || st.size > MAX_FILE_BYTES) continue;
      files.push(rel);
      stamp.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  }
  return { files, stamp: stamp.join("\n"), truncated };
}

/**
 * Files themselves when there are few, else folders cut to the deepest level that still gives
 * at most MAX_MODULES groups.
 */
function groupKeys(files: string[]): (file: string) => string {
  if (files.length <= MAX_MODULES) return (f) => f;
  const dirOf = (f: string, depth: number) => {
    const parts = f.split("/").slice(0, -1);
    return parts.slice(0, depth).join("/") || ".";
  };
  const deepest = Math.max(...files.map((f) => f.split("/").length - 1));
  for (let d = deepest; d >= 1; d--) {
    if (new Set(files.map((f) => dirOf(f, d))).size <= MAX_MODULES) return (f) => dirOf(f, d);
  }
  return (f) => dirOf(f, 1);
}

/** Path without extension → files, for aliased imports ("@shared/types") matched by their tail. */
function indexByStem(files: string[]) {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const stem = f.replace(/\.[^./]+$/, "").replace(/\/(index|__init__)$/, "");
    const base = stem.slice(stem.lastIndexOf("/") + 1);
    map.set(base, [...(map.get(base) ?? []), f]);
  }
  return map;
}

function resolveImports(file: string, text: string, all: Set<string>, byBase: Map<string, string[]>): string[] {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const dir = path.posix.dirname(file);
  const specs: string[] = [];
  const grab = (re: RegExp) => {
    for (const m of text.matchAll(re)) specs.push(m[1]);
  };
  let exts: string[];
  if (JS_EXT.includes(ext) || ext === "astro") {
    grab(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g);
    grab(/import\s*['"]([^'"]+)['"]/g);
    grab(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g);
    exts = JS_EXT.flatMap((e) => [`.${e}`, `/index.${e}`]);
  } else if (ext === "py") {
    for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import|^\s*import\s+([\w.]+)/gm)) {
      const spec = m[1] ?? m[2];
      const dots = spec.match(/^\.*/)![0].length;
      const rest = spec.slice(dots).replace(/\./g, "/");
      specs.push(dots ? `${"../".repeat(dots - 1) || "./"}${rest}` : rest);
    }
    exts = [".py", "/__init__.py"];
  } else if (["java", "kt", "kts", "scala"].includes(ext)) {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) specs.push(m[1].replace(/\./g, "/"));
    exts = [".java", ".kt", ".scala"];
  } else if (["c", "h", "cc", "cpp", "cxx", "hpp", "hh"].includes(ext)) {
    grab(/^\s*#\s*include\s+"([^"]+)"/gm);
    exts = [""];
  } else return [];

  const out = new Set<string>();
  for (const spec of specs) {
    const hit = resolveOne(spec, dir, exts, all, byBase);
    if (hit && hit !== file) out.add(hit);
  }
  return [...out];
}

function resolveOne(spec: string, dir: string, exts: string[], all: Set<string>, byBase: Map<string, string[]>): string | null {
  const tryAt = (base: string) => {
    if (all.has(base)) return base;
    for (const e of exts) if (all.has(base + e)) return base + e;
    return null;
  };
  if (spec.startsWith(".")) return tryAt(path.posix.normalize(path.posix.join(dir, spec)));
  // From the root, or the source folder, or (aliases like "@/x", "~/x", "@shared/x") by its tail.
  const direct = tryAt(spec) ?? tryAt(`src/${spec}`);
  if (direct) return direct;
  const tail = spec.replace(/^[@~#][^/]*\//, "");
  const parts = tail.split("/");
  const cands = (byBase.get(parts[parts.length - 1]) ?? []).filter((f) => {
    const stem = f.replace(/\.[^./]+$/, "").replace(/\/(index|__init__)$/, "");
    return stem === tail || stem.endsWith("/" + tail);
  });
  return cands.length === 1 ? cands[0] : null;
}

function symbolsOf(file: string, text: string): string[] {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const re =
    ext === "py"
      ? /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm
      : JS_EXT.includes(ext)
        ? /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
        : /^(?:pub\s+)?(?:public\s+)?(?:func|fn|class|struct|interface|trait|object|def)\s+([A-Za-z_]\w*)/gm;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= 6) break;
  }
  return out;
}
