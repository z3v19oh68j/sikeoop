// Run: npm test
// The regression panel (src/main/regress/service.ts) on the real dispatcher and store, with fake sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Dispatcher, type Executor } from "../../src/main/dispatch/scheduler.ts";
import { RegressService } from "../../src/main/regress/service.ts";
import { RegressStore } from "../../src/main/regress/store.ts";
import type { AgentSessionView, DispatchJob, RegressRun, RegressView } from "../../src/shared/types.ts";

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await tick();
  }
  assert.fail("condition never held");
}

/** A terminal session the test drives: it finishes a job when the test says so. */
class FakeSession implements Executor {
  readonly kind = "cli" as const;
  readonly ref: string;
  readonly name: string;
  status: AgentSessionView["status"] = "idle";
  gone = false;
  asked: DispatchJob[] = [];
  private finishers: ((text: string | null) => void)[] = [];
  constructor(ref: string, name: string) {
    this.ref = ref;
    this.name = name;
  }
  ready() {
    return this.status === "idle";
  }
  alive() {
    return !this.gone;
  }
  run(job: DispatchJob, signal: AbortSignal) {
    this.asked.push(job);
    return new Promise<{ text: string } | null>((resolve) => {
      const finish = (t: string | null) => resolve(t === null ? null : { text: t });
      // Stopped waiting: this turn is no longer the one the next answer belongs to.
      signal.addEventListener("abort", () => ((this.finishers = this.finishers.filter((f) => f !== finish)), resolve(null)), { once: true });
      this.finishers.push(finish);
    });
  }
  answer(text: string | null) {
    this.finishers.shift()!(text);
  }
}

function setup(opts: { queueTimeoutMs?: number } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-regress-")));
  const project = path.join(base, "project");
  mkdirSync(project);
  let root: string | null = project;
  const sessions = new Map<string, { view: AgentSessionView; exec: FakeSession }>();
  const pushed: RegressView[] = [];
  const d: Dispatcher = new Dispatcher({ emit: (e) => e.type === "job" && svc.jobChanged(e.job), ...opts });
  const store = new RegressStore();
  const svc: RegressService = new RegressService({
    root: () => root,
    store,
    dispatcher: d,
    findSession: (name) => {
      const s = sessions.get(name);
      return s ? { ...s.view, status: s.exec.status } : null;
    },
    executorFor: (s) => sessions.get(s.name)!.exec,
    changed: (v) => pushed.push(v),
  });
  const session = (name: string, cli: string) => {
    const exec = new FakeSession(`id-${name}`, name);
    sessions.set(name, { view: { id: exec.ref, name, cli, status: "idle", detail: "", since: 0 }, exec });
    return exec;
  };
  return {
    d, svc, store, base, project, pushed, session,
    setRoot: (r: string | null) => (root = r),
    file: (name: string) => path.join(project, ".sikeoop", "regress", name),
    async items(...titles: string[]) {
      const v = await svc.addItems(titles.map((title) => ({ title, detail: `怎么验证${title}`, owner: "both", criteria: `${title}成立` })));
      assert.ok(!("error" in v));
      return v.items;
    },
    async latest(itemId: string, cli: "claude" | "codex"): Promise<RegressRun | undefined> {
      return (await svc.view()).latest[itemId]?.[cli];
    },
    done() {
      d.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("a check is a job: queued, then running, then done with the verdict read from the reply", async () => {
  const t = setup();
  const claude = t.session("Claude-1", "claude");
  const [a, b] = await t.items("能登录", "能退出");

  const started = await t.svc.run([a.id, b.id], "Claude-1");
  assert.ok("runIds" in started && started.runIds.length === 2);
  await until(() => claude.asked.length === 1);
  const job = claude.asked[0];
  assert.deepEqual([job.origin, job.from, job.limits.timeoutMs, job.scope], ["user", "回归面板", 300_000, undefined]);
  assert.match(job.input, /标题：能登录\n说明：怎么验证能登录\n通过标准：能登录成立/);

  let view = await t.svc.view();
  assert.equal(view.latest[a.id].claude?.status, "running");
  assert.equal(view.latest[b.id].claude?.status, "queued", "the session takes one check at a time");
  assert.deepEqual(view.busy, { sessions: ["Claude-1"], runs: started.runIds });

  claude.answer("看了登录的代码。\n\nRESULT: PASS — 账号密码正确时进入首页");
  await until(() => claude.asked.length === 2);
  claude.answer("RESULT: FAIL — 退出后 token 没清");
  await until(async () => (await t.svc.view()).busy.runs.length === 0);

  view = await t.svc.view();
  const first = view.latest[a.id].claude!;
  assert.deepEqual([first.status, first.auto, first.verdict, first.overridden, first.reason], ["done", "pass", "pass", false, "账号密码正确时进入首页"]);
  assert.ok(first.endedAt && first.excerpt.includes("RESULT: PASS"));
  assert.deepEqual([view.latest[b.id].claude?.verdict, view.latest[b.id].claude?.reason], ["fail", "退出后 token 没清"]);
  assert.deepEqual(view.busy, { sessions: [], runs: [] });
  assert.equal(await t.svc.reply(first.id), "看了登录的代码。\n\nRESULT: PASS — 账号密码正确时进入首页");

  // On disk: append only, the last line of an id is the run.
  const lines = readFileSync(t.file("runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as RegressRun);
  assert.deepEqual(lines.filter((l) => l.id === first.id).map((l) => l.status), ["running", "done"]);
  assert.deepEqual(lines.filter((l) => l.id === started.runIds[1]).map((l) => l.status), ["queued", "running", "done"]);
  assert.ok(t.pushed.length >= 4, "every change is pushed to the window");
  assert.equal(t.pushed.at(-1)?.busy.runs.length, 0);
  t.done();
});

test("a busy session gets the check queued by the dispatcher, not refused and not typed into", async () => {
  const t = setup();
  const codex = t.session("Codex-1", "codex");
  codex.status = "working"; // the user's own turn
  const [a] = await t.items("能登录");
  const started = await t.svc.run([a.id], "Codex-1");
  assert.ok("runIds" in started);
  await tick();
  assert.equal(codex.asked.length, 0);
  assert.equal((await t.latest(a.id, "codex"))?.status, "queued");

  codex.status = "idle";
  t.d.pump();
  await until(() => codex.asked.length === 1);
  assert.equal((await t.latest(a.id, "codex"))?.status, "running");
  codex.answer("RESULT: PASS — ok");
  await until(async () => (await t.latest(a.id, "codex"))?.status === "done");

  // Two sessions work side by side.
  const claude = t.session("Claude-1", "claude");
  await t.svc.run([a.id], "Codex-1");
  await t.svc.run([a.id], "Claude-1");
  await until(() => codex.asked.length === 2 && claude.asked.length === 1);
  claude.answer("RESULT: FAIL — 不行");
  codex.answer("RESULT: PASS — 行");
  await until(async () => (await t.svc.view()).busy.runs.length === 0);
  assert.deepEqual((await t.svc.view()).conflicts, [a.id], "Claude and Codex disagree");
  t.done();
});

test("how a job ends is how the run ends: cancelled, error, gone, and a reply with no RESULT line", async () => {
  const t = setup();
  const claude = t.session("Claude-1", "claude");
  const [a] = await t.items("能登录");
  const one = async () => {
    // Counted first: a free session is handed the check before run() returns.
    const n = claude.asked.length;
    const r = await t.svc.run([a.id], "Claude-1");
    assert.ok("runIds" in r);
    await until(() => claude.asked.length === n + 1);
    return r.runIds[0];
  };
  const ended = async (status: RegressRun["status"]) => {
    await until(async () => (await t.svc.view()).busy.runs.length === 0);
    const run = (await t.latest(a.id, "claude"))!;
    assert.equal(run.status, status);
    assert.ok(run.endedAt);
    return run;
  };

  await t.svc.setSettings({ runTimeoutSec: 30 });
  await one();
  assert.equal(claude.asked.at(-1)?.limits.timeoutMs, 30_000, "the limit is the setting at the time it is handed out");
  // Cancelled from the dispatch console rather than from the panel: the run follows its job all the same.
  t.d.cancel(claude.asked.at(-1)!.id);
  assert.equal((await ended("cancelled")).verdict, "pending");

  const id = await one();
  await t.svc.cancel(id);
  await ended("cancelled");

  await one();
  claude.answer(null); // the turn ended without a reply
  assert.match((await ended("error")).error ?? "", /没有拿到结果/);

  await one();
  claude.answer("我看了一圈，说不好。");
  const undecided = await ended("done");
  assert.deepEqual([undecided.auto, undecided.verdict], ["pending", "pending"]);

  await one();
  claude.gone = true;
  claude.answer(null); // the tab was closed
  await ended("gone");
  t.done();
});

test("a check that waits too long for its session times out", async () => {
  const t = setup({ queueTimeoutMs: 20 });
  const claude = t.session("Claude-1", "claude");
  claude.status = "waiting";
  const [a] = await t.items("能登录");
  await t.svc.run([a.id], "Claude-1");
  await new Promise((r) => setTimeout(r, 40));
  t.d.pump();
  await until(async () => (await t.latest(a.id, "claude"))?.status === "timeout");
  assert.equal(claude.asked.length, 0);
  t.done();
});

test("cancel with no id stops every queued and running check; the session is not interrupted", async () => {
  const t = setup();
  const claude = t.session("Claude-1", "claude");
  const [a, b, c] = await t.items("一", "二", "三");
  const r = await t.svc.run([a.id, b.id, c.id], "Claude-1");
  assert.ok("runIds" in r);
  await until(() => claude.asked.length === 1);
  await t.svc.cancel();
  await until(async () => (await t.svc.view()).busy.runs.length === 0);
  const view = await t.svc.view();
  assert.deepEqual([a, b, c].map((i) => view.latest[i.id].claude?.status), ["cancelled", "cancelled", "cancelled"]);
  assert.equal(claude.asked.length, 1, "the two behind it were never typed in");
  t.done();
});

test("generate waits for the reply, one at a time per project, and returns what the reply lists", async () => {
  const t = setup();
  const claude = t.session("Claude-1", "claude");
  await t.items("已有的");
  const first = t.svc.generate("Claude-1", "登录");
  await until(() => claude.asked.length === 1);
  assert.match(claude.asked[0].input, /重点：登录.*最多 30 条/s);
  assert.equal(claude.asked[0].limits.timeoutMs, 600_000);
  const busy = (await t.svc.view()).busy;
  assert.equal(busy.generate?.session, "Claude-1");
  assert.deepEqual(busy.sessions, ["Claude-1"]);
  assert.deepEqual(await t.svc.generate("Claude-1"), { error: "已经有一个生成任务在跑" });

  claude.answer(`读完了。\n<<<REGRESS_ITEMS\n${JSON.stringify([
    { title: "能登录", detail: "输入账号密码", owner: "frontend", criteria: "进入首页" },
    { title: "已有的", detail: "", owner: "both", criteria: "" },
  ])}\nREGRESS_ITEMS>>>`);
  const got = await first;
  assert.ok("candidates" in got);
  assert.deepEqual(got.candidates, [{ title: "能登录", detail: "输入账号密码", owner: "frontend", criteria: "进入首页" }]);
  assert.equal((await t.svc.view()).busy.generate, undefined);

  const second = t.svc.generate("Claude-1");
  await until(() => claude.asked.length === 2);
  claude.answer("我没看出什么要测的。");
  const none = await second;
  assert.ok("error" in none && none.error === "未找到条目块" && none.rawExcerpt === "我没看出什么要测的。");

  const third = t.svc.generate("Claude-1");
  await until(() => claude.asked.length === 3);
  claude.gone = true;
  claude.answer(null);
  assert.deepEqual(await third, { error: "会话已关闭" });
  t.done();
});

test("what is refused, and that nothing throws", async () => {
  const t = setup();
  t.session("Claude-1", "claude").status = "starting";
  t.session("OpenCode-1", "opencode");
  const idle = t.session("Codex-1", "codex");
  const [a] = await t.items("能登录");
  await t.svc.setSettings({ maxPerBatch: 1 });

  assert.deepEqual(await t.svc.run([a.id], "没有这个会话"), { error: "找不到这个会话" });
  assert.deepEqual(await t.svc.run([a.id], "Claude-1"), { error: "这个会话还在启动" });
  assert.deepEqual(await t.svc.run([a.id], "OpenCode-1"), { error: "回归面板只能用 Claude Code 或 Codex 会话" });
  assert.deepEqual(await t.svc.run([a.id, a.id], "Codex-1"), { error: "一次最多执行 1 条" });
  assert.deepEqual(await t.svc.run(["../../etc/passwd"], "Codex-1"), { error: "条目无效" });
  assert.deepEqual(await t.svc.run("不是数组", "Codex-1"), { error: "条目无效" });
  assert.deepEqual(await t.svc.run(["00000000-0000-0000-0000-000000000000"], "Codex-1"), { error: "找不到要运行的条目" });
  assert.deepEqual(await t.svc.generate(null), { error: "找不到这个会话" });
  assert.deepEqual(await t.svc.reply("../items"), { error: "没有找到这次运行的原文" });
  assert.deepEqual(await t.svc.override("nope-nope", "pass"), { error: "找不到这条运行记录" });
  assert.deepEqual(await t.svc.diff("nope-nope"), { error: "找不到这个基线" });
  assert.deepEqual(await t.svc.updateItem(a.id, { title: "  " }), { error: "标题不能为空，各项都必须是文字" });
  assert.deepEqual(await t.svc.addItems("不是数组"), { error: "一次最多加入 200 条" });
  assert.equal(idle.asked.length, 0);

  t.setRoot(null);
  assert.deepEqual(await t.svc.run([a.id], "Codex-1"), { error: "未打开项目" });
  assert.deepEqual(await t.svc.addItems([]), { error: "未打开项目" });
  assert.deepEqual(await t.svc.view(), { root: null, items: [], latest: {}, conflicts: [], baselines: [], busy: { sessions: [], runs: [] }, settings: { runTimeoutSec: 300, generateTimeoutSec: 600, maxPerBatch: 50, maxCandidates: 30 } });
  t.done();
});

test("items, overrides, baselines and settings are kept in the project's .sikeoop/regress", async () => {
  const t = setup();
  const claude = t.session("Claude-1", "claude");
  const [a, b] = await t.items("能登录", "能退出", "能登录");
  assert.equal((await t.svc.view()).items.length, 2, "a repeated title is added once");
  assert.match(a.id, /^[a-z0-9-]{8,40}$/);

  const renamed = await t.svc.updateItem(b.id, { title: "能安全退出", owner: "backend" });
  assert.ok(!("error" in renamed));
  assert.deepEqual(renamed.items.map((i) => [i.title, i.owner, i.detail]), [["能登录", "both", "怎么验证能登录"], ["能安全退出", "backend", "怎么验证能退出"]]);
  assert.deepEqual((await t.svc.updateItem(b.id, { title: "能登录" })), { error: "已经有一条同名的了" });
  assert.deepEqual(JSON.parse(readFileSync(t.file("items.json"), "utf8")).map((i: { title: string }) => i.title), ["能登录", "能安全退出"]);

  await t.svc.run([a.id, b.id], "Claude-1");
  await until(() => claude.asked.length === 1);
  claude.answer("RESULT: PASS — ok");
  await until(() => claude.asked.length === 2);
  claude.answer("RESULT: FAIL — 不行");
  await until(async () => (await t.svc.view()).busy.runs.length === 0);

  const snap = await t.svc.snapshot("  发版前  ");
  assert.ok(!("error" in snap));
  assert.deepEqual(snap.baselines.map((x) => x.name), ["发版前"]);
  const baselineId = snap.baselines[0].id;
  const stored = JSON.parse(readFileSync(t.file(`baselines/${baselineId}.json`), "utf8"));
  assert.deepEqual(Object.values(stored.results).map((r: any) => r.claude.verdict).sort(), ["fail", "pass"]);

  // The user overrules the failed one: a new line for the same run.
  const failedRun = (await t.latest(b.id, "claude"))!;
  const overruled = await t.svc.override(failedRun.id, "pass");
  assert.ok(!("error" in overruled));
  const now = overruled.latest[b.id].claude!;
  assert.deepEqual([now.id, now.auto, now.verdict, now.overridden], [failedRun.id, "fail", "pass", true]);
  const rows = await t.svc.diff(baselineId);
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((r) => [r.itemId === a.id ? "a" : "b", r.cli, r.kind]).sort(), [["a", "claude", "same"], ["b", "claude", "fixed"]]);

  // Deleting an item keeps its runs in the log.
  const afterDelete = await t.svc.deleteItem(a.id);
  assert.ok(!("error" in afterDelete) && afterDelete.items.length === 1 && afterDelete.latest[a.id] === undefined);
  assert.ok(readFileSync(t.file("runs.jsonl"), "utf8").includes(a.id));

  const settings = await t.svc.setSettings({ runTimeoutSec: 5, maxCandidates: 12 });
  assert.ok(!("error" in settings));
  assert.deepEqual(settings.settings, { runTimeoutSec: 30, generateTimeoutSec: 600, maxPerBatch: 50, maxCandidates: 12 });
  assert.deepEqual(JSON.parse(readFileSync(t.file("settings.json"), "utf8")), settings.settings);

  const gone = await t.svc.deleteBaseline(baselineId);
  assert.ok(!("error" in gone) && gone.baselines.length === 0);
  assert.ok(!existsSync(t.file(`baselines/${baselineId}.json`)));
  t.done();
});

test("a run that was still going when sikeoop closed is shown as gone", async () => {
  const t = setup();
  const [a] = await t.items("能登录");
  const stale: RegressRun = { id: "11111111-aaaa", itemId: a.id, session: "Claude-1", cli: "claude", startedAt: 5, endedAt: null, status: "running", auto: "pending", verdict: "pending", overridden: false, reason: "", excerpt: "" };
  await t.store.appendRun(t.project, stale);
  writeFileSync(t.file("runs.jsonl"), readFileSync(t.file("runs.jsonl"), "utf8") + '{"id":"torn', "utf8");
  const view = await t.svc.view();
  assert.deepEqual([view.latest[a.id].claude?.status, view.latest[a.id].claude?.endedAt], ["gone", 5]);
  assert.deepEqual(view.busy.runs, []);
  t.done();
});

test("a symlink in the way of .sikeoop/regress is never followed", async () => {
  const t = setup();
  const elsewhere = path.join(t.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(t.project, ".sikeoop"));
  const added = await t.svc.addItems([{ title: "能登录", detail: "", owner: "both", criteria: "" }]);
  assert.ok("error" in added && /符号链接/.test(added.error));
  assert.deepEqual((await t.svc.view()).items, []);
  assert.ok(!existsSync(path.join(elsewhere, "regress")), "nothing was written through the link");
  t.done();
});
