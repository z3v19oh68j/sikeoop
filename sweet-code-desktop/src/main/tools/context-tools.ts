import { z } from "zod";
import { allSummaries } from "../memory/session-summary";
import type { MemoryStore } from "../memory/store";
import { Bm25 } from "../search/text";
import type { RagService } from "../rag/service";
import { getRoot, hasRoot } from "../workspace";
import { defineTool, type ToolSpec } from "./registry";

// Tools for the agent's long-term memory and for searching the project's code index.

const MAX_RESULT_CHARS = 16_000;
const MAX_HIT_LINES = 80;
/** recall: memories (active and archived) and passages of past conversation summaries. */
const RECALL_MEMORIES = 8;
const RECALL_PASSAGES = 3;
const PASSAGE_CHARS = 800;

export function contextTools(memory: MemoryStore, rag: RagService): ToolSpec[] {
  const root = () => (hasRoot() ? getRoot() : null);

  const searchCode = defineTool({
    name: "search_code",
    description:
      "Search the project's code index for the chunks most related to a query, ranked by relevance (keywords, plus meaning " +
      "when semantic search is set up). Use it to find where something is implemented when you don't know the file: " +
      "describe it with likely identifiers and English words (e.g. 'login form submit handler'), not a full sentence. " +
      "Use the exact-text `search` tool instead when you know the exact string. Results show path:line ranges; read_file the file before editing.",
    schema: z.object({
      query: z.string().min(1),
      path: z.string().optional(),
      limit: z.number().int().min(1).max(12).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for: identifiers and keywords." },
        path: { type: "string", description: "Only files whose path contains this text, e.g. 'src/components'." },
        limit: { type: "integer", description: "How many chunks to return (default 6, max 12)." },
      },
      required: ["query"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `检索代码「${i.query.slice(0, 40)}」`,
    async run({ query, path, limit }, { signal }) {
      const index = rag.current();
      if (!index) return "No project folder is open.";
      const hits = await index.search(query, limit ?? 6, { pathFilter: path, signal });
      if (!hits.length) return `Nothing in the index matched "${query}". Try other words, or the exact-text search tool.`;
      const out: string[] = [];
      let used = 0;
      for (const h of hits) {
        const lines = h.chunk.text.split("\n");
        const shown = lines.slice(0, MAX_HIT_LINES);
        const end = h.chunk.start + shown.length - 1;
        const body = shown.map((l, i) => `${String(h.chunk.start + i).padStart(5)}  ${l}`).join("\n");
        const more = lines.length > shown.length ? `\n      …（这段还有 ${lines.length - shown.length} 行，用 read_file 看）` : "";
        const block = `## ${h.chunk.path}:${h.chunk.start}-${end}\n${body}${more}`;
        if (used + block.length > MAX_RESULT_CHARS && out.length) break;
        out.push(block);
        used += block.length;
      }
      const s = index.status();
      const note = index.isTruncated ? "\n（项目太大，只索引了前 5000 个文件。）" : "";
      return `${out.length} result(s) from ${s.files} indexed files${s.semantic.embedded ? " (keyword + semantic)" : " (keyword)"}:${note}\n\n${out.join("\n\n")}`;
    },
  });

  const remember = defineTool({
    name: "remember",
    description:
      "Save one short fact to long-term memory so future conversations know it: the user's preferences (language, style, " +
      "tools they like), project conventions, important decisions and why. One sentence, self-contained, in the user's language. " +
      "Use scope 'global' for facts about the user that hold in every project, 'project' for this project only. " +
      "Don't save secrets, temporary details or things already in the code. A very similar memory is replaced, not duplicated.",
    schema: z.object({
      text: z.string().min(1).max(500),
      scope: z.enum(["project", "global"]).optional(),
      kind: z.enum(["preference", "fact", "decision", "note"]).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, one sentence." },
        scope: { type: "string", enum: ["project", "global"], description: "Default: project." },
        kind: { type: "string", enum: ["preference", "fact", "decision", "note"] },
      },
      required: ["text"],
    },
    permission: "auto",
    parallelSafe: false,
    summarize: (i) => `记住「${i.text.slice(0, 30)}${i.text.length > 30 ? "…" : ""}」`,
    async run({ text, scope, kind }, ctx) {
      const { item, updated } = await memory.add(root(), { text, scope: scope ?? "project", kind });
      ctx.emit({ type: "memory_saved", id: item.id, text: item.text, scope: item.scope, updated });
      return `${updated ? "Updated a similar memory" : "Saved"} [${item.id}] (${item.scope}): ${item.text}`;
    },
  });

  const recall = defineTool({
    name: "recall",
    description:
      "Search long-term memory for anything about a topic: saved memories (the user's preferences, project facts and decisions, " +
      "including archived ones not shown at the start of the conversation) and summaries of earlier conversations in this project " +
      "(what was built, what was left unfinished). Use it when the user refers to something from before, or before redoing a decision.",
    schema: z.object({ query: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Topic or keywords." } },
      required: ["query"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `回忆「${i.query.slice(0, 30)}」`,
    async run({ query }) {
      const r = root();
      const hits = await memory.search(r, query, RECALL_MEMORIES, { archived: true });
      // Recalling an archived memory brings it back to the index (touch revives it).
      if (hits.length) await memory.touch(r, hits.map((m) => m.id));
      const out: string[] = [];
      if (hits.length) {
        out.push("Memories:", ...hits.map((m) => `[${m.id}] (${m.scope}, ${m.kind}${m.tier === "c4" ? ", was archived" : ""}) ${m.text}`));
      }
      // c4: earlier conversations, as passages of their summaries.
      const summaries = r ? await allSummaries(r) : [];
      if (summaries.length) {
        const index = new Bm25<(typeof summaries)[number]>();
        for (const s of summaries) index.set(s.id, s, `${s.title}\n${s.text}`);
        const found = index.search(query, RECALL_PASSAGES).map((x) => x.item);
        for (const s of found) {
          const day = new Date(s.updatedAt).toISOString().slice(0, 10);
          out.push(`\nEarlier conversation "${s.title}" (${day}):\n${passage(s.text, query)}`);
        }
      }
      return out.length ? out.join("\n") : "No memories or earlier conversations match.";
    },
  });

  const forget = defineTool({
    name: "forget",
    description: "Delete a memory by its id (the [id] shown with it), when it is wrong or outdated, or the user asks you to forget it.",
    schema: z.object({ id: z.string().min(1) }),
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    permission: "auto",
    parallelSafe: false,
    summarize: (i) => `忘掉记忆 ${i.id}`,
    async run({ id }) {
      const gone = await memory.remove(root(), id.replace(/^\[|\]$/g, ""));
      return gone ? `Forgot [${gone.id}]: ${gone.text}` : `No memory with id ${id}.`;
    },
  });

  return [searchCode, remember, recall, forget] as ToolSpec[];
}

/** The part of a summary around the first query word it contains, at most PASSAGE_CHARS. */
function passage(text: string, query: string): string {
  if (text.length <= PASSAGE_CHARS) return text;
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const lower = text.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - PASSAGE_CHARS / 4, text.length - PASSAGE_CHARS));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + PASSAGE_CHARS)}${start + PASSAGE_CHARS < text.length ? "…" : ""}`;
}
