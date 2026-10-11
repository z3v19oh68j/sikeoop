// Run: npm test
// Group chat (src/main/group/service.ts) on the real dispatcher, with a fake model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { GroupService } from "../../src/main/group/service.ts";
import type { DispatchJob, GroupChat, GroupEvent, GroupMember } from "../../src/shared/types.ts";

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await tick();
  assert.ok(cond(), "condition never held");
}

/** A model call the test finishes by hand. */
interface Pending {
  member: GroupMember;
  system: string;
  user: string;
  say(piece: string): void;
  end(whole?: string): void;
  fail(message: string): void;
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sikeoop-group-"));
  const events: GroupEvent[] = [];
  const jobs = new Map<string, DispatchJob>();
  const calls: Pending[] = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  const d = new Dispatcher({ emit: (e) => e.type === "job" && jobs.set(e.job.id, e.job) });
  const svc = new GroupService({
    dir,
    root: () => "/project",
    rag: { current: () => null },
    dispatcher: d,
    emit: (e) => events.push(e),
    call: (member, system, user, onDelta, signal) =>
      new Promise<string>((resolve, reject) => {
        inFlight++;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        let text = "";
        const over = () => inFlight--;
        signal.addEventListener("abort", () => (over(), reject(new Error("aborted"))), { once: true });
        calls.push({
          member, system, user,
          say: (piece) => ((text += piece), onDelta(piece)),
          end: (whole) => (over(), resolve(whole ?? text)),
          fail: (message) => (over(), reject(new Error(message))),
        });
      }),
  });
  const members = (names: string[]) => names.map((name) => ({ providerId: "p", providerName: "P", model: `model-${name}`, name }));
  return {
    d, svc, dir, events, calls, jobs,
    members,
    mostAtOnce: () => mostAtOnce,
    types: (groupId: string) => events.filter((e) => e.groupId === groupId).map((e) => e.type),
    saved: (g: GroupChat): GroupChat => {
      const folder = path.join(dir, readdirSync(dir)[0]);
      return JSON.parse(readFileSync(path.join(folder, `${g.id}.json`), "utf8"));
    },
    done() {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("without an @ everyone speaks, one at a time and in order, each reading the ones before", async () => {
  const t = setup();
  const g = await t.svc.create("评审", t.members(["甲", "乙", "丙"]));
  const sent = t.svc.send(g.id, "这个方案行吗", []);

  await until(() => t.calls.length === 1);
  assert.equal(t.calls[0].member.name, "甲");
  assert.match(t.calls[0].system, /你是「甲」/);
  assert.match(t.calls[0].user, /\[用户\]：这个方案行吗/);
  await tick();
  assert.equal(t.calls.length, 1, "乙 waits for 甲");

  t.calls[0].say("可");
  t.calls[0].say("以");
  t.calls[0].end();
  await until(() => t.calls.length === 2);
  assert.equal(t.calls[1].member.name, "乙");
  assert.match(t.calls[1].user, /\[甲\]：可以/, "乙 reads what 甲 just said");
  t.calls[1].end("我反对");
  await until(() => t.calls.length === 3);
  assert.match(t.calls[2].user, /\[甲\]：可以[\s\S]*\[乙\]：我反对/);
  t.calls[2].end("折中一下");
  await sent;

  assert.equal(t.mostAtOnce(), 1);
  assert.deepEqual(t.types(g.id), ["message", "speaking", "delta", "delta", "message", "speaking", "message", "speaking", "message", "idle"]);
  const speaking = t.events.find((e) => e.type === "speaking");
  const firstReply = t.events.filter((e) => e.type === "message")[1];
  assert.ok(speaking?.type === "speaking" && firstReply.type === "message");
  assert.equal(firstReply.message.id, speaking.messageId, "the streamed message and the final one are the same message");

  // The saved file keeps its shape.
  const file = t.saved(g);
  assert.deepEqual(Object.keys(file).sort(), ["id", "members", "messages", "title", "updatedAt"]);
  assert.deepEqual(file.messages.map((m) => [m.from, m.memberId ? g.members.find((x) => x.id === m.memberId)?.name : undefined, m.text, m.error]), [
    ["user", undefined, "这个方案行吗", undefined],
    ["member", "甲", "可以", undefined],
    ["member", "乙", "我反对", undefined],
    ["member", "丙", "折中一下", undefined],
  ]);
  t.done();
});

test("with an @ only those speak (in member order); their replies are jobs of one tree", async () => {
  const t = setup();
  const g = await t.svc.create("评审", t.members(["甲", "乙", "丙"]));
  const [, yi, bing] = g.members;
  const sent = t.svc.send(g.id, "@丙 @乙 看一下", [bing.id, yi.id]);
  await until(() => t.calls.length === 1);
  assert.equal(t.calls[0].member.name, "乙");
  t.calls[0].end("乙说");
  await until(() => t.calls.length === 2);
  assert.equal(t.calls[1].member.name, "丙");
  t.calls[1].end("丙说");
  await sent;

  const jobs = [...t.jobs.values()];
  assert.equal(jobs.length, 2);
  const root = jobs.find((j) => !j.parentId)!;
  const child = jobs.find((j) => j.parentId)!;
  assert.equal(root.executor.name, "乙");
  assert.deepEqual([child.executor.name, child.parentId, child.rootId], ["丙", root.id, root.id]);
  for (const j of jobs) {
    assert.deepEqual([j.origin, j.from, j.executor.kind, j.status, j.input], ["user", "用户", "model", "done", "@丙 @乙 看一下"]);
    assert.equal(j.scope, undefined, "read-only: no folder to write");
  }
  assert.deepEqual(jobs.map((j) => j.result?.text).sort(), ["丙说", "乙说"].sort());
  assert.equal(t.d.budget(root.id)?.left, 18, "both replies spent the same tree's budget");
  t.done();
});

test("two groups talk at the same time; a second message to a group still talking is turned away", async () => {
  const t = setup();
  const a = await t.svc.create("A 群", t.members(["甲", "乙"]));
  const b = await t.svc.create("B 群", t.members(["丙", "丁"]));
  const sentA = t.svc.send(a.id, "A 的问题", []);
  const sentB = t.svc.send(b.id, "B 的问题", []);
  await until(() => t.calls.length === 2);
  assert.deepEqual(t.calls.map((c) => c.member.name).sort(), ["丙", "甲"].sort(), "one speaker in each group, both at once");
  assert.equal(t.mostAtOnce(), 2);

  await assert.rejects(t.svc.send(a.id, "再问一句", []), /还有人在说话/);
  assert.equal(t.saved(a).messages.length, 1, "the refused message was not added");

  for (let i = 0; i < 4; i++) {
    await until(() => t.calls.length > i);
    t.calls[i].end(`${t.calls[i].member.name}说`);
  }
  await Promise.all([sentA, sentB]);
  assert.equal(t.mostAtOnce(), 2, "never two speakers in one group");
  assert.deepEqual(t.saved(a).messages.map((m) => m.text), ["A 的问题", "甲说", "乙说"]);
  assert.deepEqual(t.saved(b).messages.map((m) => m.text), ["B 的问题", "丙说", "丁说"]);

  // Free again once it is idle.
  const again = t.svc.send(a.id, "再问一句", [a.members[0].id]);
  await until(() => t.calls.length === 5);
  t.calls[4].end("好");
  await again;
  t.done();
});

test("stop cancels the group's tree: the speaker keeps what it said, the rest never speak, other groups go on", async () => {
  const t = setup();
  const a = await t.svc.create("A 群", t.members(["甲", "乙", "丙"]));
  const b = await t.svc.create("B 群", t.members(["丁", "戊"]));
  const sentA = t.svc.send(a.id, "A 的问题", []);
  const sentB = t.svc.send(b.id, "B 的问题", []);
  await until(() => t.calls.length === 2);
  const jia = t.calls.find((c) => c.member.name === "甲")!;
  const ding = t.calls.find((c) => c.member.name === "丁")!;
  jia.say("说到一半");

  t.svc.stop(a.id);
  await sentA;
  assert.deepEqual(t.saved(a).messages.map((m) => [m.text, m.error]), [["A 的问题", undefined], ["说到一半", "已停下"]]);
  assert.equal(t.types(a.id).at(-1), "idle");
  assert.equal(t.calls.length, 2, "乙 and 丙 were never asked");
  const jobsA = [...t.jobs.values()].filter((j) => j.executor.ref.startsWith(`group:${a.id}:`));
  assert.deepEqual(jobsA.map((j) => j.status), ["cancelled", "cancelled", "cancelled"]);

  // The other group didn't notice.
  ding.end("丁说");
  await until(() => t.calls.length === 3);
  t.calls[2].end("戊说");
  await sentB;
  assert.deepEqual(t.saved(b).messages.map((m) => [m.text, m.error]), [["B 的问题", undefined], ["丁说", undefined], ["戊说", undefined]]);
  t.done();
});

test("stop after the first speaker finished still reaches the ones behind; stop with no id stops every group", async () => {
  const t = setup();
  const a = await t.svc.create("A 群", t.members(["甲", "乙", "丙"]));
  const b = await t.svc.create("B 群", t.members(["丁", "戊"]));
  const sentA = t.svc.send(a.id, "A 的问题", []);
  await until(() => t.calls.length === 1);
  t.calls[0].end("甲说");
  await until(() => t.calls.length === 2);
  const sentB = t.svc.send(b.id, "B 的问题", []);
  await until(() => t.calls.length === 3);

  // 甲 (the tree's root) is done; 乙 is speaking; 丙 waits. 乙 said nothing yet.
  t.svc.stop();
  await Promise.all([sentA, sentB]);
  assert.deepEqual(t.saved(a).messages.map((m) => m.text), ["A 的问题", "甲说"], "a stopped speaker with nothing said leaves no message");
  assert.deepEqual(t.saved(b).messages.map((m) => m.text), ["B 的问题"]);
  assert.equal(t.calls.length, 3);
  const unsaved = t.events.filter((e) => e.type === "message" && e.message.error === "已停下");
  assert.equal(unsaved.length, 2, "the window is still told each stopped reply ended");
  assert.deepEqual([...t.jobs.values()].map((j) => j.status).sort(), ["cancelled", "cancelled", "cancelled", "cancelled", "done"]);
  t.done();
});

test("a member whose call fails is recorded with the error, and the next one still speaks", async () => {
  const t = setup();
  const g = await t.svc.create("评审", t.members(["甲", "乙", "丙"]));
  const sent = t.svc.send(g.id, "问题", []);
  await until(() => t.calls.length === 1);
  t.calls[0].say("先说两句 ");
  t.calls[0].fail("429 额度用完了");
  await until(() => t.calls.length === 2);
  t.calls[1].end("");
  await until(() => t.calls.length === 3);
  t.calls[2].end("我来说");
  await sent;
  assert.deepEqual(t.saved(g).messages.slice(1).map((m) => [m.text, m.error]), [
    ["先说两句", "429 额度用完了"],
    ["", "没有返回内容"],
    ["我来说", undefined],
  ]);
  assert.deepEqual([...t.jobs.values()].map((j) => j.status), ["failed", "failed", "done"]);
  t.done();
});

test("an empty message or an unknown group starts nothing", async () => {
  const t = setup();
  const g = await t.svc.create("评审", t.members(["甲", "乙"]));
  await t.svc.send(g.id, "   ", []);
  await assert.rejects(t.svc.send("no-such-group", "在吗", []));
  assert.deepEqual(t.events, []);
  assert.equal(t.jobs.size, 0);
  // Neither left the group marked as busy.
  const sent = t.svc.send(g.id, "在吗", [g.members[0].id]);
  await until(() => t.calls.length === 1);
  t.calls[0].end("在");
  await sent;
  t.done();
});
