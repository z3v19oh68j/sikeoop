// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord, ReviewEvent, ReviewRun, ReviewerModel } from "../../src/shared/types.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { ReviewService } from "../../src/main/papers/review.ts";

const MODELS: ReviewerModel[] = ["甲", "乙", "丙", "丁", "戊"].map((m) => ({ providerId: `p-${m}`, providerName: `服务商${m}`, model: m }));
const form = (overall: number, decision: string, weakness: string) => JSON.stringify({ summary: "总结", strengths: ["优点"], weaknesses: [{ text: weakness, where: "Experiments" }], originality: 3, quality: 3, clarity: 3, significance: 3, overall, decision, confidence: 4 });
const PAPER = "# Introduction\n\nWe study routing.\n\n# Experiments\n\nWe compare our method with two baselines on three public datasets.";

type Call = { model: string; input: string; signal: AbortSignal; reply(text: string): void; fail(message: string): void };

function setup() {
  const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-review-")));
  const calls: Call[] = [];
  const events: ReviewEvent[] = [];
  const saved: { name: string; records: EvidenceRecord[] }[] = [];
  let root = "/project/a";
  const dispatcher = new Dispatcher({ emit: () => {} });
  const svc = new ReviewService({
    userData: () => userData,
    root: () => root,
    dispatcher,
    candidates: () => MODELS,
    call: (reviewer, _system, input, _delta, signal) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ model: reviewer.model, input, signal, reply: resolve, fail: (m) => reject(new Error(m)) });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    paper: async (id) => (id === "p1" ? { id, title: "工坊里的论文", authors: [], source: { kind: "file", path: "a.pdf" }, pages: 1, addedAt: 0, sections: [{ id: "s", title: "Intro", page: 1, text: "论文正文" }] } : null),
    readProjectFile: async (relative) => {
      if (relative !== "paper/main.tex") throw new Error("读不到这个文件");
      return PAPER;
    },
    saveEvidence: async (name, records) => {
      saved.push({ name, records });
      return { path: `research/${name}.repository.json`, name, records: records.length, updatedAt: 0 };
    },
    emit: (e) => events.push(e),
  });
  /** Waits until something is true (the service works in the background). */
  const until = async (what: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) {
      if (await what()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited too long");
  };
  const ended = async (id: string): Promise<ReviewRun> => {
    await until(async () => !["queued", "running"].includes((await svc.get(id))!.status) && (await svc.get(id))!.endedAt !== undefined);
    return (await svc.get(id))!;
  };
  return { svc, calls, events, saved, userData, until, ended, setRoot: (r: string) => (root = r) };
}

test("reviewers are asked side by side; their reports are put together and stored", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "file", path: "paper/main.tex" }, reviewers: MODELS.slice(0, 3), reflections: 0 });
  assert.deepEqual([run.title, run.status, run.total, run.chars, run.truncated], ["main.tex", "running", 3, PAPER.length, false]);
  await t.until(() => t.calls.length === 3);
  assert.deepEqual(t.calls.map((c) => c.model).sort(), ["丙", "乙", "甲"], "all three are asked before any has answered");
  assert.ok(t.calls.every((c) => c.input.includes("We compare our method")));

  t.calls.find((c) => c.model === "乙")!.reply(form(3, "reject", "只报告了平均值，没有方差和显著性检验"));
  t.calls.find((c) => c.model === "甲")!.reply("好的：\n" + form(7, "minor", "对比的基线太少，没有包含近两年的动态路由工作"));
  t.calls.find((c) => c.model === "丙")!.reply(form(6, "minor", "没有和最近的动态路由方法对比，基线太少"));
  const done = await t.ended(run.id);
  assert.deepEqual([done.status, done.done, done.total], ["done", 3, 3]);
  assert.deepEqual(done.reports.map((r) => [r.reviewer.model, r.status, r.overall]), [["甲", "done", 7], ["乙", "done", 3], ["丙", "done", 6]], "reports stay in the order the reviewers were chosen");
  assert.deepEqual([done.summary?.mean, done.summary?.spread, done.summary?.weaknesses.map((w) => w.reviewers)], [5.3, 4, [[0, 2], [1]]]);
  assert.deepEqual(done.summary?.disputes.map((d) => d.id), ["decision", "overall"]);

  const last = t.events.filter((e) => e.type === "run").at(-1);
  assert.equal(last?.type === "run" && last.run.status, "done");
  assert.deepEqual((await t.svc.list()).map((r) => r.id), [run.id]);
  const [project] = readdirSync(path.join(t.userData, "paper-reviews"));
  assert.equal(readFileSync(path.join(t.userData, "paper-reviews", project, run.id, "text.txt"), "utf8"), PAPER);

  t.setRoot("/project/b");
  assert.deepEqual(await t.svc.list(), [], "another project doesn't see it");
  assert.equal(await t.svc.get(run.id), null);
});

test("five reviewers with three rounds of reflection fit in one job tree; a round sees the previous report", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "text", text: "一篇粘贴的稿件。", title: "粘贴稿" }, reviewers: MODELS, reflections: 3 });
  assert.equal(run.total, 20);
  let answered = 0;
  await t.until(() => {
    for (const c of t.calls.splice(0)) {
      const round = c.input.includes("# 你上一轮的审稿意见") ? 1 : 0;
      if (round) assert.ok(c.input.includes('"overall"'), "the reflection is shown the earlier report");
      c.reply(form(5 + (answered++ % 2), "minor", "基线太少"));
    }
    return answered === 20;
  });
  const done = await t.ended(run.id);
  assert.deepEqual([done.status, done.done, done.total], ["done", 20, 20]);
  assert.ok(done.reports.every((r) => r.status === "done" && r.reflected === 3));
});

test("one reviewer failing or answering nonsense leaves the others' review standing", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "paper", paperId: "p1" }, reviewers: MODELS.slice(0, 3), reflections: 1 });
  assert.equal(run.title, "工坊里的论文");
  await t.until(() => t.calls.length === 3);
  const [a, b, c] = ["甲", "乙", "丙"].map((m) => t.calls.find((x) => x.model === m)!);
  a.fail("429 请求太多");
  b.reply("我没法评审这篇稿子。");
  c.reply(form(6, "minor", "基线太少"));
  // Only the reviewer with a report reflects; its second round failing keeps the first report.
  await t.until(() => t.calls.length === 4);
  assert.equal(t.calls[3].model, "丙");
  t.calls[3].reply("这次不是 JSON 也没有分数");
  const done = await t.ended(run.id);
  assert.deepEqual(done.reports.map((r) => [r.status, r.error, r.reflected]), [["failed", "429 请求太多", 0], ["failed", "没有返回可用的审稿结果", 0], ["done", undefined, 0]]);
  assert.deepEqual([done.status, done.done, done.total, done.summary?.reports, done.summary?.mean], ["done", 4, 4, 1, 6]);
});

test("nobody usable is a failed run that says why", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "text", text: "稿件" }, reviewers: MODELS.slice(0, 2), reflections: 0 });
  await t.until(() => t.calls.length === 2);
  t.calls[0].fail("没有配置 Key");
  t.calls[1].fail("没有配置 Key");
  const done = await t.ended(run.id);
  assert.deepEqual([done.status, done.summary, done.error], ["failed", undefined, "审稿人都没有返回可用的结果：没有配置 Key"]);
});

test("cancelling stops every call that is going and asks nothing more", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "text", text: "稿件" }, reviewers: MODELS.slice(0, 3), reflections: 2 });
  await t.until(() => t.calls.length === 3);
  t.calls[0].reply(form(6, "minor", "基线太少"));
  await t.until(() => t.calls.length === 4);
  t.svc.cancel(run.id);
  const done = await t.ended(run.id);
  assert.equal(done.status, "cancelled");
  assert.ok(t.calls.every((c, i) => i === 0 || c.signal.aborted), "the calls still out are aborted");
  assert.equal(t.calls.length, 4, "no further round is asked");
  assert.deepEqual(done.reports.map((r) => r.status), ["done", "failed", "failed"]);
  assert.equal(done.summary, undefined);
});

test("a request is checked before anything is asked", async () => {
  const t = setup();
  const two = MODELS.slice(0, 2);
  const text = { kind: "text", text: "稿件" };
  await assert.rejects(t.svc.start({ source: text, reviewers: MODELS.slice(0, 1), reflections: 0 }), /请选择 2 到 5 位审稿人/);
  await assert.rejects(t.svc.start({ source: text, reviewers: [...MODELS, MODELS[0]], reflections: 0 }), /请选择 2 到 5 位审稿人/);
  await assert.rejects(t.svc.start({ source: text, reviewers: [MODELS[0], MODELS[0]], reflections: 0 }), /同一个模型只能当一位审稿人/);
  await assert.rejects(t.svc.start({ source: text, reviewers: [MODELS[0], { providerId: "x", providerName: "x", model: "不在列表里" }], reflections: 0 }), /现在不可用/);
  await assert.rejects(t.svc.start({ source: text, reviewers: two, reflections: 4 }), /自我反思轮数只能是 0 到 3/);
  await assert.rejects(t.svc.start({ source: { kind: "text", text: "   " }, reviewers: two, reflections: 0 }), /稿件是空的/);
  await assert.rejects(t.svc.start({ source: { kind: "paper", paperId: "nope" }, reviewers: two, reflections: 0 }));
  await assert.rejects(t.svc.start({ source: { kind: "file", path: "../outside.tex" }, reviewers: two, reflections: 0 }), /读不到这个文件/);
  await assert.rejects(async () => t.svc.get("../../etc/passwd"), /审稿记录编号不正确/);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(await t.svc.list(), []);
});

test("a long manuscript is cut and the run says so", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "text", text: "字".repeat(60_500) }, reviewers: MODELS.slice(0, 2), reflections: 0 });
  assert.deepEqual([run.chars, run.truncated], [60_000, true]);
  await t.until(() => t.calls.length === 2);
  assert.ok(t.calls[0].input.includes("只给出了前面一部分"));
  t.svc.cancel(run.id);
  await t.ended(run.id);
});

test("a weakness goes on to polishing with its passage, and to deep research as evidence", async () => {
  const t = setup();
  const run = await t.svc.start({ source: { kind: "file", path: "paper/main.tex" }, reviewers: MODELS.slice(0, 2), reflections: 0 });
  await t.until(() => t.calls.length === 2);
  t.calls.find((c) => c.model === "甲")!.reply(form(7, "minor", "对比的基线太少，没有包含近两年的动态路由工作"));
  t.calls.find((c) => c.model === "乙")!.reply(form(3, "reject", "只报告了平均值，没有方差和显著性检验"));
  await t.ended(run.id);

  const seed = await t.svc.polishSeed(run.id, 0);
  assert.equal(seed.text, "We compare our method with two baselines on three public datasets.");
  assert.ok(seed.note.includes("对比的基线太少") && seed.note.includes("不要编造"));
  await assert.rejects(t.svc.polishSeed(run.id, 9));

  const h = await t.svc.toResearch(run.id, { kind: "dispute", id: "decision" });
  assert.equal(h.path, `research/review-${run.id.slice(0, 8)}-dispute-decision.repository.json`);
  assert.ok(h.question.includes("main.tex"));
  assert.deepEqual([t.saved[0].name, t.saved[0].records.length], [`review-${run.id.slice(0, 8)}-dispute-decision`, 2]);
  await assert.rejects(t.svc.toResearch(run.id, { kind: "dispute", id: "nope" }));
  assert.equal(t.saved.length, 1, "nothing is saved for a target that isn't there");

  await t.svc.delete(run.id);
  assert.deepEqual(await t.svc.list(), []);
  assert.deepEqual(t.events.at(-1), { type: "removed", id: run.id });
});
