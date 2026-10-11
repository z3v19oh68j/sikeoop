import type { HistoryEntry } from "../providers/types";

// Handing a conversation to another model (a manual switch, a failover, a route to a stronger or
// cheaper model). Each provider keeps history in its own format, so the new model gets the work so
// far as one readable record. Unlike compaction, tool results (the file contents it read) are
// passed on whole, so it doesn't spend turns reading the same files again; only when the record
// would not fit are the oldest file contents left out, and those files have to be read again.

/** Tools whose result is a file's content, by the input field that names the file. */
const READ_TOOLS: Record<string, string> = { read_file: "path" };
const OMITTED = "（为了放进新模型的上下文，这段内容被省略了；要用到时重新读取）";
/** Below this a result isn't worth omitting: the saving is smaller than the reread. */
const SMALL = 400;

export interface HandoffRecord {
  /** The record, ready to go in front of the next message. */
  text: string;
  /** Files whose read_file content was left out: their read marks must be dropped. */
  dropped: Set<string>;
  /** Tool results passed on whole / left out. */
  kept: number;
  omitted: number;
}

interface Line {
  text: string;
  /** A read_file result: the file it holds. */
  readOf?: string;
  omittable: boolean;
  omitted?: boolean;
}

/**
 * The history as a record of at most `maxChars`. Tool results are omitted oldest first; if that is
 * not enough, the middle of the conversation goes, keeping the first request and the newest work.
 */
export function handoffRecord(entries: HistoryEntry[], maxChars: number): HandoffRecord {
  const lines: Line[] = [];
  // Tool results follow the assistant turn that asked for them, in the order of its calls.
  let pending: { name: string; input: unknown }[] = [];
  for (const e of entries) {
    if (e.role === "user") lines.push({ text: `[用户]\n${e.text}`, omittable: false });
    else if (e.role === "assistant") {
      pending = [...(e.calls ?? [])];
      const calls = (e.calls ?? []).map((c) => `→ 调用 ${c.name}(${JSON.stringify(c.input) ?? ""})`);
      lines.push({ text: `[助手]\n${[e.text, ...calls].filter(Boolean).join("\n")}`, omittable: false });
    } else {
      const call = pending.shift();
      const name = e.tool ?? call?.name ?? "";
      const field = READ_TOOLS[name];
      const file = field && call && typeof call.input === "object" && call.input ? (call.input as Record<string, unknown>)[field] : undefined;
      lines.push({
        text: `[工具结果${name ? ` ${name}` : ""}]\n${e.text}`,
        readOf: typeof file === "string" ? file : undefined,
        omittable: e.text.length > SMALL,
      });
    }
  }

  let total = lines.reduce((n, l) => n + l.text.length + 2, 0);
  let omitted = 0;
  for (const l of lines) {
    if (total <= maxChars) break;
    if (!l.omittable) continue;
    const head = l.text.slice(0, l.text.indexOf("\n") + 1);
    total -= l.text.length - head.length - OMITTED.length;
    l.text = head + OMITTED;
    l.omitted = true;
    omitted++;
  }
  const kept = lines.filter((l) => l.omittable && !l.omitted).length;
  // A file counts as read only if its latest read was passed on.
  const latest = new Map<string, Line>();
  for (const l of lines) if (l.readOf) latest.set(l.readOf, l);
  const dropped = new Set([...latest].filter(([, l]) => l.omitted).map(([f]) => f));

  let out = lines.map((l) => l.text);
  if (total > maxChars) {
    // Still too long: the first request and as much of the newest work as fits.
    const head = out.slice(0, 1);
    const tail: string[] = [];
    let n = head[0]?.length ?? 0;
    for (let i = out.length - 1; i >= 1; i--) {
      if (n + out[i].length + 2 > maxChars) break;
      tail.unshift(out[i]);
      n += out[i].length + 2;
    }
    out = [...head, `…（中间省略了 ${out.length - 1 - tail.length} 条较早的记录）…`, ...tail];
    // Reads that were in the dropped middle are gone too; to be safe, every file read counts as dropped.
    for (const e of entries) for (const c of e.calls ?? []) {
      const field = READ_TOOLS[c.name];
      const file = field && typeof c.input === "object" && c.input ? (c.input as Record<string, unknown>)[field] : undefined;
      if (typeof file === "string") dropped.add(file);
    }
  }
  return { text: out.join("\n\n"), dropped, kept, omitted };
}
