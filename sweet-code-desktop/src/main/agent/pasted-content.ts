import { randomUUID } from "node:crypto";

/** UTF-16 offsets and exact text recorded by a clipboard paste event, not inferred from prose. */
export interface PastedContentRange {
  source: "clipboard";
  start: number;
  end: number;
  text: string;
}

/**
 * Wrap only ranges with explicit paste provenance. Reject the whole annotation set when
 * edits have made a range stale or ambiguous; ordinary text and code fences stay untouched.
 * Keep the returned message in history, rather than generating new ids on each model call.
 */
export function wrapPastedContent(text: string, pasted?: readonly PastedContentRange[]): string {
  if (!Array.isArray(pasted) || !pasted.length) return text;
  for (const range of pasted) {
    if (
      !range || typeof range !== "object" || range.source !== "clipboard" ||
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 0 || range.end <= range.start || range.end > text.length ||
      typeof range.text !== "string" || text.slice(range.start, range.end) !== range.text ||
      splitsSurrogate(text, range.start) || splitsSurrogate(text, range.end)
    ) return text;
  }
  const ranges = [...pasted].sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1].end)) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(text.slice(cursor, range.start));
    const content = range.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    parts.push(`<pasted_content id="${randomUUID()}">\n${content}\n</pasted_content>`);
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
