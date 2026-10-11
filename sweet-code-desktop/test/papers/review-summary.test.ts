// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewReport, ReviewRun } from "../../src/shared/types.ts";
import { disputesOf, mergeWeaknesses, polishNote, relatedPassage, researchSeed, samePoint, summarize } from "../../src/main/papers/review-summary.ts";

const report = (model: string, extra: Partial<ReviewReport>): ReviewReport => ({ reviewer: { providerId: model, providerName: model, model }, status: "done", reflected: 0, ...extra });
const A = report("甲", {
  overall: 6, decision: "minor", scores: { originality: 3, quality: 2, clarity: 3, significance: 3 }, summary: "思路清楚，实验不够。", strengths: ["问题清楚"],
  weaknesses: [{ text: "实验只和两个基线做了对比，缺少和最近的动态路由方法的比较", where: "Experiments" }, { text: "延迟的测量条件没有说明：批大小、硬件、是否包含路由本身的开销都不清楚" }],
});
const B = report("乙", {
  overall: 3, decision: "reject", scores: { originality: 1, quality: 2, clarity: 3, significance: 2 }, summary: "贡献不足。", strengths: ["写作清晰"],
  weaknesses: [{ text: "对比的基线太少，没有包含近两年的动态路由工作，难以判断提升是否来自方法本身" }, { text: "只报告了平均值，没有方差和显著性检验" }],
});
const C = report("丙", {
  overall: 7, decision: "minor", scores: { originality: 3, quality: 3, clarity: 4, significance: 3 }, summary: "实用。",
  weaknesses: [{ text: "延迟数据的测量方式没有交代清楚，不同硬件上结论可能不同" }, { text: "没有和最近的动态路由方法对比" }],
});
const failed = report("丁", { status: "failed", error: "429", weaknesses: [{ text: "不该算进去" }] });

test("reworded weaknesses are one entry that says who raised it; unrelated ones stay apart", () => {
  const merged = mergeWeaknesses([A, B, C, failed]);
  assert.deepEqual(merged.map((m) => [m.text.slice(0, 8), m.reviewers]), [
    ["实验只和两个基线", [0, 1, 2]],
    ["延迟的测量条件没", [0, 2]],
    ["只报告了平均值，", [1]],
  ]);
  assert.equal(merged[0].where, "Experiments");
  assert.deepEqual(merged[0].variants, ["对比的基线太少，没有包含近两年的动态路由工作，难以判断提升是否来自方法本身", "没有和最近的动态路由方法对比"]);
  assert.deepEqual(merged[2].variants, []);
});

test("the same reviewer saying one thing twice counts once; English is matched on words", () => {
  const twice = report("甲", { weaknesses: [{ text: "只报告了平均值，没有方差和显著性检验" }, { text: "缺少方差和显著性检验，只有均值" }] });
  assert.deepEqual(mergeWeaknesses([twice]).map((m) => m.reviewers), [[0]]);
  assert.ok(samePoint("No variance or significance tests are reported.", "The paper reports only means, without variance or statistical significance tests."));
  assert.ok(samePoint("The evaluation only compares against two baselines and omits recent dynamic routing methods.", "Too few baselines: recent dynamic routing approaches are missing from the comparison."));
  assert.ok(!samePoint("No variance or significance tests are reported.", "The novelty over early-exit methods is unclear."));
  assert.ok(!samePoint("The evaluation only compares against two baselines.", "Latency measurement conditions (batch size, hardware) are not described."));
  assert.ok(!samePoint("实验不足", "实验只和两个基线做了对比，缺少和最近的动态路由方法的比较"), "two characters in common are not the same point");
});

test("the summary: mean, spread, decisions and sub-score means over the usable reports", () => {
  const s = summarize([A, B, C, failed]);
  assert.deepEqual([s.reports, s.mean, s.min, s.max, s.spread], [3, 5.3, 3, 7, 4]);
  assert.deepEqual(s.decisions, { accept: 0, minor: 2, major: 0, reject: 1 });
  assert.deepEqual(s.scores, { originality: 2.3, quality: 2.3, clarity: 3.3, significance: 2.7 });
  assert.equal(s.weaknesses.length, 3);
  const none = summarize([failed]);
  assert.deepEqual([none.reports, none.mean, none.spread, none.weaknesses, none.disputes], [0, null, null, [], []]);
});

test("disputes: split on acceptance, far-apart overall scores, a sub-score two apart", () => {
  const d = disputesOf([A, B, C]);
  assert.deepEqual(d.map((x) => x.id), ["decision", "overall", "originality"]);
  assert.match(d[0].detail, /甲（小修）、丙（小修） 认为可以；乙（拒绝） 认为不够/);
  assert.match(d[1].detail, /最高 7 分（丙），最低 3 分（乙）/);
  assert.deepEqual(disputesOf([A, C]), [], "reviewers who agree have nothing to dispute");
});

test("the passage a weakness is about: the quoted words, the named section, else the closest paragraph", () => {
  const paper = "# Introduction\n\nWe study routing between expert modules.\n\n# Experiments\n\nWe compare our method with two baselines on three public datasets. Latency is reduced by 31% on average.\n\n# 结论\n\n本文的延迟测量在单张显卡上完成，批大小为 8，没有计入路由器本身的开销，这一点需要在后续工作中补充说明。";
  assert.match(relatedPassage(paper, { text: "基线太少", where: "two baselines on three public datasets" }), /^We compare our method/);
  assert.match(relatedPassage(paper, { text: "基线太少", where: "Experiments" }), /^We compare our method/);
  assert.match(relatedPassage(paper, { text: "延迟的测量条件没有说明：批大小、硬件、路由本身的开销" }), /^本文的延迟测量/);
  assert.equal(relatedPassage(paper, { text: "参考文献格式不统一" }), "", "nothing fits: left for the user to paste");
  assert.match(relatedPassage("\\section{Method}\nWe route by difficulty.\n\\section{Results}\nAccuracy drops by 0.4.", { text: "x", where: "Results" }), /^Accuracy drops/);
});

test("what polishing is asked to do names the comment and forbids inventing data", () => {
  const w = mergeWeaknesses([A, B, C])[0];
  const note = polishNote(w, 3);
  assert.ok(note.includes("3 / 3 位审稿人提到") && note.includes(w.text) && note.includes("不要编造"));
  assert.ok(!polishNote(w, 1).includes("位审稿人提到"));
});

test("a weakness or a dispute becomes a question and one evidence record per reviewer", () => {
  const run: ReviewRun = { id: "12345678-aaaa-bbbb-cccc-000000000000", title: "动态路由", source: { kind: "text" }, chars: 100, truncated: false, reflections: 0, status: "done", done: 4, total: 4, startedAt: 0, reports: [A, B, C, failed], summary: summarize([A, B, C, failed]) };
  const w = researchSeed(run, { kind: "weakness", index: 1 })!;
  assert.equal(w.name, "review-12345678-weakness-2");
  assert.ok(w.question.includes("延迟的测量条件没有说明") && w.question.includes("动态路由"));
  assert.deepEqual(w.records.map((r) => [r.ref, r.claims[0].title]), [
    ["review:12345678:r1", "提出了这条缺点"],
    ["review:12345678:r2", "没有提这条缺点"],
    ["review:12345678:r3", "提出了这条缺点"],
  ]);
  assert.ok(w.records.every((r) => r.source.includes("未核实") && [...r.title].length <= 200 && [...r.detail].length <= 500));
  assert.match(w.records[1].claims[0].detail, /它看到的优点：写作清晰/);

  const d = researchSeed(run, { kind: "dispute", id: "decision" })!;
  assert.equal(d.name, "review-12345678-dispute-decision");
  assert.match(d.records[0].title, /甲 的审稿意见（小修，总分 6）/);
  assert.deepEqual(d.records[0].claims.map((c) => c.title), ["分项评分（满分 4）", "它看到的优点", "它看到的缺点"]);
  assert.equal(researchSeed(run, { kind: "weakness", index: 99 }), null);
  assert.equal(researchSeed(run, { kind: "dispute", id: "nope" }), null);
  assert.equal(researchSeed({ ...run, summary: undefined }, { kind: "weakness", index: 0 }), null);
});
