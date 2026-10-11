// Reading and merging .bib files. Only the structure is read (where an entry starts and ends, and
// its key); what is inside an entry is never rewritten.

export interface BibEntry {
  key: string;
  /** Lower case: "article", "book", … */
  type: string;
  /** The entry exactly as it is in the file. */
  raw: string;
}

export interface BibFile {
  entries: BibEntry[];
  /** @string, @preamble and @comment blocks, and any text between entries, in order. */
  extras: string[];
}

/** Where the block opened at `open` ends (index after its closing brace), or -1 when it never closes. */
function blockEnd(text: string, open: number): number {
  const close = text[open] === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && depth > 0) depth--;
    else if (c === close && depth === 0) return i + 1;
  }
  return -1;
}

export function parseBib(text: string): BibFile {
  const out: BibFile = { entries: [], extras: [] };
  const extra = (s: string) => {
    if (s.trim()) out.extras.push(s.trim());
  };
  const start = /@([A-Za-z]+)\s*([{(])/g;
  let from = 0;
  for (;;) {
    start.lastIndex = from;
    const m = start.exec(text);
    if (!m) break;
    const end = blockEnd(text, m.index + m[0].length - 1);
    // Never closed: the rest is kept as it is rather than guessed at.
    if (end < 0) break;
    extra(text.slice(from, m.index));
    const raw = text.slice(m.index, end);
    const type = m[1].toLowerCase();
    const key = /^[^,]*/.exec(text.slice(m.index + m[0].length, end - 1))![0].trim();
    if (type === "comment" || type === "string" || type === "preamble" || !key || /[\s{}"=]/.test(key) || !raw.includes(",")) extra(raw);
    else out.entries.push({ key, type, raw });
    from = end;
  }
  extra(text.slice(from));
  return out;
}

export const bibKeys = (text: string): string[] => [...new Set(parseBib(text).entries.map((e) => e.key))];

/** The same entry apart from spacing. */
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export interface BibMerge {
  text: string;
  added: string[];
  updated: string[];
  /** Entries only the local file has. */
  kept: number;
  unchanged: number;
  total: number;
}

/**
 * The local file with what came from Zotero put in: an entry with the same key is replaced by
 * Zotero's, a new one is added at the end, and what only the local file has (entries added by
 * hand, @string definitions, comments) stays. A key that appears twice is kept once (the later one).
 */
export function mergeBib(local: string, incoming: string): BibMerge {
  const mine = parseBib(local);
  const theirs = parseBib(incoming);
  const entries = new Map<string, BibEntry>();
  for (const e of mine.entries) entries.set(e.key, e);
  const fresh = new Map<string, BibEntry>();
  for (const e of theirs.entries) fresh.set(e.key, e);

  const added: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;
  for (const e of fresh.values()) {
    const had = entries.get(e.key);
    if (!had) added.push(e.key);
    else if (same(had.raw, e.raw)) unchanged++;
    else updated.push(e.key);
    // Also when unchanged in substance: the local copy stays, so the file doesn't change for nothing.
    if (!had || !same(had.raw, e.raw)) entries.set(e.key, e);
  }
  // Definitions the incoming entries may lean on; its comments are not carried over.
  const extras = [...mine.extras];
  for (const x of theirs.extras) if (/^@(string|preamble)\b/i.test(x) && !extras.some((y) => same(x, y))) extras.push(x);

  const blocks = [...extras, ...[...entries.values()].map((e) => e.raw.trim())];
  return {
    text: blocks.length ? blocks.join("\n\n") + "\n" : "",
    added,
    updated,
    kept: [...entries.keys()].filter((k) => !fresh.has(k)).length,
    unchanged,
    total: entries.size,
  };
}
