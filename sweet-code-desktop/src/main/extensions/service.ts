import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type {
  ExtensionContributions,
  ExtensionGrammar,
  ExtensionLanguage,
  ExtensionSearchItem,
  ExtensionSnippetSet,
  ExtensionSummary,
  ExtensionTheme,
  ExtensionThemeRule,
  InstalledExtension,
} from "@shared/types";

// Editor extensions from Open VSX, declarative parts only (layer A): color themes, TextMate
// grammars, language settings and snippets. A .vsix is a zip; we unpack it under
// userData/extensions/ with path and size checks, read package.json's "contributes", and hand the
// files' contents to the renderer. Nothing in an extension is ever executed.

const REGISTRY = "https://open-vsx.org";
const DOWNLOAD_HOSTS = /^(open-vsx\.org|openvsxorg\.blob\.core\.windows\.net)$/;
const MAX_VSIX = 512 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_FILE = 8 * 1024 * 1024;
/** Files kept from a vsix: manifests, themes, grammars, language settings, snippets, license, readme, icon. */
const KEEP = /^(.*\.(json|jsonc|tmLanguage|tmGrammar|plist|tmTheme|tmSnippet|code-snippets|png|svg|md|txt)|LICENSE.*|LICENCE.*|NOTICE.*)$/i;
const ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;
/** SPDX ids we treat as plainly open source; anything else gets a "read the license" note. */
const OPEN_LICENSES = /^(MIT|ISC|0BSD|BSD-[23]-Clause|Apache-2\.0|MPL-2\.0|EPL-[12]\.0|LGPL-[23]\.0(-only|-or-later)?|GPL-[23]\.0(-only|-or-later)?|Unlicense|CC0-1\.0|WTFPL|Zlib)$/i;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface IndexEntry {
  id: string;
  version: string;
  dir: string;
  displayName: string;
  publisher: string;
  description: string;
  license?: string;
  enabled: boolean;
  installedAt: number;
}

interface Manifest {
  name?: string;
  publisher?: string;
  displayName?: string;
  description?: string;
  version?: string;
  license?: string;
  main?: string;
  browser?: string;
  contributes?: {
    themes?: { label?: string; uiTheme?: string; path?: string; id?: string }[];
    iconThemes?: unknown[];
    grammars?: { language?: string; scopeName?: string; path?: string; embeddedLanguages?: Record<string, string>; injectTo?: string[] }[];
    languages?: { id?: string; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[]; aliases?: string[]; configuration?: string }[];
    snippets?: { language?: string; path?: string }[];
  };
}

export class ExtensionService {
  private index: IndexEntry[] | null = null;
  private cache: ExtensionContributions | null = null;
  private busy = new Set<string>();
  private readonly dir: string;
  private readonly fetch: Fetch;
  private readonly onChange: () => void;

  constructor(dir: string, fetchImpl: Fetch, onChange: () => void) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.onChange = onChange;
  }

  private get indexFile() {
    return path.join(this.dir, "installed.json");
  }

  private async load(): Promise<IndexEntry[]> {
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(await fs.readFile(this.indexFile, "utf8")) as IndexEntry[];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private async saveIndex() {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.index ?? [], null, 2));
    await fs.rename(tmp, this.indexFile);
  }

  private async getJson<T>(url: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(res.status === 404 ? "Open VSX 上没有这个扩展" : `Open VSX 返回 ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("连 Open VSX 超时了，稍后再试");
      throw e instanceof Error && /fetch failed|ENOTFOUND|ECONN/i.test(e.message) ? new Error("连不上 Open VSX（open-vsx.org）") : e;
    } finally {
      clearTimeout(timer);
    }
  }

  private searchCache = new Map<string, { at: number; value: { total: number; items: ExtensionSearchItem[] } }>();

  async search(query: string, offset = 0): Promise<{ total: number; items: ExtensionSearchItem[] }> {
    const q = query.trim().slice(0, 100);
    // The same search within a few minutes (switching tabs, going back) doesn't go out again.
    const key = `${q}\u0000${offset}`;
    const hit = this.searchCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const value = await this.searchRemote(q, offset);
    this.searchCache.set(key, { at: Date.now(), value });
    if (this.searchCache.size > 50) this.searchCache.delete(this.searchCache.keys().next().value!);
    return value;
  }

  private async searchRemote(q: string, offset: number): Promise<{ total: number; items: ExtensionSearchItem[] }> {
    const url = `${REGISTRY}/api/-/search?${new URLSearchParams({ query: q, size: "30", offset: String(Math.max(0, offset | 0)), sortBy: q ? "relevance" : "downloadCount", sortOrder: "desc" })}`;
    const r = await this.getJson<{ totalSize?: number; extensions?: Record<string, unknown>[] }>(url);
    const items = (r.extensions ?? []).map((e) => {
      const files = (e.files ?? {}) as Record<string, string>;
      return {
        id: `${e.namespace}.${e.name}`,
        namespace: String(e.namespace ?? ""),
        name: String(e.name ?? ""),
        displayName: String(e.displayName || e.name || ""),
        description: String(e.description ?? ""),
        version: String(e.version ?? ""),
        ...(files.icon ? { iconUrl: files.icon } : {}),
        ...(typeof e.downloadCount === "number" ? { downloads: e.downloadCount } : {}),
        ...(typeof e.averageRating === "number" ? { rating: e.averageRating } : {}),
        ...(e.verified ? { verified: true } : {}),
      } satisfies ExtensionSearchItem;
    });
    return { total: r.totalSize ?? items.length, items };
  }

  async installed(): Promise<InstalledExtension[]> {
    const list = await this.load();
    return Promise.all(list.map(async (e) => this.view(e, await this.manifest(e).catch(() => ({}) as Manifest))));
  }

  private view(e: IndexEntry, m: Manifest): InstalledExtension {
    const c = m.contributes ?? {};
    const summary: ExtensionSummary = {
      themes: c.themes?.length ?? 0,
      grammars: c.grammars?.length ?? 0,
      languages: c.languages?.length ?? 0,
      snippets: c.snippets?.length ?? 0,
      iconThemes: c.iconThemes?.length ?? 0,
      hasCode: !!(m.main || m.browser),
    };
    const lic = e.license?.trim();
    return {
      id: e.id,
      displayName: e.displayName,
      publisher: e.publisher,
      version: e.version,
      description: e.description,
      ...(lic ? { license: lic } : {}),
      ...(!lic || !OPEN_LICENSES.test(lic) ? { licenseNote: lic ? `协议是「${lic.slice(0, 60)}」，不是常见的开源协议，用之前看一下它允许在哪里用` : "没写协议，用之前看一下扩展主页" } : {}),
      enabled: e.enabled,
      installedAt: e.installedAt,
      summary,
    };
  }

  /** Downloads the latest version from Open VSX and unpacks it (replacing an older version). */
  async install(id: string): Promise<InstalledExtension[]> {
    if (!ID.test(id)) throw new Error("扩展名字不对");
    if (this.busy.has(id)) throw new Error("这个扩展正在安装");
    this.busy.add(id);
    try {
      const [ns, ...rest] = id.split(".");
      const name = rest.join(".");
      const meta = await this.getJson<{ version?: string; license?: string; displayName?: string; description?: string; files?: Record<string, string> }>(
        `${REGISTRY}/api/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
      );
      const version = String(meta.version ?? "");
      const url = meta.files?.download;
      if (!url || !/^[\w.+-]+$/.test(version)) throw new Error("Open VSX 没给下载地址");
      const target = path.join(this.dir, `${id}@${version}`);
      // Fast path: fetch only the few files layer A reads (often a few KB of a package of tens of MB).
      // If Open VSX can't serve single files for this one, fall back to the whole package.
      const lite = await this.fetchDeclarative(ns, name, version, target).catch((e) => {
        console.warn("[extensions] per-file install failed, downloading the package", id, e instanceof Error ? e.message : e);
        return false;
      });
      if (!lite) {
        const vsix = await this.download(url);
        const expected = meta.files?.sha256 ? (await this.text(meta.files.sha256)).trim().split(/\s+/)[0] : "";
        if (expected && createHash("sha256").update(vsix).digest("hex") !== expected.toLowerCase()) throw new Error("下载的文件校验不对，已丢弃");
        await this.unpack(vsix, target);
      }
      const manifest = await readJsonc<Manifest>(path.join(target, "package.json"));
      if (!manifest) {
        await fs.rm(target, { recursive: true, force: true });
        throw new Error("这个扩展包里没有 package.json");
      }

      const list = await this.load();
      const old = list.find((e) => e.id === id);
      const entry: IndexEntry = {
        id,
        version,
        dir: path.basename(target),
        displayName: manifest.displayName || meta.displayName || name,
        publisher: manifest.publisher || ns,
        description: manifest.description || meta.description || "",
        license: manifest.license || meta.license,
        enabled: old?.enabled ?? true,
        installedAt: Date.now(),
      };
      this.index = [...list.filter((e) => e.id !== id), entry];
      await this.saveIndex();
      if (old && old.dir !== entry.dir) await fs.rm(path.join(this.dir, old.dir), { recursive: true, force: true });
      this.changed();
      return this.installed();
    } finally {
      this.busy.delete(id);
    }
  }

  async uninstall(id: string): Promise<InstalledExtension[]> {
    const list = await this.load();
    const e = list.find((x) => x.id === id);
    if (e) {
      this.index = list.filter((x) => x.id !== id);
      await this.saveIndex();
      await fs.rm(path.join(this.dir, e.dir), { recursive: true, force: true });
      this.changed();
    }
    return this.installed();
  }

  async setEnabled(id: string, on: boolean): Promise<InstalledExtension[]> {
    const list = await this.load();
    const e = list.find((x) => x.id === id);
    if (e && e.enabled !== on) {
      e.enabled = on;
      await this.saveIndex();
      this.changed();
    }
    return this.installed();
  }

  private changed() {
    this.cache = null;
    this.onChange();
  }

  private async download(url: string): Promise<Uint8Array> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !DOWNLOAD_HOSTS.test(u.hostname)) throw new Error("下载地址不是 Open VSX 的");
    const ctrl = new AbortController();
    // Slow links are fine; a download that stops moving for 30 s is given up.
    let timer = setTimeout(() => ctrl.abort(), 30_000);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), 30_000);
    };
    try {
      const res = await this.fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_VSIX) throw new Error("扩展包太大了（超过 512MB）");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        size += value.byteLength;
        if (size > MAX_VSIX) {
          ctrl.abort();
          throw new Error("扩展包太大了（超过 512MB）");
        }
        chunks.push(value);
      }
      const out = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("下载卡住了（30 秒没有动静），网络不好时可以稍后再试");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Layer A without the package: package.json, then just the files its "contributes" names (themes and
   * their includes, grammars, language settings, snippets) plus the license, from Open VSX's per-file
   * endpoint. Written to a temp folder and moved into place only when every file arrived.
   */
  private async fetchDeclarative(ns: string, name: string, version: string, target: string): Promise<boolean> {
    const base = `${REGISTRY}/vscode/unpkg/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/extension/`;
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.rm(tmp, { recursive: true, force: true });
    const got = new Map<string, Buffer>();
    const get = async (rel: string, optional = false): Promise<Buffer | null> => {
      const clean = path.posix.normalize(rel.replace(/\\/g, "/").replace(/^\.\//, ""));
      if (!clean || clean.startsWith("..") || path.posix.isAbsolute(clean) || clean.includes("\0")) return null;
      // Same rule as unpacking a package: only data files, never scripts or binaries.
      if (!KEEP.test(path.posix.basename(clean))) return null;
      if (got.has(clean)) return got.get(clean)!;
      if (got.size >= 300) throw new Error("too many files");
      const buf = await this.fetchFile(base + clean.split("/").map(encodeURIComponent).join("/"), optional);
      if (buf) got.set(clean, buf);
      return buf;
    };
    const pkgBuf = await get("package.json");
    if (!pkgBuf) return false;
    const m = parseJsonc(pkgBuf.toString("utf8"), [], { allowTrailingComma: true }) as Manifest;
    const c = m?.contributes ?? {};
    const wanted = [
      ...(c.grammars ?? []).map((g) => g.path),
      ...(c.languages ?? []).map((l) => l.configuration),
      ...(c.snippets ?? []).map((x) => x.path),
    ].filter((p): p is string => typeof p === "string");
    await pool(wanted, 4, async (p) => void (await get(p)));
    // Themes can include other theme files (or a tokenColors file): follow them, a few levels deep.
    let themeFiles = (c.themes ?? []).map((t) => t.path).filter((p): p is string => typeof p === "string");
    for (let depth = 0; depth < 5 && themeFiles.length; depth++) {
      const next: string[] = [];
      await pool(themeFiles, 4, async (p) => {
        const buf = await get(p);
        if (!buf || !/\.json$/i.test(p)) return;
        const t = parseJsonc(buf.toString("utf8"), [], { allowTrailingComma: true }) as { include?: unknown; tokenColors?: unknown } | undefined;
        for (const ref of [t?.include, t?.tokenColors]) if (typeof ref === "string") next.push(path.posix.join(path.posix.dirname(p.replace(/^\.\//, "")), ref));
      });
      themeFiles = next;
    }
    for (const lic of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) if (await get(lic, true)) break;

    try {
      for (const [rel, data] of got) {
        const dest = path.resolve(tmp, rel);
        if (!dest.startsWith(path.resolve(tmp) + path.sep)) throw new Error("扩展里有不安全的路径");
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data);
      }
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(tmp, target);
      return true;
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  /** One file from Open VSX, retried once on a network hiccup. null = 404 when optional. */
  private async fetchFile(url: string, optional: boolean): Promise<Buffer | null> {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await this.fetch(url, { signal: ctrl.signal });
        if (res.status === 404 && optional) return null;
        if (!res.ok) throw new Error(`Open VSX 返回 ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_FILE) throw new Error("扩展里的文件太大了");
        return buf;
      } catch (e) {
        if (attempt >= 1 || (e instanceof Error && /返回 4\d\d|太大/.test(e.message))) throw e;
        await new Promise((r) => setTimeout(r, 800));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async text(url: string): Promise<string> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !DOWNLOAD_HOSTS.test(u.hostname)) return "";
    const res = await this.fetch(url);
    return res.ok ? (await res.text()).slice(0, 1000) : "";
  }

  /** Unpacks only extension/** of the vsix into target, refusing paths that escape it and oversized content. */
  private async unpack(vsix: Uint8Array, target: string) {
    let entries = 0;
    let total = 0;
    const files = unzipSync(vsix, {
      filter: (f) => {
        if (++entries > MAX_ENTRIES) throw new Error("扩展包里的文件太多了");
        if (!f.name.startsWith("extension/") || f.name.endsWith("/") || f.name.includes("/node_modules/")) return false;
        // Only what layer A reads: no scripts, no binaries, so no extension code is even on disk.
        if (!KEEP.test(f.name.slice(f.name.lastIndexOf("/") + 1))) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_FILE * 4 || total > MAX_UNPACKED) throw new Error("扩展包解开后太大了");
        return true;
      },
    });
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.rm(tmp, { recursive: true, force: true });
    try {
      for (const [name, data] of Object.entries(files)) {
        const rel = name.slice("extension/".length);
        const dest = path.resolve(tmp, rel);
        if (!rel || rel.includes("\0") || path.isAbsolute(rel) || !dest.startsWith(path.resolve(tmp) + path.sep)) throw new Error("扩展包里有不安全的路径");
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data);
      }
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(tmp, target);
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  private manifest(e: IndexEntry): Promise<Manifest> {
    return readJsonc<Manifest>(path.join(this.dir, e.dir, "package.json")).then((m) => m ?? {});
  }

  /** Everything the enabled extensions contribute, read from disk once and cached until a change. */
  async contributions(): Promise<ExtensionContributions> {
    if (this.cache) return this.cache;
    const out: ExtensionContributions = { themes: [], grammars: [], languages: [], snippets: [] };
    for (const e of (await this.load()).filter((x) => x.enabled)) {
      const root = path.join(this.dir, e.dir);
      const m = await this.manifest(e);
      const c = m.contributes ?? {};
      for (const t of c.themes ?? []) {
        const theme = await readTheme(root, t.path);
        if (!theme) continue;
        const label = String(t.label || t.id || path.basename(t.path ?? "", ".json"));
        out.themes.push({
          id: `${e.id}/${label}`,
          label,
          extensionId: e.id,
          uiTheme: t.uiTheme === "vs" || t.uiTheme === "hc-black" || t.uiTheme === "hc-light" ? t.uiTheme : "vs-dark",
          ...theme,
        });
      }
      for (const g of c.grammars ?? []) {
        const file = inside(root, g.path);
        if (!file || !g.scopeName) continue;
        const content = await readText(file);
        if (content === null) continue;
        out.grammars.push({
          scopeName: g.scopeName,
          ...(g.language ? { language: g.language } : {}),
          content,
          format: /\.json$/i.test(file) ? "json" : "plist",
          ...(g.embeddedLanguages ? { embeddedLanguages: g.embeddedLanguages } : {}),
          ...(g.injectTo ? { injectTo: g.injectTo } : {}),
        } satisfies ExtensionGrammar);
      }
      for (const l of c.languages ?? []) {
        if (!l.id) continue;
        const cfgFile = inside(root, l.configuration);
        const configuration = cfgFile ? await readJsonc<Record<string, unknown>>(cfgFile) : null;
        out.languages.push({
          id: l.id,
          ...(l.extensions ? { extensions: l.extensions } : {}),
          ...(l.filenames ? { filenames: l.filenames } : {}),
          ...(l.filenamePatterns ? { filenamePatterns: l.filenamePatterns } : {}),
          ...(l.aliases ? { aliases: l.aliases } : {}),
          ...(configuration ? { configuration } : {}),
        } satisfies ExtensionLanguage);
      }
      for (const sn of c.snippets ?? []) {
        const file = inside(root, sn.path);
        if (!file || !sn.language) continue;
        const snippets = await readJsonc<ExtensionSnippetSet["snippets"]>(file);
        if (snippets) out.snippets.push({ language: sn.language, extensionId: e.id, snippets });
      }
    }
    this.cache = out;
    return out;
  }
}

/** Runs f over items with at most n at a time. */
async function pool<T>(items: T[], n: number, f: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await f(queue.shift()!);
  }));
}

/** A path from package.json, resolved inside the extension folder; null if it points outside. */
function inside(root: string, rel: string | undefined): string | null {
  if (!rel || typeof rel !== "string") return null;
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}

async function readText(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJsonc<T>(file: string): Promise<T | null> {
  const text = await readText(file);
  if (text === null) return null;
  const errors: ParseError[] = [];
  const v = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  return v && typeof v === "object" ? (v as T) : null;
}

/** A color theme file, with its "include" chain merged in (parents first). JSON themes only. */
async function readTheme(root: string, rel: string | undefined, depth = 0): Promise<{ colors: Record<string, string>; tokenColors: ExtensionThemeRule[] } | null> {
  // rel is relative to the extension root; includes are relative to the including file but must stay inside the root.
  const file = inside(root, rel);
  if (!file || depth > 5 || !/\.json$/i.test(file)) return null;
  const t = await readJsonc<{ include?: string; colors?: Record<string, unknown>; tokenColors?: unknown }>(file);
  if (!t) return null;
  const near = (p: string) => path.relative(root, path.resolve(path.dirname(file), p));
  const base = t.include ? await readTheme(root, near(t.include), depth + 1).catch(() => null) : null;
  const colors: Record<string, string> = { ...(base?.colors ?? {}) };
  for (const [k, v] of Object.entries(t.colors ?? {})) if (typeof v === "string") colors[k] = v;
  let rules: ExtensionThemeRule[] = [];
  if (Array.isArray(t.tokenColors)) rules = t.tokenColors as ExtensionThemeRule[];
  else if (typeof t.tokenColors === "string") {
    const subFile = inside(root, near(t.tokenColors));
    const sub = subFile ? await readJsonc<{ tokenColors?: ExtensionThemeRule[] } | ExtensionThemeRule[]>(subFile) : null;
    rules = Array.isArray(sub) ? sub : (sub?.tokenColors ?? []);
  }
  return { colors, tokenColors: [...(base?.tokenColors ?? []), ...rules.filter((r) => r && typeof r === "object" && r.settings)] };
}
