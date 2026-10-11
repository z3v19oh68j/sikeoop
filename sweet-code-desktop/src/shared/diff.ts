import type { DiffFold, DiffHunk, DiffLine } from "./types";

const CONTEXT = 3;
const MAX_SHOWN_LINES = 400;
/** Above this many cells the LCS table gets too slow; show a full replace instead. */
const MAX_CELLS = 4_000_000;
/** Folded runs up to this long keep their lines, so the card can expand them in place. */
const MAX_EXPANDABLE = 100;
/** Unchanged runs this short are shown rather than folded: a fold row would save nothing. */
const MIN_FOLD = 4;
/** Word diff only for lines up to this many tokens; longer ones get line-level colors. */
const MAX_TOKENS = 400;
/** If more than this share of a line changed, it was rewritten: no word marks. */
const MAX_CHANGED_SHARE = 0.7;
/** A removed and an added line are paired (as one modified line) above this similarity. */
const MIN_PAIR_SIMILARITY = 0.35;

/**
 * Line diff between two texts, grouped into hunks with a little context.
 * Common leading and trailing lines are trimmed first, so typical edits
 * (a few lines in a big file) only run the LCS on the small changed middle.
 * Modified lines get word-level marks; unchanged runs between hunks are folded.
 */
export function diffLines(before: string, after: string) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });
  middle(a.slice(start, endA), b.slice(start, endB), start, lines);
  for (let i = endA, j = endB; i < a.length; i++, j++) lines.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
  markWords(lines);

  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const { hunks, truncated, after: tail } = toHunks(lines);
  return { hunks, added, removed, truncated, ...(tail ? { after: tail } : {}) };
}

function middle(a: string[], b: string[], offset: number, out: DiffLine[]) {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    a.forEach((t, i) => out.push({ kind: "del", text: t, oldNo: offset + i + 1 }));
    b.forEach((t, j) => out.push({ kind: "add", text: t, newNo: offset + j + 1 }));
    return;
  }
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i], oldNo: offset + i + 1, newNo: offset + j + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removed lines come before added ones, as in a normal unified diff.
      out.push({ kind: "del", text: a[i], oldNo: offset + i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], newNo: offset + j + 1 });
      j++;
    }
  }
}

// ---- word-level marks ---------------------------------------------------------

/** Words, runs of spaces, single CJK characters and single symbols. */
const TOKEN = /[A-Za-z0-9_$]+|\s+|[㐀-鿿豈-﫿]|[\s\S]/gu;

/**
 * For each block of removed lines followed by added lines, pair lines that are edits of each
 * other (in order, by similarity) and mark the characters that changed on both sides.
 */
function markWords(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    let from = 0;
    for (const d of dels) {
      for (let k = from; k < adds.length; k++) {
        const pair = compare(d.text, adds[k].text);
        if (!pair) continue;
        from = k + 1;
        if (pair.ws) {
          d.ws = adds[k].ws = true;
        } else {
          if (pair.del.length) d.marks = pair.del;
          if (pair.add.length) adds[k].marks = pair.add;
        }
        break;
      }
    }
  }
}

/** Changed ranges on each side, or null when the lines are too different to be one edit. */
function compare(a: string, b: string): { del: [number, number][]; add: [number, number][]; ws: boolean } | null {
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "") && a.trim()) return { del: [], add: [], ws: true };
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  if (!ta.length || !tb.length || ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;
  const n = ta.length;
  const m = tb.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = ta[i] === tb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const keepA = new Uint8Array(n);
  const keepB = new Uint8Array(m);
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      keepA[i++] = keepB[j++] = 1;
      common++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  // Similarity by characters kept (spaces count less, so "a = b" vs "c = d" isn't a pair).
  const weight = (t: string) => (/^\s+$/.test(t) ? 0.2 : t.length);
  const kept = ta.reduce((s, t, k) => s + (keepA[k] ? weight(t) : 0), 0) + tb.reduce((s, t, k) => s + (keepB[k] ? weight(t) : 0), 0);
  const total = ta.reduce((s, t) => s + weight(t), 0) + tb.reduce((s, t) => s + weight(t), 0);
  if (!common || kept / total < MIN_PAIR_SIMILARITY) return null;
  const del = ranges(ta, keepA);
  const add = ranges(tb, keepB);
  // Mostly rewritten: the line-level color says it better than a sea of marks.
  const share = (r: [number, number][], text: string) => r.reduce((s, [x, y]) => s + y - x, 0) / Math.max(1, text.trim().length);
  if (share(del, a) > MAX_CHANGED_SHARE || share(add, b) > MAX_CHANGED_SHARE) return { del: [], add: [], ws: false };
  return { del, add, ws: false };
}

/** Character ranges of the tokens not kept, merging neighbours (and the spaces between them). */
function ranges(tokens: string[], keep: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  tokens.forEach((t, k) => {
    const end = pos + t.length;
    if (!keep[k]) {
      const last = out[out.length - 1];
      if (last && last[1] === pos) last[1] = end;
      else out.push([pos, end]);
    }
    pos = end;
  });
  // Bridge a lone kept space between two marks: "foo bar" → one mark, not two.
  for (let k = out.length - 1; k > 0; k--) {
    const gap = tokens.join("").slice(out[k - 1][1], out[k][0]);
    if (/^\s{1,2}$/.test(gap)) {
      out[k - 1][1] = out[k][1];
      out.splice(k, 1);
    }
  }
  // Never mark leading/trailing whitespace alone.
  return out.filter(([x, y]) => tokens.join("").slice(x, y).trim());
}

// ---- hunks and folds ------------------------------------------------------------

function fold(run: DiffLine[]): DiffFold {
  return run.length <= MAX_EXPANDABLE ? { count: run.length, lines: run } : { count: run.length };
}

function toHunks(lines: DiffLine[]): { hunks: DiffHunk[]; truncated: boolean; after?: DiffFold } {
  // Keep every changed line plus CONTEXT lines around it.
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = 1;
  });
  // Fill in short gaps (between hunks and at either end) instead of folding a line or two.
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    if (j - i < MIN_FOLD && (i > 0 || j < lines.length)) keep.fill(1, i, j);
    i = j;
  }
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  let skipped: DiffLine[] = [];
  let shown = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      current = null;
      skipped.push(lines[i]);
      continue;
    }
    if (shown >= MAX_SHOWN_LINES) return { hunks, truncated: true };
    if (!current) {
      hunks.push({ lines: (current = []), ...(skipped.length ? { before: fold(skipped) } : {}) });
      skipped = [];
    }
    current.push(lines[i]);
    shown++;
  }
  return { hunks, truncated: false, ...(skipped.length && hunks.length ? { after: fold(skipped) } : {}) };
}
