// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import type { DisclosureFacts } from "../../src/shared/types.ts";
import { composeDisclosure, nothingUsed } from "../../src/main/papers/disclosure.ts";
import { writingInput } from "../../src/main/papers/prompts.ts";

const none: DisclosureFacts = { translatedPapers: 0, summarizedPapers: 0, evidenceRepositories: 0, writing: {}, reviews: 0, ideaRuns: 0, noveltyChecks: 0, researchRuns: 0, models: [] };

test("with nothing on record the draft says so instead of claiming a use", () => {
  assert.ok(nothingUsed(none));
  const d = composeDisclosure(none);
  assert.match(d.zh, /还没有使用记录/);
  assert.match(d.en, /No use .* has been recorded/);
  assert.ok(!d.zh.includes("生成式人工智能工具作为辅助"));
});

test("only what was used is mentioned, numbered in order, in both languages", () => {
  const d = composeDisclosure({ ...none, translatedPapers: 2, summarizedPapers: 3, writing: { proofread: 1, polish_en: 4, shorten: 0 }, reviews: 2, models: ["model-a", "model-b"] });
  assert.match(d.zh, /（1）文献阅读：对 3 篇文献使用了机器翻译和生成结构化摘要/);
  assert.match(d.zh, /（2）写作辅助：英文润色、语法与拼写检查；（3）模拟审稿：用多个语言模型对稿件做了 2 次模拟同行评审/);
  assert.ok(!d.zh.includes("（4）") && !d.zh.includes("精简段落") && !d.zh.includes("选题") && !d.zh.includes("对抗研判"));
  assert.match(d.zh, /记录到的模型包括 model-a、model-b。/);
  assert.match(d.zh, /AI 工具不具备作者资格，未列为作者。$/);
  assert.match(d.en, /\(1\) literature reading \(machine translation and structured summaries of 3 papers/);
  assert.match(d.en, /\(2\) writing assistance \(polishing English text and grammar and spelling checks\); \(3\) simulated peer review \(the manuscript was reviewed twice/);
  assert.match(d.en, /The models on record include model-a and model-b\. /);
  assert.equal(d.facts.reviews, 2);
});

test("every kind of use has its sentence", () => {
  const d = composeDisclosure({ ...none, evidenceRepositories: 1, ideaRuns: 1, noveltyChecks: 3, researchRuns: 1, writing: { translate_zh_en: 2 } });
  for (const part of ["证据整理：从文献中抽取论点", "写作辅助：中译英", "选题：由模型提出候选研究点子，并借助文献库检索初步核对其新颖性", "多模型对抗研判：就研究问题让多个模型相互质询 1 次"]) assert.ok(d.zh.includes(part), part);
  for (const part of ["evidence extraction", "Chinese-to-English translation", "candidate ideas proposed by a model and a preliminary novelty check", "cross-examined each other once"]) assert.ok(d.en.includes(part), part);
  assert.ok(!d.zh.includes("记录到的模型"), "no model sentence without a model on record");
  const onlyCheck = composeDisclosure({ ...none, noveltyChecks: 1 });
  assert.match(onlyCheck.zh, /选题：借助文献库检索初步核对其新颖性/);
  assert.match(composeDisclosure({ ...none, translatedPapers: 1 }).en, /machine translation of 1 paper,/);
});

test("a reviewer's comment handed to polishing goes in right before the text; without one nothing changes", () => {
  const req = { action: "polish_zh" as const, text: "正文", format: "plain" as const };
  const plain = writingInput(req);
  assert.ok(plain.endsWith("\n正文") && !plain.includes("额外要求"));
  const noted = writingInput({ ...req, note: "  补上基线对比  " });
  assert.ok(noted.includes("（这次的额外要求：补上基线对比）") && noted.endsWith("\n正文"));
  const preset = { id: "u", name: "我的", prefix: "请润色：", suffix: "。完", origin: "user" as const };
  assert.equal(writingInput(req, preset), "请润色：正文。完");
  assert.equal(writingInput({ ...req, note: "要求" }, preset), "请润色：\n（这次的额外要求：要求）\n正文。完");
});
