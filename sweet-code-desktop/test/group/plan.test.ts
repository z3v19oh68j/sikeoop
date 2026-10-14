// The group's plan channel to the main conversation (src/main/group/plan.ts, and finalize/handoff in service.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { GroupService } from "../../src/main/group/service.ts";
import { batches, handoffText, parsePlan, planMarkdown, planPrompt, type Assignee } from "../../src/main/group/plan.ts";
import type { GroupEvent } from "../../src/shared/types.ts";

const who: Assignee[] = [
  { name: "deepseek/deepseek-chat", note: "群成员「米朵」" },
  { name: "Claude-1", note: "终端里的 Claude Code 会话" },
];
const good = {
  goal: "给设置页加导出按钮", feasible: true, summary: "可行，分两步。",
  tasks: [
    { id: "t1", title: "主进程导出接口", assignee: "claude-1", what: "在 src/main/export.ts 加导出\n并注册 IPC", owns: ["src/main/export.ts"], after: [], accept: "typecheck 通过" },
    { id: "t2", title: "设置页按钮", assignee: "deepseek/deepseek-chat", what: "在设置页加按钮调用接口", owns: ["src/renderer/Settings.tsx"], after: ["t1"], accept: "点了能导出" },
    { id: "t3", title: "查一下现有导出格式", assignee: "Claude-1", what: "只读调查", owns: [], after: [], accept: "" },
  ],
  open: ["导出格式用 JSON 还是 CSV"],
};
const json = (o: unknown) => JSON.stringify(o);

test("parsePlan: takes prose or a code fence around the JSON, and fixes the assignee's spelling to the listed name", () => {
  const plan = parsePlan("好的，方案如下：\n```json\n" + json(good) + "\n```\n以上。", who, "米朵", 1000);
  assert.equal(plan.by, "米朵");
  assert.equal(plan.at, 1000);
  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.tasks.map((t) => [t.id, t.assignee, t.after]), [["t1", "Claude-1", []], ["t2", "deepseek/deepseek-chat", ["t1"]], ["t3", "Claude-1", []]]);
  assert.deepEqual(plan.open, ["导出格式用 JSON 还是 CSV"]);
});

test("parsePlan: refuses what can't be handed out, in words for the user", () => {
  const bad = (change: (o: typeof good) => unknown) => {
    const copy = JSON.parse(json(good)) as typeof good;
    const out = change(copy) ?? copy;
    return () => parsePlan(json(out), who, "米朵");
  };
  assert.throws(() => parsePlan("我觉得可以做。", who, "米朵"), /没有 JSON/);
  assert.throws(() => parsePlan("{oops}", who, "米朵"), /格式不对/);
  assert.throws(bad((o) => { o.tasks[1].assignee = "gpt/unknown"; }), /「gpt\/unknown」.*接不了活.*deepseek\/deepseek-chat、Claude-1/);
  assert.throws(bad((o) => { o.tasks[1].assignee = ""; }), /（没写）/);
  assert.throws(bad((o) => { o.tasks[1].owns = ["src/main/export.ts"]; }), /都要改 src\/main\/export\.ts/);
  assert.throws(bad((o) => { o.tasks[1].id = "t1"; }), /重复/);
  assert.throws(bad((o) => { o.tasks[0].what = ""; }), /没写清楚/);
  assert.throws(bad((o) => { o.tasks[1].after = ["t9"]; }), /没有这个任务/);
  assert.throws(bad((o) => { o.tasks[0].after = ["t2"]; }), /互相等待/);
  assert.throws(bad((o) => { o.goal = ""; }), /没写目标/);
  assert.throws(bad((o) => { o.tasks = []; }), /没有分出任务/);
  assert.throws(bad((o) => { o.tasks = Array.from({ length: 13 }, (_, i) => ({ ...o.tasks[2], id: `x${i}` })); }), /最多 12 个/);
  assert.throws(() => parsePlan(json(good), [], "米朵"), /接不了活.*没有/);
});

test("a plan that says the idea doesn't work carries the reason and no tasks, and can't be handed out", () => {
  const plan = parsePlan(json({ ...good, feasible: false, summary: "现有接口不支持，做不了。" }), who, "米朵");
  assert.equal(plan.feasible, false);
  assert.deepEqual(plan.tasks, []);
  assert.match(planMarkdown(plan), /结论：不可行.*\n\n现有接口不支持/s);
  assert.throws(() => handoffText("导出", plan), /做不了/);
});

test("the work order names who does what, in batches, and tells the main conversation not to plan again", () => {
  const plan = parsePlan(json(good), who, "米朵");
  assert.deepEqual(batches(plan).map((b) => b.map((t) => t.id)), [["t1", "t3"], ["t2"]]);
  const text = handoffText("导出功能", plan);
  assert.match(text, /群聊「导出功能」.*由 米朵 整理/);
  assert.match(text, /不要重新规划/);
  assert.match(text, /不要换人、不要合并或拆分任务、不要增减任务、不要自己动手做/);
  assert.match(text, /不要找别人顶替/);
  assert.ok(text.indexOf("## 第 1 批") < text.indexOf("任务 t1") && text.indexOf("任务 t3") < text.indexOf("## 第 2 批") && text.indexOf("## 第 2 批") < text.indexOf("任务 t2"));
  assert.match(text, /任务 t1「主进程导出接口」\n  - 交给：Claude-1\n  - 做什么：在 src\/main\/export\.ts 加导出 并注册 IPC\n  - owns：src\/main\/export\.ts\n  - 验收：typecheck 通过/);
  assert.match(text, /任务 t3.*\n  - 交给：Claude-1\n.*\n  - owns：（只读，不改文件）/);
  assert.match(text, /还没说定的问题\n- 导出格式用 JSON 还是 CSV\n这些要先用提问工具问我/);
  assert.doesNotMatch(handoffText("导出功能", { ...plan, open: [] }), /还没说定/);
  assert.match(planMarkdown(plan), /2\. \*\*设置页按钮\*\* → deepseek\/deepseek-chat（等 t1）/);
});

test("planPrompt lists who can take work and carries the discussion", () => {
  const { system, user } = planPrompt("[用户]：加个导出", who);
  assert.match(system, /只整理群里已经说定的内容/);
  assert.match(user, /- Claude-1（终端里的 Claude Code 会话）/);
  assert.match(user, /# 群聊记录\n\[用户\]：加个导出/);
});

function setup(reply: () => string, assignees: () => Assignee[] = () => who) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sikeoop-group-plan-"));
  const events: GroupEvent[] = [];
  const prompts: { member: string; system: string; user: string }[] = [];
  const d = new Dispatcher({ emit: () => {} });
  const svc = new GroupService({
    dir, root: () => "/project", rag: { current: () => null }, dispatcher: d, emit: (e) => events.push(e), assignees,
    call: async (member, system, user) => { prompts.push({ member: member.name, system, user }); return reply(); },
  });
  const members = ["米朵", "阿洛"].map((name) => ({ providerId: "p", providerName: "P", model: `m-${name}`, name }));
  return { svc, events, prompts, members, done: () => { d.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("finalize: a member writes the plan up, it is kept with the group and shown in the chat; handoff gives the work order", async () => {
  let answer = "我同意。";
  const s = setup(() => answer);
  try {
    const g = await s.svc.create("导出功能", s.members);
    await assert.rejects(s.svc.finalize(g.id), /还没有讨论/);
    await assert.rejects(s.svc.handoff(g.id), /还没有整理出分工方案/);
    await s.svc.send(g.id, "加个导出按钮，怎么分工？", []);

    answer = json(good);
    const second = g.members[1];
    const plan = await s.svc.finalize(g.id, second.id);
    assert.equal(plan.by, "阿洛");
    assert.equal(s.prompts.at(-1)!.member, "阿洛");
    assert.match(s.prompts.at(-1)!.user, /加个导出按钮/);
    const saved = await s.svc.load(g.id);
    assert.deepEqual(saved.plan, plan);
    assert.equal(saved.messages.at(-1)!.memberId, second.id);
    assert.match(saved.messages.at(-1)!.text, /分工方案.*给设置页加导出按钮/);
    assert.deepEqual(s.events.slice(-3).map((e) => e.type), ["message", "plan", "idle"]);

    const { text } = await s.svc.handoff(g.id);
    assert.match(text, /群聊「导出功能」/);
    assert.match(text, /交给：Claude-1/);

    // The discussion moved on: the plan is stale until it is written up again.
    answer = "等等，我觉得不该用 JSON。";
    await s.svc.send(g.id, "再想想格式", []);
    await assert.rejects(s.svc.handoff(g.id), /又聊了新内容/);
  } finally { s.done(); }
});

test("finalize keeps the old plan when the write-up is refused; handoff refuses when an assignee has gone", async () => {
  let answer = "先聊聊。";
  let online = who;
  const s = setup(() => answer, () => online);
  try {
    const g = await s.svc.create("导出功能", s.members);
    await s.svc.send(g.id, "怎么分工？", []);
    answer = json(good);
    const plan = await s.svc.finalize(g.id);
    assert.equal(plan.by, "米朵");

    answer = json({ ...good, tasks: [{ ...good.tasks[0], assignee: "nobody" }] });
    await assert.rejects(s.svc.finalize(g.id), /接不了活/);
    assert.deepEqual((await s.svc.load(g.id)).plan, plan);
    assert.equal(s.events.at(-1)!.type, "idle");

    online = [who[0]];
    await assert.rejects(s.svc.handoff(g.id), /分给了 Claude-1，它现在接不了活/);
    online = [];
    await assert.rejects(s.svc.finalize(g.id), /现在没有人可以接活/);
  } finally { s.done(); }
});
