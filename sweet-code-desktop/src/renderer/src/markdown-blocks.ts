// Where a streamed Markdown reply can be cut into blocks that render the same on their own
// (components/Markdown.tsx renders a growing reply block by block). No imports: tested under node.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Markdown cut at the blank lines between top-level blocks: never inside a fenced code block, and
 * never before an indented line (the next paragraph or nested list of a list item).
 */
export function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  /** The block being collected has more than blank lines in it. */
  let filled = false;
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!fence) fence = { char, len };
      // A closing fence is the same character, at least as long, and nothing after it.
      else if (char === fence.char && len >= fence.len && !lines[i].slice(m[0].length).trim()) fence = null;
      filled = true;
      continue;
    }
    if (fence) continue;
    if (lines[i].trim()) {
      filled = true;
      continue;
    }
    if (filled && i + 1 < lines.length && /^\S/.test(lines[i + 1])) {
      blocks.push(lines.slice(start, i).join("\n"));
      start = i + 1;
      filled = false;
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
