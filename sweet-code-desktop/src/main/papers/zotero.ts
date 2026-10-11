import type { BibFormat, CitePick, CiteStyle, ZoteroCollection, ZoteroItem, ZoteroStatus } from "@shared/types";
import { parseCayw, validCitekey } from "./cite.ts";

// Zotero through Better BibTeX's local interface (https://retorque.re/zotero-better-bibtex/):
//   GET  /better-bibtex/cayw?probe=1            "ready" when Better BibTeX is there
//   GET  /better-bibtex/cayw?format=…           Zotero's own citation picker; answers with the citation
//   POST /better-bibtex/json-rpc                api.ready, item.search, item.attachments, item.export, user.groups
//   GET  /better-bibtex/collection?/<library>/<key>.<format>   a collection as a .bib ("pull export")
// Only ever 127.0.0.1:23119, the address Zotero itself listens on: nothing here reaches the network,
// and a redirect is refused rather than followed.

export const ZOTERO_ORIGIN = "http://127.0.0.1:23119";

/** An address on Zotero's local server. Anything that would lead elsewhere throws. */
export function zoteroUrl(pathAndQuery: string): string {
  if (!pathAndQuery.startsWith("/better-bibtex/") || /[\s\\]/.test(pathAndQuery)) throw new Error("Zotero 接口地址不正确");
  const url = new URL(ZOTERO_ORIGIN + pathAndQuery);
  if (url.origin !== ZOTERO_ORIGIN || !url.pathname.startsWith("/better-bibtex/")) throw new Error("Zotero 接口地址不正确");
  return url.href;
}

/** CAYW's query for a style: Zotero writes the citation in that syntax itself. */
export function caywQuery(style: CiteStyle): string {
  return style === "latex" ? "format=latex&command=cite" : "format=pandoc&brackets=1";
}

/** Pull export of one collection. `fallback`: the address newer Better BibTeX versions show in their menu. */
export function collectionExportPath(libraryId: number, key: string, format: BibFormat, fallback = false): string {
  if (!Number.isInteger(libraryId) || libraryId < 0 || !/^[A-Z0-9]{8}$/.test(key)) throw new Error("Zotero 集合编号不正确");
  return `/better-bibtex/${fallback ? "export/collection" : "collection"}?/${libraryId}/${key}.${format}`;
}

const INSTALL_ZOTERO = "到 zotero.org 下载并安装 Zotero（7 或更新的版本）";
const INSTALL_BBT = [
  "到 Better BibTeX 的发布页（github.com/retorquere/zotero-better-bibtex/releases）下载最新的 .xpi 文件",
  "在 Zotero 里打开「工具 → 插件」，把 .xpi 文件拖进去，或点右上角齿轮选「从文件安装插件」",
  "重启 Zotero，然后回到这里点「重新检测」",
];

const major = (v: string | undefined) => Number(/^\d+/.exec(v ?? "")?.[0] ?? NaN);

/**
 * What the two probes say, in plain words.
 * `probe`: the answer to cayw?probe (null when nothing answered on the port).
 * `versions`: api.ready's answer; "missing" when Better BibTeX doesn't know the method.
 */
export function zoteroStatusOf(probe: { status: number; body: string } | null, versions?: { zotero?: unknown; betterbibtex?: unknown } | "missing"): ZoteroStatus {
  if (!probe) {
    return { state: "not_running", message: "没有连上 Zotero：它没有打开，或者还没装。", steps: ["打开 Zotero，让它在后台开着（引用选择框和文献库都由它提供）", `还没装的话：${INSTALL_ZOTERO}`, "打开后点「重新检测」"] };
  }
  if (probe.status !== 200 || probe.body.trim() !== "ready") {
    return { state: "no_bbt", message: "Zotero 开着，但没有找到 Better BibTeX 插件。", steps: [...INSTALL_BBT, "如果刚打开 Zotero，等几秒让插件启动完再检测"] };
  }
  const zotero = versions && versions !== "missing" && typeof versions.zotero === "string" ? versions.zotero : undefined;
  const betterBibtex = versions && versions !== "missing" && typeof versions.betterbibtex === "string" ? versions.betterbibtex : undefined;
  if (versions === "missing" || !betterBibtex) {
    return { state: "outdated", zotero, message: "Better BibTeX 的版本太旧，缺少 sikeoop 要用的接口。", steps: ["在 Zotero 的「工具 → 插件」里更新 Better BibTeX，或按下面的步骤装最新版", ...INSTALL_BBT] };
  }
  if (major(zotero) < 7) {
    return { state: "outdated", zotero, betterBibtex, message: `Zotero ${zotero} 太旧了，需要 Zotero 7 或更新的版本。`, steps: [INSTALL_ZOTERO, "升级后 Better BibTeX 也要装对应的新版", "然后点「重新检测」"] };
  }
  return { state: "ready", zotero, betterBibtex, message: "", steps: [] };
}

const text = (v: unknown, max = 500) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** item.search's answer (CSL-JSON items with a citation key) as the list the search shows. */
export function parseZoteroItems(result: unknown): ZoteroItem[] {
  if (!Array.isArray(result)) throw new Error("Zotero 返回的不是文献列表");
  const out: ZoteroItem[] = [];
  for (const raw of result) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const citekey = [r.citekey, r.citationKey, r["citation-key"]].find(validCitekey);
    const title = text(r.title);
    if (!citekey || !title) continue;
    const people = Array.isArray(r.author) && r.author.length ? r.author : Array.isArray(r.creators) ? r.creators : Array.isArray(r.editor) ? r.editor : [];
    const authors = people
      .map((p: unknown) => {
        const a = (p ?? {}) as Record<string, unknown>;
        return text(a.literal ?? a.name, 120) || [text(a.given ?? a.firstName, 80), text(a.family ?? a.lastName, 80)].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .slice(0, 20);
    const issued = r.issued as { "date-parts"?: unknown; raw?: unknown } | undefined;
    const fromParts = Array.isArray(issued?.["date-parts"]) && Array.isArray(issued["date-parts"][0]) ? Number(issued["date-parts"][0][0]) : NaN;
    const fromText = Number(/\b(1[5-9]\d\d|20\d\d)\b/.exec(text(issued?.raw) || text(r.date) || text(r.year))?.[1] ?? NaN);
    const year = Number.isInteger(fromParts) && fromParts > 0 ? fromParts : Number.isInteger(fromText) ? fromText : null;
    const venue = text(r["container-title"] ?? r.publicationTitle ?? r.publisher, 200);
    out.push({ citekey, title, authors, year, type: text(r.type ?? r.itemType, 40) || "document", ...(venue ? { venue } : {}) });
    if (out.length >= 50) break;
  }
  return out;
}

/** item.attachments' answer: the PDF files Zotero has for an item. */
export function parseAttachments(result: unknown): string[] {
  if (!Array.isArray(result)) return [];
  return result.map((a) => (a && typeof a === "object" ? (a as { path?: unknown }).path : undefined)).filter((p): p is string => typeof p === "string" && /\.pdf$/i.test(p));
}

/** user.groups(true)'s answer as a flat list of collections, each with its path of parents. */
export function parseCollections(result: unknown): ZoteroCollection[] {
  if (!Array.isArray(result)) throw new Error("Zotero 返回的不是文献库列表");
  const out: ZoteroCollection[] = [];
  for (const raw of result) {
    const lib = (raw ?? {}) as Record<string, unknown>;
    const libraryId = Number(lib.id);
    if (!Number.isInteger(libraryId) || libraryId < 0) continue;
    const library = text(lib.name, 120) || "我的文库";
    // Collections arrive flat (each naming its parent) or nested (each holding its children); both are read.
    const flat = new Map<string, { name: string; parent?: string }>();
    const walk = (list: unknown, parent?: string) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const c = (item ?? {}) as Record<string, unknown>;
        const data = (c.data && typeof c.data === "object" ? c.data : c) as Record<string, unknown>;
        const key = text(c.key ?? data.key, 16);
        const name = text(data.name, 120);
        if (!/^[A-Z0-9]{8}$/.test(key) || !name) continue;
        const up = text(data.parentCollection ?? data.parent, 16);
        flat.set(key, { name, parent: parent ?? (/^[A-Z0-9]{8}$/.test(up) ? up : undefined) });
        walk(c.collections ?? c.children, key);
      }
    };
    walk(lib.collections);
    for (const [key, c] of flat) {
      const names = [c.name];
      const seen = new Set([key]);
      for (let up = c.parent; up && flat.has(up) && !seen.has(up); up = flat.get(up)!.parent) {
        seen.add(up);
        names.unshift(flat.get(up)!.name);
      }
      out.push({ libraryId, library, key, name: c.name, path: names.join(" / ") });
    }
  }
  return out.sort((a, b) => a.library.localeCompare(b.library, "zh") || a.path.localeCompare(b.path, "zh"));
}

/** item.export's answer: the .bib text (older versions wrapped it in a list). */
export function parseExport(result: unknown): string {
  const body = typeof result === "string" ? result : Array.isArray(result) ? result.filter((x) => typeof x === "string").at(-1) : undefined;
  if (typeof body !== "string") throw new Error("Zotero 没有返回参考文献");
  return body;
}

/** Zotero (or the port) did not answer at all. */
export class ZoteroUnreachable extends Error {
  constructor() {
    super("没有连上 Zotero，请确认它开着");
  }
}

interface RpcError extends Error {
  code?: number;
}

export class ZoteroClient {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch) {
    this.fetcher = fetcher;
  }

  private async request(pathAndQuery: string, init: { body?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; body: string }> {
    const timeout = init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined;
    const signal = init.signal && timeout ? AbortSignal.any([init.signal, timeout]) : (init.signal ?? timeout);
    let res: Response;
    try {
      res = await this.fetcher(zoteroUrl(pathAndQuery), {
        method: init.body === undefined ? "GET" : "POST",
        // Zotero turns away requests that look like a web page's unless they say they are meant.
        headers: { Accept: "application/json, text/plain", "Zotero-Allowed-Request": "1", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: init.body,
        redirect: "error",
        signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw new Error("已取消");
      if (timeout?.aborted) throw new Error("Zotero 太久没有回应，请确认它没有卡在别的窗口上");
      throw err instanceof Error && /^Zotero 接口地址/.test(err.message) ? err : new ZoteroUnreachable();
    }
    return { status: res.status, body: await res.text() };
  }

  private async rpc(method: string, params: unknown[], timeoutMs = 15_000): Promise<unknown> {
    const res = await this.request("/better-bibtex/json-rpc", { body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }), timeoutMs });
    let reply: { result?: unknown; error?: { code?: number; message?: string } } | undefined;
    try {
      reply = JSON.parse(res.body);
    } catch {
      reply = undefined;
    }
    if (!reply || typeof reply !== "object") throw new Error(res.status === 404 ? "没有找到 Better BibTeX 的接口，请确认插件装好了" : `Zotero 返回了看不懂的内容（${res.status}）`);
    if (reply.error) {
      const err: RpcError = new Error(`Zotero 报错：${text(reply.error.message, 300) || "没有说明原因"}`);
      err.code = reply.error.code;
      throw err;
    }
    return reply.result;
  }

  async status(): Promise<ZoteroStatus> {
    let probe: { status: number; body: string };
    try {
      probe = await this.request("/better-bibtex/cayw?probe=1", { timeoutMs: 2500 });
    } catch {
      return zoteroStatusOf(null);
    }
    if (probe.status !== 200 || probe.body.trim() !== "ready") return zoteroStatusOf(probe);
    try {
      return zoteroStatusOf(probe, (await this.rpc("api.ready", [], 4000)) as { zotero?: unknown; betterbibtex?: unknown });
    } catch {
      return zoteroStatusOf(probe, "missing");
    }
  }

  /** Opens Zotero's picker and waits for as long as the user takes. Null: closed without a choice. */
  async pick(style: CiteStyle, signal: AbortSignal): Promise<CitePick | null> {
    const res = await this.request(`/better-bibtex/cayw?${caywQuery(style)}`, { signal });
    if (res.status !== 200) throw new Error(res.status === 404 ? "没有找到 Better BibTeX 的引用选择框，请确认插件装好了" : `Zotero 没能打开引用选择框（${res.status}）`);
    return parseCayw(res.body, style);
  }

  async search(terms: string): Promise<ZoteroItem[]> {
    return parseZoteroItems(await this.rpc("item.search", [terms]));
  }

  /** The PDF files of an item, as paths on this computer. */
  async pdfs(citekey: string): Promise<string[]> {
    return parseAttachments(await this.rpc("item.attachments", [citekey]));
  }

  /**
   * The entries for the keys Zotero has, and the keys it doesn't. Better BibTeX refuses a whole
   * export when one key is unknown, so after a refusal the keys are asked for one at a time.
   */
  async exportKnown(keys: string[], format: BibFormat): Promise<{ bib: string; missing: string[] }> {
    if (!keys.length) return { bib: "", missing: [] };
    try {
      return { bib: await this.exportKeys(keys, format), missing: [] };
    } catch (err) {
      if (err instanceof ZoteroUnreachable || (err as RpcError).code === undefined) throw err;
    }
    const parts: string[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      try {
        parts.push(await this.exportKeys([key], format));
      } catch (err) {
        if (err instanceof ZoteroUnreachable || (err as RpcError).code === undefined) throw err;
        missing.push(key);
      }
    }
    return { bib: parts.join("\n\n"), missing };
  }

  /** The entries for these keys. A key Zotero doesn't have makes the whole export fail (see `exportKnown`). */
  async exportKeys(keys: string[], format: BibFormat): Promise<string> {
    try {
      return parseExport(await this.rpc("item.export", [keys, format], 60_000));
    } catch (err) {
      // An older Better BibTeX knows the translator only by its full name.
      if (!/translator/i.test((err as Error).message)) throw err;
      return parseExport(await this.rpc("item.export", [keys, format === "bibtex" ? "Better BibTeX" : "Better BibLaTeX"], 60_000));
    }
  }

  async collections(): Promise<ZoteroCollection[]> {
    return parseCollections(await this.rpc("user.groups", [true]));
  }

  async exportCollection(libraryId: number, key: string, format: BibFormat): Promise<string> {
    let res = await this.request(collectionExportPath(libraryId, key, format), { timeoutMs: 120_000 });
    if (res.status === 404) res = await this.request(collectionExportPath(libraryId, key, format, true), { timeoutMs: 120_000 });
    if (res.status !== 200) throw new Error(`Zotero 没能导出这个集合（${res.status}）：${text(res.body, 200) || "没有说明原因"}`);
    return res.body;
  }
}
