// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MANUSCRIPT, decisionOf, lines, looseJson, parseReview, reflectPrompt, reviewPrompt, score } from "../../src/main/papers/review-parse.ts";

const form = {
  summary: "做了动态路由。",
  strengths: ["问题清楚", "容易复现"],
  weaknesses: [{ text: "基线太少", where: "Experiments" }, "没有方差"],
  questions: ["路由器多大？"],
  suggestions: ["补消融"],
  originality: 3, quality: 2, clarity: 3, significance: 3, overall: 6, decision: "minor", confidence: 4,
};

test("a clean JSON review form is read as it is", () => {
  const r = parseReview(JSON.stringify(form));
  assert.deepEqual(r, {
    summary: "做了动态路由。", strengths: ["问题清楚", "容易复现"],
    weaknesses: [{ text: "基线太少", where: "Experiments" }, { text: "没有方差" }],
    questions: ["路由器多大？"], suggestions: ["补消融"], overall: 6, decision: "minor", confidence: 4,
    scores: { originality: 3, quality: 2, clarity: 3, significance: 3 },
  });
});

test("JSON wrapped in prose or a code fence is still found", () => {
  assert.equal(parseReview("好的，这是我的意见：\n```json\n" + JSON.stringify(form) + "\n```\n希望有帮助。")?.overall, 6);
  assert.equal(parseReview("审稿意见如下 " + JSON.stringify(form) + " 以上。")?.decision, "minor");
  assert.equal(looseJson("没有 JSON"), null);
  assert.equal(looseJson("[1, 2]"), null, "an array is not a form");
});

test("scores are clamped and read out of text; a decision in words maps to the four choices", () => {
  const r = parseReview(JSON.stringify({ ...form, overall: "7/10", originality: "4（很好）", quality: 9, clarity: 0, significance: 2.6, confidence: "很有把握 5", decision: "Weak Accept" }));
  assert.deepEqual([r?.overall, r?.confidence, r?.decision], [7, 5, "minor"]);
  assert.deepEqual(r?.scores, { originality: 4, quality: 4, clarity: 1, significance: 3 });
  assert.equal(score("没有数字", 1, 10), undefined);
  for (const [word, want] of [["接收", "accept"], ["Accept", "accept"], ["小修后接收", "minor"], ["major revision", "major"], ["大修", "major"], ["weak reject", "major"], ["拒稿", "reject"], ["Reject", "reject"], ["不好说", undefined]] as const) {
    assert.equal(decisionOf(word), want, word);
  }
});

test("alternative field names and nested scores are accepted; a missing sub-score leaves no sub-scores", () => {
  const nested = parseReview(JSON.stringify({ rating: 8, recommendation: "accept", scores: { novelty: 4, soundness: 3, presentation: 3, contribution: 4 }, strengths: "- 实验充分\n- 写得清楚" }));
  assert.deepEqual([nested?.overall, nested?.decision, nested?.scores, nested?.strengths], [8, "accept", { originality: 4, quality: 3, clarity: 3, significance: 4 }, ["实验充分", "写得清楚"]]);
  assert.equal(parseReview(JSON.stringify({ overall: 5, originality: 3, quality: 3 }))?.scores, undefined);
});

test("a reply that is not JSON falls back to headed lists and a score line", () => {
  const r = parseReview("## 优点\n- 问题重要\n- 数据公开\n\n## 缺点\n1. 基线太少\n2. 没有显著性检验\n\n## 问题\n- 训练花了多久？\n\n总分：5\n建议：大修");
  assert.deepEqual(r?.strengths, ["问题重要", "数据公开"]);
  assert.deepEqual(r?.weaknesses, [{ text: "基线太少" }, { text: "没有显著性检验" }]);
  assert.deepEqual([r?.questions, r?.overall, r?.decision], [["训练花了多久？"], 5, "major"]);
  const en = parseReview("Strengths:\n* Clear writing\nWeaknesses:\n* Few baselines\nOverall score: 4\nRecommendation: reject");
  assert.deepEqual([en?.strengths, en?.weaknesses, en?.overall, en?.decision], [["Clear writing"], [{ text: "Few baselines" }], 4, "reject"]);
});

test("nothing usable is null, not an empty form", () => {
  assert.equal(parseReview("我没法评审这篇稿子。"), null);
  assert.equal(parseReview(JSON.stringify({ summary: "只有一句总结" })), null);
  assert.equal(parseReview(""), null);
  assert.deepEqual(lines(["  - a ", "a", "", 3, { text: "b" }]), ["a", "b"], "blank, repeated and non-text items are dropped");
});

test("the prompts carry the manuscript, say when it was cut, and a reflection carries the previous report", () => {
  const p = reviewPrompt("动态路由", "正文内容", false);
  assert.ok(p.includes("# 稿件：动态路由") && p.includes("正文内容") && p.includes('"overall"'));
  assert.ok(!p.includes("只给出了前面一部分"));
  assert.ok(reviewPrompt("t", "x", true).includes("只给出了前面一部分"));
  const r = reflectPrompt("动态路由", "正文内容", false, '{"overall": 6}');
  assert.ok(r.includes("# 你上一轮的审稿意见") && r.includes('{"overall": 6}') && r.includes("正文内容"));
  assert.equal(MAX_MANUSCRIPT, 60_000);
});
