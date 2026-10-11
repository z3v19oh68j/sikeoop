import type { NoveltyWork } from "@shared/types";

// Looking up works close to an idea. OpenAlex needs no key; an e-mail in `mailto` is optional (it
// puts the requests in their "polite pool"). Semantic Scholar is searched too when the user has a
// key for it. Parsing is pure and tested with made-up responses.

const ABSTRACT = 600;
const http = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined);
const text = (v: unknown, max = 400): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const year = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 1000 && v < 3000 ? v : null);

/** OpenAlex stores an abstract as word → positions; this puts the words back in order. */
export function abstractFromIndex(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 5000) words[p as number] = word;
  }
  return words.filter((w) => w !== undefined).join(" ").slice(0, ABSTRACT);
}

/** The works in an OpenAlex /works response. Entries without a title or a usable link are left out. */
export function parseOpenAlex(body: unknown): NoveltyWork[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error("OpenAlex 返回的数据不是论文列表");
  const out: NoveltyWork[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    const title = text(w.display_name ?? w.title);
    const location = (w.primary_location ?? {}) as { landing_page_url?: unknown; source?: { display_name?: unknown } | null };
    const url = http(w.doi) ?? http(location.landing_page_url) ?? http(w.id);
    if (!title || !url) continue;
    const authors = Array.isArray(w.authorships)
      ? w.authorships.map((a) => text((a as { author?: { display_name?: unknown } })?.author?.display_name, 80)).filter(Boolean).slice(0, 8)
      : [];
    const abstract = abstractFromIndex(w.abstract_inverted_index);
    const venue = text(location.source?.display_name, 120);
    out.push({
      title,
      year: year(w.publication_year),
      url,
      authors,
      ...(venue ? { venue } : {}),
      ...(typeof w.cited_by_count === "number" && w.cited_by_count >= 0 ? { citedBy: w.cited_by_count } : {}),
      ...(abstract ? { abstract } : {}),
      source: "openalex",
    });
  }
  return out;
}

/** The papers in a Semantic Scholar /graph/v1/paper/search response. */
export function parseSemanticScholar(body: unknown): NoveltyWork[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Semantic Scholar 返回的数据不是论文列表");
  const out: NoveltyWork[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const title = text(p.title);
    const url = http(p.url);
    if (!title || !url) continue;
    const abstract = text(p.abstract, ABSTRACT);
    const venue = text(p.venue, 120);
    out.push({
      title,
      year: year(p.year),
      url,
      authors: Array.isArray(p.authors) ? p.authors.map((a) => text((a as { name?: unknown })?.name, 80)).filter(Boolean).slice(0, 8) : [],
      ...(venue ? { venue } : {}),
      ...(typeof p.citationCount === "number" && p.citationCount >= 0 ? { citedBy: p.citationCount } : {}),
      ...(abstract ? { abstract } : {}),
      source: "semantic_scholar",
    });
  }
  return out;
}

export function openAlexUrl(query: string, mailto: string, perPage = 5): string {
  const params = new URLSearchParams({
    search: query,
    "per-page": String(perPage),
    select: "id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index",
  });
  // Only a plausible address is sent; anything else is left out rather than passed on.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailto)) params.set("mailto", mailto);
  return `https://api.openalex.org/works?${params}`;
}

export function semanticScholarUrl(query: string, limit = 5): string {
  return `https://api.semanticscholar.org/graph/v1/paper/search?${new URLSearchParams({ query, limit: String(limit), fields: "title,year,url,authors,venue,citationCount,abstract" })}`;
}

const key = (w: NoveltyWork) => w.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Several result lists as one: the same title once (the first one found is kept), at most `max`. */
export function mergeWorks(lists: NoveltyWork[][], max = 5): NoveltyWork[] {
  const seen = new Set<string>();
  const out: NoveltyWork[] = [];
  // Round-robin, so the best hits of every query come before anyone's fifth.
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const w = list[i];
      if (!w || seen.has(key(w))) continue;
      seen.add(key(w));
      out.push(w);
      if (out.length >= max) break;
    }
  }
  return out;
}

export interface ScholarDeps {
  fetch: typeof fetch;
  /** The user has read what the search sends and where, and agreed. */
  consent(): Promise<boolean>;
  mailto(): Promise<string>;
  /** A Semantic Scholar API key, when the user has one. */
  semanticScholarKey(): string | undefined;
  /** Waits between requests (replaced in tests). */
  sleep?(ms: number): Promise<void>;
}

/** OpenAlex asks for no more than ten requests a second; one a second is well inside that. */
const GAP_MS = 1100;

export class ScholarSearch {
  private readonly deps: ScholarDeps;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(deps: ScholarDeps) {
    this.deps = deps;
  }

  /** One request at a time, spaced out. */
  private request(url: string, headers?: Record<string, string>): Promise<unknown> {
    const run = this.queue.then(async () => {
      if (!(await this.deps.consent())) throw new Error("请先阅读并同意联网检索的说明");
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(Math.max(0, this.last + GAP_MS - Date.now()));
      this.last = Date.now();
      const res = await this.deps.fetch(url, { signal: AbortSignal.timeout(30_000), headers });
      if (!res.ok) throw new Error(`${new URL(url).hostname} 暂时无法访问（${res.status}），请稍后再试`);
      return res.json();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** The works closest to these search phrases: OpenAlex for each, plus Semantic Scholar when there is a key. */
  async search(queries: string[]): Promise<NoveltyWork[]> {
    const mailto = await this.deps.mailto();
    const s2 = this.deps.semanticScholarKey();
    const lists: NoveltyWork[][] = [];
    for (const q of queries.slice(0, 3)) {
      lists.push(parseOpenAlex(await this.request(openAlexUrl(q, mailto))));
      // Its results are a bonus: a failure there doesn't fail the check.
      if (s2) lists.push(await this.request(semanticScholarUrl(q), { "x-api-key": s2 }).then(parseSemanticScholar, () => []));
    }
    return mergeWorks(lists);
  }
}
