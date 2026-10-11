// Fuzzy matching for the command palette and quick open: the query's characters must appear in
// order (case-insensitive); matches at the start of a word, right after the previous match, or in the
// file name score higher. Returns the matched positions for highlighting.

export interface FuzzyMatch {
  score: number;
  /** Indices into the matched text. */
  indices: number[];
}

const SEP = new Set(["/", "\\", "_", "-", ".", " ", ":"]);

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (SEP.has(prev)) return true;
  // camelCase: a capital after a lowercase letter
  return prev >= "a" && prev <= "z" && text[i] >= "A" && text[i] <= "Z";
}

/**
 * Best in-order match of query in text, or null. Greedy from each possible start of the first
 * character, keeping the best-scoring run (texts here are short: paths and titles).
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  let best: FuzzyMatch | null = null;
  let start = t.indexOf(q[0]);
  while (start !== -1) {
    const indices = [start];
    let score = isBoundary(text, start) ? 8 : 1;
    let ti = start + 1;
    let ok = true;
    for (let qi = 1; qi < q.length; qi++) {
      // Prefer the next boundary match close by over the plain next occurrence.
      const next = t.indexOf(q[qi], ti);
      if (next === -1) {
        ok = false;
        break;
      }
      let pick = next;
      if (next !== ti) {
        for (let j = next; j !== -1 && j < next + 24; j = t.indexOf(q[qi], j + 1)) {
          if (isBoundary(text, j)) {
            pick = j;
            break;
          }
        }
      }
      if (pick === ti) score += 6; // consecutive
      else if (isBoundary(text, pick)) score += 5;
      else score += 1;
      score -= Math.min(3, (pick - ti) / 4); // gaps cost a little
      indices.push(pick);
      ti = pick + 1;
    }
    if (ok && (!best || score > best.score)) best = { score, indices };
    start = t.indexOf(q[0], start + 1);
  }
  if (best) best.score -= text.length / 100; // shorter wins ties
  return best;
}

/** A file path: the name counts more than the folders; a query with "/" matches the whole path. */
export function fuzzyPath(query: string, path: string): FuzzyMatch | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (!query.includes("/")) {
    const m = fuzzy(query, name);
    if (m) return { score: m.score * 2 + 20, indices: m.indices.map((i) => i + slash + 1) };
  }
  return fuzzy(query, path);
}
