import type { RegressCandidate, RegressItem, RegressOwner, RegressVerdict } from "@shared/types";

// The regression panel's prompts and what is read back from a session's reply (.claude/regress-plan.md,
// "提示模板与解析"). Pure functions: tested on their own.

export const LIMITS = { title: 60, detail: 500, criteria: 300, reason: 500, name: 80, focus: 200 };
/** How much of a reply's end is looked at, and kept as the excerpt. */
const GENERATE_TAIL = 128 * 1024;
export const EXCERPT_TAIL = 2 * 1024;
const OWNERS: RegressOwner[] = ["frontend", "backend", "both"];

/** Colours and cursor moves a terminal reply may carry. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

export const excerptOf = (reply: string): string => reply.slice(-EXCERPT_TAIL);

export function generatePrompt(focus: string | undefined, maxCandidates: number): string {
  return `请阅读本项目代码（重点：${focus?.trim() || "全项目"}），列出值得做回归验证的功能点，最多 ${maxCandidates} 条。
不要修改任何文件，不要运行会改动环境的命令。
在回复最后按下面格式输出，块外不要放条目：
<<<REGRESS_ITEMS
[{"title":"≤60字","detail":"≤500字，怎么验证","owner":"frontend|backend|both","criteria":"≤300字，可判定的通过标准"}]
REGRESS_ITEMS>>>`;
}

export function runPrompt(item: Pick<RegressItem, "title" | "detail" | "criteria">): string {
  return `请验证下面这一条，只读代码/运行只读命令，不要修改文件：
标题：${item.title}
说明：${item.detail}
通过标准：${item.criteria}
最后一行必须是且只能是以下之一：
RESULT: PASS — 一句理由
RESULT: FAIL — 一句理由`;
}

/**
 * A candidate as it may be stored: every field a string, cut to its limit; an unknown owner
 * counts as "both". Null when it isn't an object, a field isn't a string, or the title is empty.
 */
export function cleanCandidate(raw: unknown): RegressCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  for (const k of ["title", "detail", "criteria"]) if (typeof r[k] !== "string") return null;
  if (r.owner !== undefined && typeof r.owner !== "string") return null;
  const title = (r.title as string).trim().slice(0, LIMITS.title);
  if (!title) return null;
  return {
    title,
    detail: (r.detail as string).trim().slice(0, LIMITS.detail),
    owner: OWNERS.includes(r.owner as RegressOwner) ? (r.owner as RegressOwner) : "both",
    criteria: (r.criteria as string).trim().slice(0, LIMITS.criteria),
  };
}

/** The candidates in the last <<<REGRESS_ITEMS … REGRESS_ITEMS>>> block of a reply. */
export function parseCandidates(
  reply: string,
  existingTitles: string[],
  maxCandidates: number,
): { candidates: RegressCandidate[]; rawExcerpt: string } | { error: string; rawExcerpt: string } {
  const text = stripAnsi(reply.slice(-GENERATE_TAIL));
  const rawExcerpt = excerptOf(stripAnsi(reply));
  const blocks = [...text.matchAll(/<<<REGRESS_ITEMS([\s\S]*?)REGRESS_ITEMS>>>/g)];
  const last = blocks.at(-1);
  let list: unknown;
  try {
    list = last ? JSON.parse(last[1]) : undefined;
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) return { error: "未找到条目块", rawExcerpt };
  const seen = new Set(existingTitles);
  const candidates: RegressCandidate[] = [];
  for (const raw of list) {
    const c = cleanCandidate(raw);
    if (!c || seen.has(c.title)) continue;
    seen.add(c.title);
    candidates.push(c);
    if (candidates.length >= maxCandidates) break;
  }
  return { candidates, rawExcerpt };
}

const RESULT = /^\s*\**RESULT:\s*(PASS|FAIL)\b\**\s*[—:-]?\s*(.*)$/i;

/** The verdict a reply ends with: the RESULT line among its last five non-empty lines, bottom up. */
export function parseVerdict(reply: string): { auto: RegressVerdict; reason: string; excerpt: string } {
  const text = stripAnsi(reply);
  const excerpt = excerptOf(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-5).reverse();
  for (const line of lines) {
    const m = RESULT.exec(line);
    if (!m) continue;
    // A line that says both is the template echoed back, not an answer.
    if (/\bPASS\b/i.test(line) && /\bFAIL\b/i.test(line)) return { auto: "pending", reason: "", excerpt };
    return { auto: m[1].toUpperCase() === "PASS" ? "pass" : "fail", reason: m[2].replace(/\*+$/, "").trim().slice(0, LIMITS.reason), excerpt };
  }
  return { auto: "pending", reason: "", excerpt };
}
