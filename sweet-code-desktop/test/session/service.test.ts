// Run: npm test
// Cross-project sessions (src/main/session/service.ts) on the real dispatcher and store, with a
// fake PeerBus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { SessionService, memberExitCode } from "../../src/main/session/service.ts";
import { SessionStore } from "../../src/main/session/store.ts";
import type { AgentCli, AgentSessionView, CrossSession, DispatchOrigin, TimelineEvent } from "../../src/shared/types.ts";

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), "condition never held");
}

function setup(budget?: Partial<Record<DispatchOrigin, number>>) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-session-")));
  const roots = ["a", "b", "outside"].map((n) => {
    mkdirSync(path.join(base, n));
    return path.join(base, n);
  });
  const views = new Map<string, AgentSessionView>();
  const turns = new Map<string, (text: string | null) => void>();
  const typed: { id: string; text: string }[] = [];
  const closed: string[] = [];
  const notices: { tab: string; code: number | null }[] = [];
  const events: { id: string; e: TimelineEvent }[] = [];
  const changes: CrossSession[] = [];
  const tabs = new Map<string, string>();
  const groups = new Map<string, string>();
  const counts: Record<AgentCli, number> = { claude: 0, codex: 0 };
  let confirm = true;

  const d = new Dispatcher({ emit: () => svc.sync(), budget });
  const store = new SessionStore(path.join(base, "sessions"));
  const svc: SessionService = new SessionService({
    store,
    dispatcher: d,
    bus: {
      viewOf: (id) => views.get(id) ?? null,
      deliver: (id, text) => {
        const v = views.get(id);
        if (!v) return false;
        typed.push({ id, text });
        v.status = "working";
        return true;
      },
      waitTurn: (id, _ms, signal) =>
        new Promise((resolve) => {
          turns.set(id, resolve);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
    },
    launch: async ({ tab, cli, group }) => {
      const peerId = `p${views.size + 1}`;
      const name = `${cli === "codex" ? "Codex" : "Claude"}-${++counts[cli]}`;
      views.set(peerId, { id: peerId, name, cli, status: "idle", detail: "", since: 0 });
      tabs.set(tab, peerId);
      groups.set(peerId, group);
      return { peerId, name };
    },
    closeTab: (tab, why) => {
      closed.push(tab);
      notices.push({ tab, code: memberExitCode(tab, why) });
      const peerId = tabs.get(tab);
      if (peerId && views.delete(peerId)) void svc.onPeerEvent({ group: groups.get(peerId)!, peerId, tab, kind: "exit" });
    },
    allowedRoot: (dir) => dir !== roots[2],
    confirmAddRoot: async () => confirm,
    showTerminal: () => {},
    onEvent: (id, e) => events.push({ id, e }),
    onChanged: (meta) => changes.push(meta),
  });

  return {
    d, svc, store, base, roots, typed, closed, notices, events, views,
    setConfirm: (v: boolean) => (confirm = v),
    kinds: () => events.map((x) => x.e.kind),
    /** What PeerBus does on a Stop hook: timeline first, then the turn's waiters, then idle. */
    async endTurn(peerId: string, text: string) {
      await svc.onPeerEvent({ group: groups.get(peerId)!, peerId, tab: "", kind: "stop", text });
      views.get(peerId)!.status = "idle";
      turns.get(peerId)?.(text);
      turns.delete(peerId);
      await tick();
      d.pump();
      svc.sync();
    },
    hook: (peerId: string, input: Record<string, unknown>) => svc.onPeerEvent({ group: groups.get(peerId)!, peerId, tab: "", kind: "preToolUse", input }),
    sendTo: (from: string, to: string, text: string) => svc.onPeerEvent({ group: groups.get(from)!, peerId: from, tab: "", kind: "send", to, text }),
    done() {
      d.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

async function sessionWith(t: ReturnType<typeof setup>, clis: AgentCli[]) {
  const created = await t.svc.create({ title: "联调", roots: t.roots.slice(0, 2) });
  assert.ok(created.ok, created.ok ? "" : created.message);
  const agents = [];
  for (const cli of clis) {
    const r = await t.svc.addAgent(created.data.id, cli);
    assert.ok(r.ok, r.ok ? "" : r.message);
    agents.push(r.data);
  }
  return { id: created.data.id, agents };
}
const statuses = (t: ReturnType<typeof setup>, id: string) => t.store.meta(id).agents.map((a) => a.status);

test("create checks its folders; a member's tab is s:<session>:<agent>", async () => {
  const t = setup();
  assert.equal((await t.svc.create({ title: "x", roots: [t.roots[0]] })).ok, false, "one folder is not enough");
  assert.equal((await t.svc.create({ title: "x", roots: [t.roots[0], t.roots[0]] })).ok, false, "the same folder twice is one");
  assert.equal((await t.svc.create({ title: "x", roots: [t.roots[0], t.roots[2]] })).ok, false, "a folder never opened in sikeoop");
  assert.equal((await t.svc.create({ title: "", roots: t.roots.slice(0, 2) })).ok, false);
  assert.equal((await t.svc.create(null)).ok, false, "IPC arguments are unchecked");

  const s = await sessionWith(t, ["claude"]);
  assert.equal(s.agents[0].tab, `s:${s.id}:${s.agents[0].id}`);
  assert.equal(s.agents[0].name, "Claude-1");
  assert.deepEqual(t.kinds(), ["agentJoined"]);
  t.done();
});

test("an @ to two members: one speaks, the other waits in the queue", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude", "codex"]);
  const [a, b] = s.agents;

  const r = await t.svc.send(s.id, "@Claude-1 @Codex-1 对一下接口", [a.id, b.id]);
  assert.ok(r.ok);
  await until(() => t.typed.length === 1);
  assert.equal(t.typed[0].id, "p1");
  assert.match(t.typed[0].text, /^\[用户 → 你\] @Claude-1 @Codex-1 对一下接口/);
  assert.deepEqual(statuses(t, s.id), ["busy", "queued"]);
  assert.equal(t.d.current("p1")?.origin, "session");
  assert.deepEqual(t.d.current("p1")?.scope?.roots, t.roots.slice(0, 2));

  await t.endTurn("p1", "接口没问题");
  await until(() => t.typed.length === 2);
  assert.equal(t.typed[1].id, "p2", "the second member starts only after the first one's turn");
  assert.deepEqual(statuses(t, s.id), ["idle", "busy"]);
  await t.endTurn("p2", "我这边也好了");
  await until(() => statuses(t, s.id).every((x) => x === "idle"));

  const timeline = t.store.events(s.id, undefined, 200).slice(2);
  assert.deepEqual(timeline.map((e) => [e.kind, e.from, e.text]), [
    ["user", "user", "@Claude-1 @Codex-1 对一下接口"],
    ["agent", "Claude-1", "接口没问题"],
    ["agent", "Codex-1", "我这边也好了"],
  ]);
  assert.deepEqual(timeline[0].to, ["Claude-1", "Codex-1"]);
  t.done();
});

test("without an @ the message is only recorded", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude"]);
  assert.ok((await t.svc.send(s.id, "先记一下", [])).ok);
  await tick();
  assert.equal(t.typed.length, 0);
  assert.equal(t.store.events(s.id, undefined, 200).at(-1)?.kind, "user");
  assert.equal((await t.svc.send(s.id, "@谁", ["nobody"])).ok, false);
  t.done();
});

test("a member's send_to is a child job; when the tree's budget is spent a hopLimit event stops it", async () => {
  const t = setup({ session: 2 });
  const s = await sessionWith(t, ["claude", "codex"]);
  const [a] = s.agents;

  await t.svc.send(s.id, "@Claude-1 开始", [a.id]);
  await until(() => t.typed.length === 1);
  const root = t.d.current("p1")!;

  assert.equal(await t.sendTo("p1", "p2", "帮我看 b/api.ts"), undefined);
  const child = t.d.jobs().find((j) => j.executor.ref === "p2")!;
  assert.equal(child.parentId, root.id);
  assert.equal(child.status, "queued", "Codex waits while Claude is still speaking");
  assert.deepEqual(statuses(t, s.id), ["busy", "queued"]);

  const refused = await t.sendTo("p1", "p2", "再看一个");
  assert.match(String(refused), /等用户确认/);
  const last = t.store.events(s.id, undefined, 200).at(-1)!;
  assert.equal(last.kind, "hopLimit");
  assert.equal(last.from, "Claude-1");

  await t.endTurn("p1", "交给 Codex 了");
  await until(() => t.typed.length === 2);
  assert.match(t.typed[1].text, /^\[Claude-1 → 你\] 帮我看 b\/api\.ts/);
  await t.endTurn("p2", "看完了");

  // The user speaking again starts a new tree with a full budget.
  await t.svc.send(s.id, "@Codex-1 继续", [s.agents[1].id]);
  await until(() => t.typed.length === 3);
  const next = t.d.current("p2")!;
  assert.notEqual(next.rootId, root.id);
  assert.equal(t.d.budget(next.rootId)?.left, 1);
  await t.endTurn("p2", "好");
  t.done();
});

test("tool calls outside the session's folders are refused and put on the timeline", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude"]);

  assert.equal(await t.hook("p1", { tool_name: "Edit", tool_input: { file_path: path.join(t.roots[1], "src/new.ts") }, cwd: t.roots[0] }), undefined);
  assert.equal(await t.hook("p1", { tool_name: "Read", tool_input: { file_path: "pkg/index.ts" }, cwd: t.roots[0] }), undefined, "relative to cwd");

  const outside = path.join(t.roots[2], "secret.ts");
  assert.match(String(await t.hook("p1", { tool_name: "Write", tool_input: { file_path: outside }, cwd: t.roots[0] })), /不在这个 session 的目录里/);
  let last = t.store.events(s.id, undefined, 200).at(-1)!;
  assert.deepEqual([last.kind, last.from, last.path, last.dir], ["outOfScope", "Claude-1", outside, t.roots[2]]);

  assert.match(String(await t.hook("p1", { tool_name: "Read", tool_input: { file_path: "../outside/secret.ts" }, cwd: t.roots[0] })), /拒绝执行/);
  assert.match(String(await t.hook("p1", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: t.roots[0] })), /shell/);

  assert.equal(await t.hook("p1", { tool_name: "Edit", tool_input: { file_path: path.join(t.roots[0], "x.ts") }, lockDenied: path.join(t.roots[0], "x.ts") }), undefined);
  last = t.store.events(s.id, undefined, 200).at(-1)!;
  assert.deepEqual([last.kind, last.from, last.path], ["lockDenied", "Claude-1", path.join(t.roots[0], "x.ts")]);

  // A folder the user adds (after the native confirmation) is in scope from then on.
  t.setConfirm(false);
  assert.equal((await t.svc.addRoot(s.id, t.roots[2])).ok, false);
  t.setConfirm(true);
  assert.ok((await t.svc.addRoot(s.id, t.roots[2])).ok);
  assert.equal(await t.hook("p1", { tool_name: "Write", tool_input: { file_path: outside }, cwd: t.roots[0] }), undefined);

  assert.match(String(await t.svc.onPeerEvent({ group: s.id, peerId: "stranger", tab: "", kind: "preToolUse", input: {} })), /拒绝执行/);
  t.done();
});

test("stop cancels the speaker and empties the queue; a stopped member can't hand out work", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude", "codex"]);
  const [a, b] = s.agents;
  await t.svc.send(s.id, "@Claude-1 @Codex-1 干活", [a.id, b.id]);
  await until(() => t.typed.length === 1);

  assert.ok((await t.svc.stop(s.id)).ok);
  await until(() => t.d.view().running === 0 && t.d.view().queued === 0);
  assert.equal(t.typed.length, 1, "the queued member was never asked");
  assert.deepEqual(t.d.jobs().map((j) => j.status), ["cancelled", "cancelled"]);
  assert.match(String(await t.sendTo("p1", "p2", "继续")), /没有进行中的任务/);
  t.done();
});

test("removing a member and ending the session; saved sessions come back with members exited", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude", "codex"]);
  const [a, b] = s.agents;

  assert.ok((await t.svc.removeAgent(s.id, a.id)).ok);
  assert.deepEqual(t.closed, [a.tab]);
  assert.deepEqual(t.notices, [{ tab: a.tab, code: -101 }], "whoever watches its terminal is told it was removed");
  assert.deepEqual(t.store.meta(s.id).agents.map((x) => x.name), ["Codex-1"]);
  assert.equal(t.kinds().filter((k) => k === "agentExited").length, 1, "the tab's own exit is not recorded twice");

  // The app quits and starts again: the member is listed, but exited.
  const again = new SessionStore(path.join(t.base, "sessions"));
  await again.load();
  assert.deepEqual(again.meta(s.id).agents.map((x) => [x.name, x.status]), [["Codex-1", "exited"]]);
  assert.equal(again.events(s.id, undefined, 200).length, t.store.events(s.id, undefined, 200).length);

  assert.ok((await t.svc.end(s.id)).ok);
  assert.deepEqual(t.closed, [a.tab, b.tab]);
  assert.deepEqual(t.notices[1], { tab: b.tab, code: -102 }, "and that the session ended");
  const meta = t.store.meta(s.id);
  assert.equal(meta.state, "ended");
  assert.deepEqual(meta.agents.map((x) => x.status), ["exited"]);
  assert.equal((await t.svc.send(s.id, "还在吗", [])).ok, false, "an ended session is read-only");
  assert.equal((await t.svc.addAgent(s.id, "claude")).ok, false);
  const got = await t.svc.get(s.id);
  assert.ok(got.ok && got.data.events.length > 0);
  t.done();
});

test("at most four members", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude", "claude", "codex", "codex"]);
  const fifth = await t.svc.addAgent(s.id, "claude");
  assert.equal(fifth.ok, false);
  assert.equal((await t.svc.addAgent(s.id, "gemini")).ok, false);
  t.done();
});

test("only a session member's tab gets an exit notice", () => {
  assert.equal(memberExitCode("s:0a1b2c3d4e5f6a7b:9f8e7d6c", "removed"), -101);
  assert.equal(memberExitCode("s:0a1b2c3d4e5f6a7b:9f8e7d6c", "ended"), -102);
  for (const tab of ["t1", "cs:0a1b2c3d", "s:only-session", "s::x", "xs:a:b", "s:a:b:c", ""]) {
    assert.equal(memberExitCode(tab, "removed"), null, `${tab || "(empty)"} closes silently`);
  }
});

test("a member that exits by itself is recorded once, without a notice from sikeoop", async () => {
  const t = setup();
  const s = await sessionWith(t, ["claude"]);
  t.views.delete("p1");
  await t.svc.onPeerEvent({ group: s.id, peerId: "p1", tab: s.agents[0].tab, kind: "exit" });
  assert.deepEqual(statuses(t, s.id), ["exited"]);
  assert.equal(t.kinds().at(-1), "agentExited");
  assert.deepEqual(t.notices, [], "its own exit code reaches the tab from the terminal");
  // Ending the session afterwards has no program left to end.
  assert.ok((await t.svc.end(s.id)).ok);
  assert.deepEqual(t.notices, []);
  t.done();
});
