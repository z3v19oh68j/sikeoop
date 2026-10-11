// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import type { IdeaRun, NoveltyWork, PaperDoc, ResearchIdea } from "../../src/shared/types.ts";
import { backgroundOf, ideaRecord, ideaResearchSeed, ideasMarkdown, ideasPrompt, noveltyPrompt, parseIdeas, parseNovelty, queriesOf, verdictOf } from "../../src/main/papers/ideas-parse.ts";

let n = 0;
const newId = () => `id-${++n}`.padEnd(12, "0");
const raw = (extra: object = {}) => ({ title: "按证据覆盖度决定要不要回答", oneLine: "覆盖不足时明确拒答。", motivation: "编造多发生在检索没找全时。", plan: "三种设置对比编造率。", interest: 7, feasibility: 8, novelty: 5, rationale: "数据好找。", keywords: ["answerability estimation long document qa", "evidence coverage abstention"], ...extra });

test("ideas are read from the reply, cleaned, and capped at the number asked for", () => {
  const ideas = parseIdeas("```json\n" + JSON.stringify({ ideas: [raw(), raw({ title: "第二个", interest: "9/10", feasibility: 99, novelty: null, keywords: "one phrase" }), raw({ title: "" }), raw(), "不是对象", raw({ title: "第四个" })] }) + "\n```", 3, newId);
  assert.deepEqual(ideas.map((i) => i.title), ["按证据覆盖度决定要不要回答", "第二个", "第四个"]);
  assert.deepEqual(ideas[1].scores, { interest: 9, feasibility: 10, novelty: 5 }, "scores are clamped; a missing one is the middle");
  assert.deepEqual(ideas[1].keywords, ["one phrase"]);
  assert.ok(ideas.every((i) => i.id && i.novelty === undefined));
  assert.deepEqual(parseIdeas("我想不出来。", 3, newId), []);
  assert.deepEqual(parseIdeas(JSON.stringify({ ideas: "不是数组" }), 3, newId), []);
});

test("an idea without search phrases is searched by its title", () => {
  const [idea] = parseIdeas(JSON.stringify({ ideas: [raw({ keywords: [] })] }), 1, newId);
  assert.deepEqual(queriesOf(idea), ["按证据覆盖度决定要不要回答"]);
  const [three] = parseIdeas(JSON.stringify({ ideas: [raw({ keywords: ["a b c", "d e f", "g h i", "j k l"] })] }), 1, newId);
  assert.equal(queriesOf(three).length, 3);
});

test("the novelty judgement: JSON, words for the verdict, and which works it leaned on", () => {
  assert.deepEqual(parseNovelty('{"verdict":"overlap","reason":"[2] 做了一部分","closest":[2,1,2,9,"x"]}', 3), { verdict: "overlap", reason: "[2] 做了一部分", closest: [1, 0, 2] });
  assert.equal(parseNovelty('{"verdict":"已有人做过","reason":"r"}', 3)?.verdict, "done");
  assert.equal(parseNovelty('{"verdict":"未见","reason":"r"}', 3)?.verdict, "unseen");
  assert.equal(parseNovelty("部分重叠。[1] 做了相近的问题，但没有针对小模型。", 2)?.verdict, "overlap");
  assert.equal(parseNovelty('{"reason":"没给结论"}', 3), null);
  assert.equal(parseNovelty("这个不好判断，需要更多信息。", 3), null);
  for (const [word, want] of [["done", "done"], ["partially overlapping", "overlap"], ["unseen", "unseen"], ["没有检索到相近工作", "unseen"], ["已有类似工作", "done"], [7, undefined]] as const) assert.equal(verdictOf(word), want, String(word));
});

const works: NoveltyWork[] = [
  { title: "Knowing When Not to Answer", year: 2024, url: "https://example.org/a", authors: ["A"], venue: "Conf", abstract: "We study abstention.", source: "openalex" },
  { title: "Title Only", year: null, url: "https://example.org/b", authors: [], source: "semantic_scholar" },
];
const idea = (): ResearchIdea => ({ ...parseIdeas(JSON.stringify({ ideas: [raw()] }), 1, newId)[0], novelty: { status: "done", verdict: "overlap", reason: "[1] 做了一部分。", works, queries: ["q1", "q2"], checkedAt: 1 } });

test("the prompts: the direction and background go in; works are numbered and a missing abstract is said", () => {
  const p = ideasPrompt("让小模型少编造", 5, ["## 背景论文\n摘要"]);
  assert.ok(p.includes("研究方向：让小模型少编造") && p.includes("提出 5 个") && p.includes("# 背景材料") && p.includes("## 背景论文"));
  assert.ok(!ideasPrompt("x", 3, []).includes("# 背景材料"));
  const j = noveltyPrompt(idea(), works);
  assert.ok(j.includes("[1] Knowing When Not to Answer（2024） · Conf") && j.includes("摘要开头：We study abstention."));
  assert.ok(j.includes("[2] Title Only") && j.includes("文献库里没有摘要"));
  const paper: PaperDoc = { id: "p", title: "一篇论文", authors: [], source: { kind: "file", path: "a.pdf" }, pages: 1, addedAt: 0, sections: [{ id: "s1", title: "Abstract", page: 1, text: "原文开头。" }] };
  assert.equal(backgroundOf(paper), "## 一篇论文\n原文开头。");
  assert.match(backgroundOf(paper, { oneLine: "一句话", problem: "问题", method: "", results: "结论", experiments: "", limitations: "局限", related: "" }), /一句话\n问题：问题\n结论：结论\n局限：局限/);
});

test("an idea as evidence: what it proposes and what the check found, within the length limits", () => {
  const r = ideaRecord({ ...idea(), motivation: "很".repeat(900) });
  assert.match(r.ref, /^idea:/);
  assert.deepEqual(r.claims.map((c) => c.title), ["动机", "实验方案草案", "新颖性检查：部分重叠"]);
  assert.ok(r.source.includes("未核实") && r.claims.every((c) => [...c.detail].length <= 500));
  assert.match(r.claims[2].detail, /最接近的论文：Knowing When Not to Answer（2024）；Title Only/);
  assert.deepEqual(ideaRecord({ ...idea(), novelty: undefined }).claims.map((c) => c.title), ["动机", "实验方案草案"]);

  const seed = ideaResearchSeed(idea());
  assert.match(seed.name, /^idea-/);
  assert.ok(seed.question.includes("值得做吗") && seed.question.includes("按证据覆盖度决定要不要回答"));
  assert.deepEqual(seed.records.slice(1).map((x) => [x.ref, x.source, x.claims.length]), [["https://example.org/a", "OpenAlex 检索结果", 0], ["https://example.org/b", "Semantic Scholar 检索结果", 0]]);
  assert.equal(seed.records[2].detail, "文献库里没有摘要。");
});

test("the Markdown export lists every idea with its scores and what the check found", () => {
  const run: IdeaRun = { id: "r", direction: "让小模型少编造", paperIds: [], status: "done", startedAt: 0, ideas: [idea(), { ...idea(), title: "第二个", novelty: undefined }] };
  const md = ideasMarkdown(run);
  assert.ok(md.startsWith("# 选题：让小模型少编造\n"));
  assert.ok(md.includes("## 1. 按证据覆盖度决定要不要回答") && md.includes("## 2. 第二个"));
  assert.ok(md.includes("有趣度 7 / 10 · 可行性 8 / 10 · 新颖性（估计）5 / 10"));
  assert.ok(md.includes("### 新颖性检查：部分重叠") && md.includes("- [Knowing When Not to Answer](https://example.org/a)，2024，Conf") && md.includes("检索词：q1；q2"));
  assert.equal(md.split("### 新颖性检查").length, 2, "an unchecked idea has no check section");
});
