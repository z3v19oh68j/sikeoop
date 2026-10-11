import type { EvidenceRecord, PaperReviewDecision, ReviewDispute, ReviewMergedWeakness, ReviewReport, ReviewRun, ReviewSummary } from "@shared/types";

// Putting several reviewers' reports together: the averages and how far apart they are, the
// weaknesses with the ones that say the same thing merged, what they disagree on, and what a
// weakness or a disagreement is handed on as (a passage to rewrite, a question for deep research).
// Pure functions: tested on their own.

const DECISIONS: PaperReviewDecision[] = ["accept", "minor", "major", "reject"];
export const DECISION_LABEL: Record<PaperReviewDecision, string> = { accept: "接收", minor: "小修", major: "大修", reject: "拒绝" };
const SCORE_LABEL = { originality: "原创性", quality: "质量", clarity: "清晰度", significance: "重要性" } as const;
type ScoreKey = keyof typeof SCORE_LABEL;

const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Lower case, no punctuation or spaces: what a heading is compared on. */
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/** Words that say nothing about which point is being made. */
const COMMON = new Set(
  "the and for are was were not but with without that this these those from have has had its their there which when what how why does did can could should would may might been being also only very more most less than then into over under about between while paper papers author authors work method methods approach result results study".split(" "),
);

/**
 * What a text is compared on: for Chinese (no spaces between words) every pair of neighbouring
 * characters, for Latin script its words without the common ones and without a plural "s".
 */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  for (const word of lower.match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!COMMON.has(word)) out.add(word.length > 4 ? word.replace(/s$/, "") : word);
  }
  return out;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** 0–1: how much of the shorter text's terms the other one has too. */
export function similarity(a: string, b: string): number {
  const x = terms(a);
  const y = terms(b);
  return x.size && y.size ? shared(x, y) / Math.min(x.size, y.size) : 0;
}

/**
 * Whether two weaknesses make the same point. Reworded sentences share about a quarter of their
 * terms or more; unrelated ones share a few percent. A very short text has to match more closely,
 * and one or two terms in common are never enough.
 */
export function samePoint(a: string, b: string): boolean {
  const x = terms(a);
  const y = terms(b);
  const both = shared(x, y);
  const small = Math.min(x.size, y.size);
  return both >= 3 && both / small >= (small < 6 ? 0.6 : 0.2);
}

/**
 * The reviewers' weaknesses as one list: wordings that share enough are one entry, which says who
 * raised it. Most-raised first, then in the order they appeared.
 */
export function mergeWeaknesses(reports: ReviewReport[]): ReviewMergedWeakness[] {
  const merged: ReviewMergedWeakness[] = [];
  reports.forEach((report, index) => {
    if (report.status !== "done") return;
    for (const w of report.weaknesses ?? []) {
      const same = merged.find((m) => [m.text, ...m.variants].some((t) => samePoint(t, w.text)));
      if (!same) {
        merged.push({ text: w.text, ...(w.where ? { where: w.where } : {}), reviewers: [index], variants: [] });
        continue;
      }
      if (!same.reviewers.includes(index)) same.reviewers.push(index);
      if (w.text !== same.text && !same.variants.includes(w.text)) same.variants.push(w.text);
      if (!same.where && w.where) same.where = w.where;
    }
  });
  // Stable: entries raised by equally many keep their order.
  return merged.map((m, i) => ({ m, i })).sort((a, b) => b.m.reviewers.length - a.m.reviewers.length || a.i - b.i).map((x) => x.m);
}

/** What the reviewers are split on: accept or not, the overall score, a sub-score. */
export function disputesOf(reports: ReviewReport[]): ReviewDispute[] {
  const done = reports.filter((r) => r.status === "done");
  const out: ReviewDispute[] = [];
  const name = (r: ReviewReport) => r.reviewer.model;
  const forIt = done.filter((r) => r.decision === "accept" || r.decision === "minor");
  const against = done.filter((r) => r.decision === "major" || r.decision === "reject");
  if (forIt.length && against.length) {
    out.push({
      id: "decision",
      topic: "这篇稿件够不够接收",
      detail: `${forIt.map((r) => `${name(r)}（${DECISION_LABEL[r.decision!]}）`).join("、")} 认为可以；${against.map((r) => `${name(r)}（${DECISION_LABEL[r.decision!]}）`).join("、")} 认为不够。`,
    });
  }
  const overall = done.filter((r) => r.overall !== undefined);
  if (overall.length >= 2) {
    const hi = overall.reduce((a, b) => (b.overall! > a.overall! ? b : a));
    const lo = overall.reduce((a, b) => (b.overall! < a.overall! ? b : a));
    if (hi.overall! - lo.overall! >= 3) out.push({ id: "overall", topic: "总分差得很远", detail: `最高 ${hi.overall} 分（${name(hi)}），最低 ${lo.overall} 分（${name(lo)}）。` });
  }
  for (const key of Object.keys(SCORE_LABEL) as ScoreKey[]) {
    const scored = done.filter((r) => r.scores);
    if (scored.length < 2) continue;
    const hi = scored.reduce((a, b) => (b.scores![key] > a.scores![key] ? b : a));
    const lo = scored.reduce((a, b) => (b.scores![key] < a.scores![key] ? b : a));
    if (hi.scores![key] - lo.scores![key] >= 2) {
      out.push({ id: key, topic: `${SCORE_LABEL[key]}评价不一`, detail: `${name(hi)} 给了 ${hi.scores![key]} 分，${name(lo)} 给了 ${lo.scores![key]} 分（满分 4）。` });
    }
  }
  return out;
}

export function summarize(reports: ReviewReport[]): ReviewSummary {
  const done = reports.filter((r) => r.status === "done");
  const overall = done.map((r) => r.overall).filter((n): n is number => n !== undefined);
  const decisions = Object.fromEntries(DECISIONS.map((d) => [d, done.filter((r) => r.decision === d).length])) as Record<PaperReviewDecision, number>;
  const sub = (key: ScoreKey) => mean(done.filter((r) => r.scores).map((r) => r.scores![key]));
  return {
    reports: done.length,
    mean: mean(overall),
    min: overall.length ? Math.min(...overall) : null,
    max: overall.length ? Math.max(...overall) : null,
    spread: overall.length ? Math.max(...overall) - Math.min(...overall) : null,
    decisions,
    scores: { originality: sub("originality"), quality: sub("quality"), clarity: sub("clarity"), significance: sub("significance") },
    weaknesses: mergeWeaknesses(reports),
    disputes: disputesOf(reports),
  };
}

const PASSAGE = 1800;

/**
 * The part of the manuscript a weakness is about, for rewriting: the paragraph that holds the
 * quoted words, else what follows the named section heading, else the paragraph that reads most
 * like the weakness. Empty when nothing fits (the user then pastes the passage).
 */
export function relatedPassage(manuscript: string, weakness: { text: string; where?: string }): string {
  const paragraphs = manuscript.split(/\n\s*\n|\n(?=\s*(?:\\section|\\subsection|#{1,4}\s))/).map((p) => p.trim()).filter(Boolean);
  const where = weakness.where?.trim();
  if (where) {
    // A section name is looked for before a quote: the heading itself also "contains" the name.
    const at = paragraphs.findIndex((p) => {
      const head = p.split("\n")[0].replace(/^\\(?:sub)*section\*?\{|\}$|^#+\s*|^\d+(?:\.\d+)*\.?\s+/g, "").trim();
      return head.length > 0 && head.length <= 120 && norm(head) === norm(where);
    });
    if (at >= 0) {
      // A heading on its own line: the passage is what comes under it.
      const own = paragraphs[at].split("\n").slice(1).join("\n").trim();
      return (own || paragraphs[at + 1] || "").slice(0, PASSAGE);
    }
    const quoted = paragraphs.find((p) => p.includes(where));
    if (quoted) return quoted.slice(0, PASSAGE);
  }
  // No quote and no heading to go by: the paragraph that uses the most of the comment's own terms.
  const wanted = terms(weakness.text);
  let best = "";
  let bestScore = 0.2;
  for (const p of paragraphs) {
    if (p.length < 40 || !wanted.size) continue;
    const s = shared(wanted, terms(p)) / wanted.size;
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return best.slice(0, PASSAGE);
}

/** What 写作与润色 is asked to do about a weakness. */
export function polishNote(weakness: ReviewMergedWeakness, total: number): string {
  const who = total > 1 ? `（${weakness.reviewers.length} / ${total} 位审稿人提到）` : "";
  return `针对这条审稿意见修改下面的段落${who}：${weakness.text}\n不要编造新的数据、实验或引用；意见要求补充而稿件里没有的内容，用「【待补充：……】」标出来。`;
}

const cut = (s: string, n: number) => [...s].slice(0, n).join("");

/**
 * A weakness or a disagreement as deep research takes it: a question, and one evidence record per
 * reviewer holding that reviewer's position. The records are model opinions, and say so.
 */
export function researchSeed(run: ReviewRun, target: { kind: "weakness"; index: number } | { kind: "dispute"; id: string }): { name: string; question: string; records: EvidenceRecord[] } | null {
  const summary = run.summary;
  if (!summary) return null;
  const weakness = target.kind === "weakness" ? summary.weaknesses[target.index] : undefined;
  const dispute = target.kind === "dispute" ? summary.disputes.find((d) => d.id === target.id) : undefined;
  if (!weakness && !dispute) return null;
  const about = weakness ? weakness.text : `${dispute!.topic}。${dispute!.detail}`;
  const question = weakness
    ? `审稿人对稿件「${run.title}」提出了这条缺点：${weakness.text}\n这条批评成立吗？请根据各位审稿人的意见，分别论证“成立，必须修改”和“不成立，或不影响结论”，并指出判断它需要哪些稿件里的证据。`
    : `审稿人对稿件「${run.title}」意见不一：${dispute!.topic}。${dispute!.detail}\n哪一方的判断更站得住？请分别为两种立场给出最强的论证，并指出分歧的根源是事实不清，还是评价标准不同。`;
  const records: EvidenceRecord[] = [];
  run.reports.forEach((r, i) => {
    if (r.status !== "done") return;
    const claims: EvidenceRecord["claims"] = [];
    if (weakness) {
      const own = (r.weaknesses ?? []).find((w) => [weakness.text, ...weakness.variants].includes(w.text));
      claims.push(
        own
          ? { title: "提出了这条缺点", detail: cut(own.text + (own.where ? `（针对：${own.where}）` : ""), 500) }
          : { title: "没有提这条缺点", detail: cut(r.strengths?.length ? `它看到的优点：${r.strengths.join("；")}` : "它的意见里没有涉及这一点。", 500) },
      );
    } else {
      if (r.scores) claims.push({ title: "分项评分（满分 4）", detail: `原创性 ${r.scores.originality}，质量 ${r.scores.quality}，清晰度 ${r.scores.clarity}，重要性 ${r.scores.significance}` });
      if (r.strengths?.length) claims.push({ title: "它看到的优点", detail: cut(r.strengths.join("；"), 500) });
      if (r.weaknesses?.length) claims.push({ title: "它看到的缺点", detail: cut(r.weaknesses.map((w) => w.text).join("；"), 500) });
    }
    records.push({
      ref: `review:${run.id.slice(0, 8)}:r${i + 1}`,
      title: cut(`${r.reviewer.model} 的审稿意见${r.decision ? `（${DECISION_LABEL[r.decision]}${r.overall !== undefined ? `，总分 ${r.overall}` : ""}）` : ""}`, 200),
      detail: cut(r.summary || about, 500),
      source: "模拟审稿（模型意见，未核实）",
      claims,
    });
  });
  if (!records.length) return null;
  const slug = weakness ? `weakness-${target.kind === "weakness" ? target.index + 1 : 0}` : `dispute-${dispute!.id}`;
  return { name: `review-${run.id.slice(0, 8)}-${slug}`, question, records };
}
