// Split a source file into chunks of whole lines for retrieval. Chunks prefer to end where a
// top-level block ends (a blank line, or the next line starting at column 0), so a function or
// class tends to stay together.

export interface RawChunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
}

const TARGET = 50;
const MIN = 20;
const MAX = 90;
/** Lines that close a block rather than start one. */
const CLOSER = /^[\s]*[}\])]|^\s*(end|fi|done|esac)\b/;

export function chunkLines(text: string): RawChunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= MAX) return lines.length ? [{ start: 1, end: lines.length, text: lines.join("\n") }] : [];

  const out: RawChunk[] = [];
  let start = 0;
  const flush = (end: number) => {
    // Skip chunks that are only blank lines.
    const body = lines.slice(start, end);
    if (body.some((l) => l.trim())) out.push({ start: start + 1, end, text: body.join("\n") });
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const size = i - start;
    if (size < MIN) continue;
    const line = lines[i];
    const boundary = !line.trim() || (/^\S/.test(line) && !CLOSER.test(line));
    if ((boundary && size >= TARGET) || size >= MAX) flush(boundary && !line.trim() ? i + 1 : i);
  }
  if (start < lines.length) {
    // A short tail joins the previous chunk instead of standing alone.
    const last = out[out.length - 1];
    if (last && lines.length - start < MIN / 2) {
      last.end = lines.length;
      last.text = lines.slice(last.start - 1).join("\n");
    } else {
      flush(lines.length);
    }
  }
  return out;
}
