import type { RagService } from "../../rag/service";
import type { BuiltinHandler } from "../bus";

// Before each message: the few chunks of project code most related to it, if any are clearly
// related. Below the thresholds nothing is added, so small talk costs no tokens.

const SEARCH = 8;
const KEEP = 3;
const MAX_LINES = 60;
const BUDGET = 6000;
/** A chunk must explain at least this much of the message (see Scored.coverage)… */
const MIN_COVERAGE = 0.45;
/** …or score this high on its own (long messages where only part is about code). */
const STRONG_BM25 = 14;
/** Docs (README…) count for less than code: the agent can read them itself. */
const DOC_WEIGHT = 0.6;
const MIN_COSINE = 0.5;
/** Tiny projects are already fully visible in the project overview. */
const MIN_FILES = 4;

export function create(rag: RagService): BuiltinHandler {
  return async (_event, input, ctx) => {
    const prompt = input.prompt?.trim() ?? "";
    if (prompt.length < 4) return null;
    const index = rag.current();
    if (!index) return null;
    const hits = await index.search(prompt, SEARCH, { signal: ctx.signal });
    if (index.status().files < MIN_FILES) return null;
    const weight = (path: string) => (/\.(md|mdx|txt|rst)$/i.test(path) ? DOC_WEIGHT : 1);
    const good = hits
      .map((h) => ({ ...h, kw: (h.coverage ?? 0) * weight(h.chunk.path), raw: (h.bm25 ?? 0) * weight(h.chunk.path) }))
      .filter((h) => h.kw >= MIN_COVERAGE || h.raw >= STRONG_BM25 || (h.cosine ?? 0) >= MIN_COSINE)
      .sort((a, b) => Math.max(b.kw, b.cosine ?? 0) - Math.max(a.kw, a.cosine ?? 0))
      .slice(0, KEEP);
    if (!good.length) return null;
    const blocks: string[] = [];
    let used = 0;
    for (const h of good) {
      const lines = h.chunk.text.split("\n").slice(0, MAX_LINES);
      const end = h.chunk.start + lines.length - 1;
      const body = lines.join("\n");
      if (used + body.length > BUDGET && blocks.length) break;
      blocks.push(`## ${h.chunk.path}:${h.chunk.start}-${end}\n\`\`\`\n${body}\n\`\`\``);
      used += body.length;
    }
    const where = good.slice(0, blocks.length).map((h) => `${h.chunk.path}:${h.chunk.start}`).join("\n");
    return {
      context:
        "<retrieved_code>\n系统根据这条消息在项目里自动找到的代码片段，可能相关也可能不相关，而且可能不完整。" +
        `要修改哪个文件，先用 read_file 读完整的内容。\n${blocks.join("\n\n")}\n</retrieved_code>`,
      notice: { message: `自动找到 ${blocks.length} 段可能相关的代码`, detail: where },
    };
  };
}
