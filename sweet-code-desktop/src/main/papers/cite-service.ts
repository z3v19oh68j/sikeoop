import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BibFormat, BibSettings, BibState, BibSyncRequest, BibSyncResult, CitePick, CiteRef, CiteStyle, PaperDoc, ZoteroCollection, ZoteroItem, ZoteroStatus } from "@shared/types";
import { bibKeys, mergeBib } from "./bib.ts";
import { citeStyleFor, citedKeys, formatCitation, validCitekey } from "./cite.ts";
import type { ProjectFiles } from "./project-files.ts";
import type { ZoteroClient } from "./zotero.ts";

// Citations for the workshop (docs/方案-论文工坊.md §8.1): Zotero's picker, searching the library,
// keeping the project's .bib file filled from Zotero, and reading an item's PDF into the workshop.
// Zotero is only ever reached on 127.0.0.1 (zotero.ts); nothing here uses the network.

export interface CiteDeps {
  userData(): string;
  root(): string;
  zotero: Pick<ZoteroClient, "status" | "pick" | "search" | "pdfs" | "exportKnown" | "collections" | "exportCollection">;
  files: Pick<ProjectFiles, "resolve" | "isFile" | "modified" | "readText" | "writeText">;
  /** Asks before the .bib file is written. */
  approveWrite(file: string, summary: string): Promise<boolean>;
  /** Reads a PDF into the workshop as a paper with this citekey. */
  importPdf(file: string, meta: { citekey: string; title: string; authors: string[] }): Promise<PaperDoc>;
}

const DEFAULT_SETTINGS: BibSettings = { file: "references.bib", format: "biblatex" };
const MAX_DOCUMENTS = 20;
const MAX_KEYS = 2000;

const style = (v: unknown): CiteStyle => {
  if (v !== "pandoc" && v !== "latex") throw new Error("引用格式只能是 Markdown 或 LaTeX");
  return v;
};
const format = (v: unknown): BibFormat => {
  if (v !== "biblatex" && v !== "bibtex") throw new Error("参考文献格式只能是 BibLaTeX 或 BibTeX");
  return v;
};
const bibPath = (v: unknown): string => {
  if (typeof v !== "string" || !/\.bib$/i.test(v.trim()) || v.length > 500) throw new Error("参考文献文件要以 .bib 结尾");
  return v.trim().replace(/\\/g, "/").replace(/^\.\//, "");
};

export class CiteService {
  private readonly deps: CiteDeps;
  /** The picker that is open now: Zotero shows one at a time. */
  private picking: AbortController | null = null;

  constructor(deps: CiteDeps) {
    this.deps = deps;
  }

  status(): Promise<ZoteroStatus> {
    return this.deps.zotero.status();
  }

  /** Opens Zotero's picker and waits for the choice, however long the user takes. */
  async pick(styleIn: unknown): Promise<CitePick | null> {
    const s = style(styleIn);
    if (this.picking) throw new Error("引用选择框已经开着：到 Zotero 里选完，或把它关掉");
    const mine = (this.picking = new AbortController());
    try {
      return await this.deps.zotero.pick(s, mine.signal);
    } finally {
      if (this.picking === mine) this.picking = null;
    }
  }

  cancelPick(): void {
    this.picking?.abort();
  }

  async search(terms: unknown): Promise<ZoteroItem[]> {
    if (typeof terms !== "string" || !terms.trim() || terms.length > 300) throw new Error("请输入要找的标题、作者或年份（300 字以内）");
    return this.deps.zotero.search(terms.trim());
  }

  collections(): Promise<ZoteroCollection[]> {
    return this.deps.zotero.collections();
  }

  format(refs: unknown, styleIn: unknown): string {
    if (!Array.isArray(refs) || !refs.length || refs.length > 50) throw new Error("请选择 1 到 50 篇文献");
    const clean: CiteRef[] = refs.map((r) => {
      const ref = (r ?? {}) as CiteRef;
      if (!validCitekey(ref.citekey)) throw new Error("有文献的引用 key 不能用，请到 Zotero 里检查");
      const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
      return { citekey: ref.citekey, locator: short(ref.locator), prefix: short(ref.prefix), suffix: short(ref.suffix), suppressAuthor: ref.suppressAuthor === true };
    });
    return formatCitation(clean, style(styleIn));
  }

  /** Reads the item's PDF (the first one Zotero has for it) into the workshop. */
  async import(itemIn: unknown): Promise<PaperDoc> {
    const item = (itemIn ?? {}) as ZoteroItem;
    if (!validCitekey(item.citekey)) throw new Error("这篇文献的引用 key 不能用");
    const pdfs = await this.deps.zotero.pdfs(item.citekey);
    const usable: string[] = [];
    for (const file of pdfs) if (path.isAbsolute(file) && (await fs.stat(file).then((s) => s.isFile(), () => false))) usable.push(file);
    if (!usable.length) throw new Error(pdfs.length ? "Zotero 记着这篇文献的 PDF，但文件不在这台电脑上（可能还没同步下来）" : "这篇文献在 Zotero 里没有 PDF 附件");
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 500) : item.citekey;
    const authors = Array.isArray(item.authors) ? item.authors.filter((a): a is string => typeof a === "string").slice(0, 20) : [];
    return this.deps.importPdf(usable[0], { citekey: item.citekey, title, authors });
  }

  // ---- references.bib ----

  private settingsFile(): string {
    return path.join(this.deps.userData(), "papers-cite", createHash("sha256").update(this.deps.root()).digest("hex").slice(0, 16) + ".json");
  }

  private async settings(): Promise<BibSettings> {
    try {
      const s = JSON.parse(await fs.readFile(this.settingsFile(), "utf8")) as BibSettings;
      const c = s.collection;
      return {
        file: bibPath(s.file),
        format: format(s.format),
        ...(c && Number.isInteger(c.libraryId) && typeof c.key === "string" && typeof c.path === "string" ? { collection: { libraryId: c.libraryId, key: c.key, path: c.path } } : {}),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private async saveSettings(s: BibSettings): Promise<void> {
    const file = this.settingsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async bibState(file?: unknown): Promise<BibState> {
    const saved = await this.settings();
    const settings = file === undefined || file === null ? saved : { ...saved, file: bibPath(file) };
    await this.deps.files.resolve(settings.file);
    const exists = await this.deps.files.isFile(settings.file);
    return {
      settings,
      exists,
      entries: exists ? bibKeys(await this.deps.files.readText(settings.file, 20 * 1024 * 1024)).length : 0,
      updatedAt: exists ? await this.deps.files.modified(settings.file) : undefined,
    };
  }

  /**
   * Fills the .bib file from Zotero: a whole collection, or just the entries the documents cite.
   * What only the file has is kept (bib.ts mergeBib). Asks before writing; writes nothing when
   * nothing would change.
   */
  async bibSync(input: unknown): Promise<BibSyncResult> {
    if (!input || typeof input !== "object") throw new Error("同步请求格式不正确");
    const req = input as BibSyncRequest;
    const file = bibPath(req.file);
    const fmt = format(req.format);
    await this.deps.files.resolve(file);

    let incoming: string;
    let missing: string[] = [];
    let collection: BibSettings["collection"];
    if (req.mode === "collection") {
      if (typeof req.path !== "string") throw new Error("请选择一个 Zotero 集合");
      incoming = await this.deps.zotero.exportCollection(req.libraryId, req.key, fmt);
      collection = { libraryId: req.libraryId, key: req.key, path: req.path.slice(0, 300) };
    } else if (req.mode === "used") {
      if (!Array.isArray(req.documents) || !req.documents.length || req.documents.length > MAX_DOCUMENTS) throw new Error(`请选择 1 到 ${MAX_DOCUMENTS} 个文稿`);
      const keys = new Set<string>();
      for (const doc of req.documents) for (const key of citedKeys(await this.deps.files.readText(doc), citeStyleFor(doc))) keys.add(key);
      if (!keys.size) throw new Error("这些文稿里还没有引用：先插入引用，再按用到的文献同步");
      if (keys.size > MAX_KEYS) throw new Error(`文稿里的引用超过 ${MAX_KEYS} 个，请改用按集合同步`);
      ({ bib: incoming, missing } = await this.deps.zotero.exportKnown([...keys], fmt));
    } else {
      throw new Error("同步方式不正确");
    }

    const local = (await this.deps.files.isFile(file)) ? await this.deps.files.readText(file, 20 * 1024 * 1024) : "";
    const merged = mergeBib(local, incoming);
    const result: BibSyncResult = { file, added: merged.added, updated: merged.updated, kept: merged.kept, unchanged: merged.unchanged, missing, total: merged.total };
    if (merged.added.length || merged.updated.length) {
      const summary = [
        `从 Zotero 新增 ${merged.added.length} 条、更新 ${merged.updated.length} 条`,
        merged.kept ? `文件里另外 ${merged.kept} 条 Zotero 没给的条目原样保留` : "",
        merged.updated.length ? `会被 Zotero 的版本替换的条目：${merged.updated.slice(0, 20).join("、")}${merged.updated.length > 20 ? " 等" : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!(await this.deps.approveWrite(file, summary))) throw new Error("你取消了同步，文件没有改动");
      await this.deps.files.writeText(file, merged.text);
    }
    await this.saveSettings({ file, format: fmt, ...(collection ? { collection } : (await this.settings()).collection ? { collection: (await this.settings()).collection } : {}) }).catch(() => {});
    return result;
  }
}
