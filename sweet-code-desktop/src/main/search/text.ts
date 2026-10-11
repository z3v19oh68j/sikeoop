// Keyword search shared by memories and the code index: a tokenizer that understands code
// identifiers (camelCase, snake_case) and Chinese, and a small BM25 ranker.

/** Words that appear everywhere in code or prose and carry no meaning for a search. */
const STOP = new Set(
  (
    "the a an and or of to in on for is are was be it this that with as at by from not no yes if else then " +
    "const let var function return import export default new class extends public private protected static " +
    "void null undefined true false def self this int string bool any type interface async await"
  ).split(" "),
);

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[㐀-䶿一-鿿]+/g;
const CJK = /^[㐀-䶿一-鿿]/;

/** Lowercased search terms. Identifiers also yield their parts; Chinese yields overlapping pairs. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (CJK.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
      continue;
    }
    if (w.length > 64) continue;
    const lower = w.toLowerCase();
    if (lower.length >= 2 && !STOP.has(lower)) out.push(lower);
    const parts = w.split(/_+|\$+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter((p) => p.length >= 2);
    if (parts.length > 1) for (const p of parts) if (!STOP.has(p.toLowerCase())) out.push(p.toLowerCase());
  }
  return out;
}

export interface Scored<T> {
  item: T;
  score: number;
  /**
   * How much of the query this document explains (0–1): its score against what a document
   * containing every query term once would score. Unlike the raw score it doesn't depend on the
   * size of the collection, so one threshold works for small and large projects.
   */
  coverage: number;
}

/**
 * BM25 over a set of documents that changes over time: documents are added and removed by key,
 * and the statistics are kept up to date incrementally.
 */
export class Bm25<T> {
  private docs = new Map<string, { item: T; len: number; tf: Map<string, number> }>();
  private df = new Map<string, number>();
  private totalLen = 0;

  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  get size(): number {
    return this.docs.size;
  }

  set(key: string, item: T, text: string): void {
    this.delete(key);
    const tf = new Map<string, number>();
    const terms = tokenize(text);
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(key, { item, len: terms.length, tf });
    this.totalLen += terms.length;
  }

  delete(key: string): void {
    const d = this.docs.get(key);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLen -= d.len;
    this.docs.delete(key);
  }

  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.totalLen = 0;
  }

  keys(): IterableIterator<string> {
    return this.docs.keys();
  }

  search(query: string, k: number, filter?: (item: T) => boolean): Scored<T>[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.docs.size) return [];
    const n = this.docs.size;
    const avg = this.totalLen / n || 1;
    const idf = new Map(terms.map((t) => [t, Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))]));
    const ideal = [...idf.values()].reduce((a, b) => a + b, 0) || 1;
    const out: Scored<T>[] = [];
    for (const d of this.docs.values()) {
      if (filter && !filter(d.item)) continue;
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        score += idf.get(t)! * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg)));
      }
      if (score > 0) out.push({ item: d.item, score, coverage: Math.min(1, score / ideal) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/** Share of distinct terms two texts have in common (0–1), to spot near-duplicate memories. */
export function similarity(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (!x.size || !y.size) return a.trim() === b.trim() ? 1 : 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}
