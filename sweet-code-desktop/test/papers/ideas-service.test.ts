// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord, IdeaEvent, IdeaRun } from "../../src/shared/types.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { IdeasService } from "../../src/main/papers/ideas.ts";

const idea = (title: string, keywords: string[]) => ({ title, oneLine: `${title}的一句话`, motivation: "动机", plan: "方案", interest: 7, feasibility: 6, novelty: 5, rationale: "理由", keywords });
const IDEAS = JSON.stringify({ ideas: [idea("点子一", ["first idea phrase"]), idea("点子二", ["second idea phrase"]), idea("点子三", ["third idea phrase"])] });
// Made-up search results in OpenAlex's shape.
const FOUND = { results: [{ id: "https://openalex.org/W1", display_name: "A Close Paper", publication_year: 2024, authorships: [] }, { id: "https://openalex.org/W2", display_name: "Another Paper", publication_year: 2022, authorships: [] }] };

function setup(opts: { search?: (query: string) => unknown } = {}) {
  const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-ideas-")));
  const asked: { input: string; reply(text: string): void; fail(message: string): void; signal: AbortSignal }[] = [];
  const searched: string[] = [];
  const events: IdeaEvent[] = [];
  const repos = new Map<string, EvidenceRecord[]>();
  const written = new Map<string, string>();
  let approve = true;
  const svc = new IdeasService({
    userData: () => userData,
    root: () => "/project/a",
    dispatcher: new Dispatcher({ emit: () => {} }),
    model: (_system, input, _delta, signal) =>
      new Promise<string>((resolve, reject) => {
        asked.push({ input, reply: resolve, fail: (m) => reject(new Error(m)), signal });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    paper: async (id) => (id === "p1" ? { paper: { id, title: "背景论文", authors: [], source: { kind: "file", path: "a.pdf" }, pages: 1, addedAt: 0, sections: [{ id: "s", title: "Abstract", page: 1, text: "背景正文" }] } } : null),
    fetch: (async (url: string | URL) => {
      const query = new URL(String(url)).searchParams.get("search") ?? "";
      searched.push(query);
      const body = (opts.search ?? (() => FOUND))(query);
      return { ok: body !== undefined, status: body === undefined ? 503 : 200, json: async () => body } as Response;
    }) as typeof fetch,
    semanticScholarKey: () => undefined,
    evidenceFiles: async () => [...repos.keys()].map((p) => ({ path: p, name: p, records: repos.get(p)!.length, updatedAt: 0 })),
    loadEvidence: async (relative) => repos.get(relative) ?? [],
    saveEvidence: async (name, records) => {
      repos.set(`research/${name}.repository.json`, records);
      return { path: `research/${name}.repository.json`, name, records: records.length, updatedAt: 0 };
    },
    approveExport: async () => approve,
    writeNewProjectFile: async (relative, content) => void written.set(relative, content),
    emit: (e) => events.push(e),
    sleep: async () => {},
  });
  const until = async (what: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 400; i++) {
      if (await what()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited too long");
  };
  const get = async (id: string): Promise<IdeaRun> => (await svc.list()).find((r) => r.id === id)!;
  /** A run with its three ideas generated. */
  const generated = async (): Promise<IdeaRun> => {
    const run = await svc.start({ direction: "让小模型少编造", paperIds: [], count: 3 });
    await until(() => asked.length > 0);
    asked.shift()!.reply(IDEAS);
    await until(async () => (await get(run.id)).status === "done");
    return get(run.id);
  };
  return { svc, asked, searched, events, repos, written, until, get, generated, setApprove: (v: boolean) => (approve = v) };
}

test("ideas are generated from the direction and the chosen papers, and stored", async () => {
  const t = setup();
  const run = await t.svc.start({ direction: "  让小模型少编造  ", paperIds: ["p1", "p1"], count: 2 });
  assert.deepEqual([run.direction, run.paperIds, run.status, run.ideas], ["让小模型少编造", ["p1"], "running", []]);
  await t.until(() => t.asked.length === 1);
  assert.ok(t.asked[0].input.includes("研究方向：让小模型少编造") && t.asked[0].input.includes("## 背景论文") && t.asked[0].input.includes("提出 2 个"));
  t.asked[0].reply(IDEAS);
  await t.until(async () => (await t.get(run.id)).status === "done");
  const done = await t.get(run.id);
  assert.deepEqual(done.ideas.map((i) => i.title), ["点子一", "点子二"], "no more than were asked for");
  assert.ok(done.endedAt !== undefined && done.ideas.every((i) => i.novelty === undefined));
  assert.equal(t.searched.length, 0, "generating ideas doesn't go online");
});

test("a reply without ideas, a failing model and a cancel each end the run with its reason", async () => {
  const t = setup();
  const empty = await t.svc.start({ direction: "方向", paperIds: [], count: 3 });
  await t.until(() => t.asked.length === 1);
  t.asked.shift()!.reply("我想不出来。");
  await t.until(async () => (await t.get(empty.id)).status === "failed");
  assert.match((await t.get(empty.id)).error!, /没有给出可用的点子/);

  const broken = await t.svc.start({ direction: "方向", paperIds: [], count: 3 });
  await t.until(() => t.asked.length === 1);
  t.asked.shift()!.fail("401 Key 无效");
  await t.until(async () => (await t.get(broken.id)).status === "failed");
  assert.equal((await t.get(broken.id)).error, "401 Key 无效");

  const stopped = await t.svc.start({ direction: "方向", paperIds: [], count: 3 });
  await t.until(() => t.asked.length === 1);
  t.svc.cancel(stopped.id);
  await t.until(async () => (await t.get(stopped.id)).endedAt !== undefined);
  assert.equal((await t.get(stopped.id)).status, "cancelled");
  assert.ok(t.asked[0].signal.aborted);

  await assert.rejects(t.svc.start({ direction: " ", paperIds: [], count: 3 }), /请写下研究方向/);
  await assert.rejects(t.svc.start({ direction: "方向", paperIds: [], count: 11 }), /1 到 10 个/);
  await assert.rejects(t.svc.start({ direction: "方向", paperIds: ["gone"], count: 3 }), /不在工坊里了/);
});

test("the novelty check waits for consent, searches the idea's phrases and has the model judge what was found", async () => {
  const t = setup();
  const run = await t.generated();
  await assert.rejects(t.svc.check(run.id), /先阅读并同意联网检索的说明/);
  assert.equal(t.searched.length, 0, "nothing is searched before consent");
  assert.equal(await t.svc.consent(), false);
  await t.svc.grantConsent();
  assert.equal(await t.svc.consent(), true);

  const checking = t.svc.check(run.id, run.ideas[1].id);
  await t.until(() => t.asked.length === 1);
  assert.deepEqual(t.searched, ["second idea phrase"]);
  assert.equal((await t.get(run.id)).ideas[1].novelty?.status, "checking");
  await assert.rejects(t.svc.check(run.id), /正在检查/);
  assert.ok(t.asked[0].input.includes("[1] A Close Paper（2024）") && t.asked[0].input.includes("点子二"));
  t.asked.shift()!.reply('{"verdict":"overlap","reason":"[2] 做了一部分","closest":[2]}');
  const after = await checking;
  const n = after.ideas[1].novelty!;
  assert.deepEqual([n.status, n.verdict, n.reason, n.works.map((w) => w.title), n.queries], ["done", "overlap", "[2] 做了一部分", ["Another Paper", "A Close Paper"], ["second idea phrase"]]);
  assert.deepEqual([after.ideas[0].novelty, after.ideas[2].novelty], [undefined, undefined], "only the idea asked about is checked");
  assert.deepEqual((await t.get(run.id)).ideas[1].novelty?.verdict, "overlap", "stored");
});

test("nothing found is 'unseen' without asking the model; a failed search or judgement is that idea's failure only", async () => {
  const t = setup({ search: (q) => (q.startsWith("first") ? { results: [] } : q.startsWith("second") ? undefined : FOUND) });
  const run = await t.generated();
  await t.svc.grantConsent();
  const checking = t.svc.check(run.id);
  await t.until(() => t.asked.length === 1);
  t.asked.shift()!.reply("这个不好判断。");
  const after = await checking;
  assert.deepEqual(after.ideas.map((i) => [i.novelty?.status, i.novelty?.verdict]), [["done", "unseen"], ["failed", undefined], ["failed", undefined]]);
  assert.match(after.ideas[0].novelty!.reason!, /不等于一定没人做过/);
  assert.match(after.ideas[1].novelty!.error!, /暂时无法访问（503）/);
  assert.match(after.ideas[2].novelty!.error!, /没有给出可用的判断/);
});

test("checking again and again doesn't run out of the job tree's budget; cancel stops after the idea it is on", async () => {
  const t = setup({ search: () => FOUND });
  const run = await t.generated();
  await t.svc.grantConsent();
  for (let i = 0; i < 24; i++) {
    const checking = t.svc.check(run.id, run.ideas[0].id);
    await t.until(() => t.asked.length === 1);
    t.asked.shift()!.reply('{"verdict":"unseen","reason":"没有相近的"}');
    assert.equal((await checking).ideas[0].novelty?.verdict, "unseen", `check ${i + 1}`);
  }

  const all = t.svc.check(run.id);
  await t.until(() => t.asked.length === 1);
  t.svc.cancel(run.id);
  const after = await all;
  assert.equal(after.ideas[0].novelty?.status, "failed");
  assert.equal(after.ideas[1].novelty, undefined, "the next idea isn't started");
  assert.equal(after.status, "done", "the ideas themselves are untouched");
});

test("the e-mail for OpenAlex is kept only when it is an address, and sent with the search", async () => {
  const t = setup({ search: () => ({ results: [] }) });
  assert.deepEqual(await t.svc.settings(), { mailto: "", semanticScholar: false });
  await assert.rejects(t.svc.setSettings({ mailto: "not an email" }));
  assert.deepEqual(await t.svc.setSettings({ mailto: " me@example.org " }), { mailto: "me@example.org", semanticScholar: false });
  assert.equal((await t.svc.setSettings({ mailto: "" })).mailto, "");
});

test("ideas go on as evidence drafts, as a deep-research question, and as a Markdown file after asking", async () => {
  const t = setup();
  const run = await t.generated();
  const [a, b] = run.ideas;

  const file = await t.svc.toEvidence(run.id, [a.id], "ideas");
  assert.deepEqual([file.path, file.records], ["research/ideas.repository.json", 1]);
  await t.svc.toEvidence(run.id, [a.id, b.id], "ideas");
  assert.deepEqual(t.repos.get("research/ideas.repository.json")!.map((r) => r.title), ["点子一", "点子二"], "an idea already there is replaced, not added twice");
  await assert.rejects(t.svc.toEvidence(run.id, ["nope"], "ideas"), /没有找到这些点子/);
  // A name can't leave research/: separators are replaced, an empty name is refused.
  assert.equal((await t.svc.toEvidence(run.id, [a.id], "../../outside")).path, "research/_.._outside.repository.json");
  await assert.rejects(t.svc.toEvidence(run.id, [a.id], "  "), /请填写简短的文件名/);

  const h = await t.svc.toResearch(run.id, b.id);
  assert.match(h.path, /^research\/idea-[a-f0-9]{8}\.repository\.json$/);
  assert.ok(h.question.includes("点子二") && t.repos.has(h.path));

  t.setApprove(false);
  await assert.rejects(t.svc.export(run.id), /你取消了导出/);
  assert.equal(t.written.size, 0);
  t.setApprove(true);
  const relative = await t.svc.export(run.id);
  assert.match(relative, /^research\/ideas-.+-[a-f0-9]{8}\.md$/);
  assert.ok(t.written.get(relative)!.startsWith("# 选题：让小模型少编造"));

  await t.svc.delete(run.id);
  assert.deepEqual(await t.svc.list(), []);
  assert.deepEqual(t.events.at(-1), { type: "removed", id: run.id });
});
