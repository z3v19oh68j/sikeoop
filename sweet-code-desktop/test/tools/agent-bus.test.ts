// Run: node --test test/tools/
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { agentBusTools, type AgentBusDeps } from "../../src/main/tools/agent-bus-tools.ts";
import { dispatchTools } from "../../src/main/tools/dispatch-tools.ts";
import type { ApprovalRequest, ToolContext } from "../../src/main/tools/registry.ts";
import type { AgentCli, AgentSessionView, DispatchJob } from "../../src/shared/types.ts";

const session = (name: string, cli: AgentCli = name.startsWith("Codex") ? "codex" : "claude"): AgentSessionView =>
  ({ id: name.toLowerCase(), name, cli, status: "idle", detail: "", since: 0 }) as AgentSessionView;

const done = (text: string, extra: Partial<DispatchJob> = {}): DispatchJob => ({ status: "done", result: { text }, ...extra }) as DispatchJob;

/** The bus with the sessions named, each job ending with what `reply` says. */
function setup(names: string[], opts: { approve?: boolean; reply?: (to: string, message: string) => DispatchJob | string; window?: boolean } = {}) {
  const sessions = names.map((n) => session(n));
  const asked: ApprovalRequest[] = [];
  const sent: { to: string; message: string; limits: unknown }[] = [];
  const opened: AgentCli[] = [];
  const deps: AgentBusDeps = {
    list: () => "",
    find: (name) => {
      const key = name.toLowerCase();
      const exact = sessions.find((s) => s.name.toLowerCase() === key);
      if (exact) return exact;
      if (/\d/.test(key)) return { error: `没有叫「${name}」的会话。` };
      const pool = sessions.filter((s) => s.cli === key);
      if (pool.length === 1) return pool[0];
      return pool.length ? { error: "有好几个，用全名指定一个。" } : { error: `没有在线的 ${key} 会话。`, missing: key as AgentCli };
    },
    send: (to, message, _parent, limits) => {
      sent.push({ to, message, limits });
      const r = opts.reply?.(to, message) ?? done(`${to} 的回复`);
      if (typeof r === "string") return { error: r };
      return { session: sessions.find((s) => s.name === to)!, queued: false, done: Promise.resolve(r) };
    },
    pending: (id) => (id === "claude-1" ? Promise.resolve(done("一号做完")) : null),
    last: (s) => (s.id === "codex-1" ? done("二号早做完了") : null),
    waitTurn: async () => null,
    ids: () => new Set(sessions.map((s) => s.id)),
    waitStarted: async (cli) => {
      const s = session(cli === "codex" ? "Codex-1" : "Claude-1", cli);
      sessions.push(s);
      return s;
    },
    open: (cli) => {
      if (opts.window === false) return false;
      opened.push(cli);
      return true;
    },
  };
  const ctx = {
    signal: new AbortController().signal,
    requestApproval: async (req: ApprovalRequest) => {
      asked.push(req);
      return opts.approve === false ? { approved: false } : { approved: true };
    },
  } as unknown as ToolContext;
  const tool = (name: string) => agentBusTools(deps).find((t) => t.name === name)!;
  const call = (name: string, input: unknown) => tool(name).run(tool(name).schema.parse(input), ctx);
  return { asked, sent, opened, call, tool };
}

test("one target: one card with the message, the reply comes back", async () => {
  const t = setup(["Claude-1"]);
  const out = await t.call("send_to_agent", { to: "claude", message: " 修登录 ", typecheck: "npm run typecheck" });
  assert.equal(t.asked.length, 1);
  assert.deepEqual(t.asked[0], { kind: "tool", server: "agent-bus", tool: "send_to_agent", description: "交给 Claude-1 一个任务", args: "修登录" });
  assert.deepEqual(t.sent, [{ to: "Claude-1", message: "修登录", limits: { owns: undefined, network: undefined, deps: undefined, typecheck: "npm run typecheck" } }]);
  assert.match(out, /^Claude-1 做完了这一轮，它的最后回复：\n\nClaude-1 的回复$/);
});

test("neither message nor tasks is an error, and nobody is asked", async () => {
  const t = setup(["Claude-1"]);
  assert.match(await t.call("send_to_agent", { to: "claude" }), /^Error: /);
  assert.equal(t.asked.length, 0);
});

test("a batch asks once and returns every session's reply", async () => {
  const t = setup(["Claude-1", "Codex-1"]);
  const out = await t.call("send_to_agent", {
    tasks: [
      { to: "Claude-1", message: "改界面", owns: ["src/renderer/"] },
      { to: "Codex-1", message: "改主进程" },
      { to: "Claude-1", message: "再补测试" },
    ],
  });
  assert.equal(t.asked.length, 1, "one card for the whole batch");
  const card = t.asked[0] as Extract<ApprovalRequest, { kind: "tool" }>;
  assert.equal(card.description, "一次交给 Claude-1、Codex-1 共 3 个任务");
  assert.equal(card.args, "【Claude-1】改界面\n\n【Codex-1】改主进程\n\n【Claude-1】再补测试");
  assert.deepEqual(t.sent.map((s) => s.to), ["Claude-1", "Codex-1", "Claude-1"]);
  assert.deepEqual(t.sent[0].limits, { owns: ["src/renderer/"], network: undefined, deps: undefined, typecheck: undefined });
  assert.equal(out.split("\n\n---\n\n").length, 3);
  assert.match(out, /Codex-1 做完了这一轮/);
});

test("a declined batch sends nothing", async () => {
  const t = setup(["Claude-1", "Codex-1"], { approve: false });
  const out = await t.call("send_to_agent", { tasks: [{ to: "Claude-1", message: "a" }, { to: "Codex-1", message: "b" }] });
  assert.match(out, /^用户没有同意交给 Claude-1、Codex-1/);
  assert.equal(t.sent.length, 0);
});

test("one task failing leaves the others alone", async () => {
  const t = setup(["Claude-1", "Codex-1"], { reply: (to) => (to === "Codex-1" ? "Codex-1 还在启动，稍等再发" : done("好了")) });
  const out = await t.call("send_to_agent", {
    tasks: [
      { to: "Claude-3", message: "没这个人" },
      { to: "Codex-1", message: "b" },
      { to: "Claude-1", message: "c" },
    ],
  });
  const card = t.asked[0] as Extract<ApprovalRequest, { kind: "tool" }>;
  assert.equal(card.description, "一次交给 Codex-1、Claude-1 共 2 个任务", "only what can be sent is on the card");
  const parts = out.split("\n\n---\n\n");
  assert.match(parts[0], /^Claude-3：Error: 没有叫「Claude-3」的会话/);
  assert.match(parts[1], /^Codex-1：Error: Codex-1 还在启动/);
  assert.match(parts[2], /^Claude-1 做完了这一轮，它的最后回复：\n\n好了$/);
});

test("a batch nobody can take never reaches the user", async () => {
  const t = setup(["Claude-1"]);
  const out = await t.call("send_to_agent", { tasks: [{ to: "Claude-7", message: "a" }, { to: "Codex-2", message: "b" }] });
  assert.equal(t.asked.length, 0);
  assert.equal(out.split("\n\n---\n\n").length, 2);
});

test("claude / codex with none running: a session is opened on the same card", async () => {
  const t = setup(["Claude-1"]);
  const out = await t.call("send_to_agent", { tasks: [{ to: "codex", message: "a" }, { to: "codex", message: "b" }, { to: "claude", message: "c" }] });
  assert.equal(t.asked.length, 1);
  assert.match((t.asked[0] as Extract<ApprovalRequest, { kind: "tool" }>).description, /（会新开一个 Codex 会话）$/);
  assert.deepEqual(t.opened, ["codex"], "one new session for both codex tasks");
  assert.deepEqual(t.sent.map((s) => s.to), ["Codex-1", "Codex-1", "Claude-1"]);
  assert.match(out, /Codex-1 做完了这一轮/);

  const single = setup([]);
  await single.call("send_to_agent", { to: "claude", message: "a" });
  assert.equal((single.asked[0] as Extract<ApprovalRequest, { kind: "tool" }>).description, "交给 新开的 Claude Code 一个任务（会新开一个 Claude Code 会话）");
  assert.deepEqual(single.sent.map((s) => s.to), ["Claude-1"]);
});

test("nothing is opened for a numbered name, an empty name, or without a window", async () => {
  const t = setup([]);
  assert.match(await t.call("send_to_agent", { to: "Codex-2", message: "a" }), /^Error: 没有叫「Codex-2」/);
  assert.equal(t.asked.length, 0);
  assert.deepEqual(t.opened, []);

  const closed = setup([], { window: false });
  assert.match(await closed.call("send_to_agent", { to: "codex", message: "a" }), /^Error: sikeoop 窗口没开/);
  assert.equal(closed.sent.length, 0);
});

test("wait: false returns at once, per task", async () => {
  const t = setup(["Claude-1", "Codex-1"]);
  const out = await t.call("send_to_agent", { wait: false, tasks: [{ to: "Claude-1", message: "a" }, { to: "Codex-1", message: "b" }] });
  assert.match(out, /已交给 Claude-1，它在干活。用 wait_agent（to="Claude-1"）取结果。/);
  assert.match(out, /已交给 Codex-1/);
});

test("replies returned together share the room one would have", async () => {
  const t = setup(["Claude-1", "Codex-1"], { reply: () => done("长".repeat(20_000)) });
  const single = await t.call("send_to_agent", { to: "Claude-1", message: "a" });
  const batch = await t.call("send_to_agent", { tasks: [{ to: "Claude-1", message: "a" }, { to: "Codex-1", message: "b" }, { to: "Claude-1", message: "c" }, { to: "Codex-1", message: "d" }] });
  assert.ok(single.length < 8100);
  assert.ok(batch.length < 16_500, `batch is ${batch.length} long`);
});

test("wait_agent takes one name, a comma list or an array", async () => {
  const t = setup(["Claude-1", "Codex-1"]);
  assert.match(await t.call("wait_agent", { to: "Claude-1" }), /^Claude-1 做完了这一轮，它的最后回复：\n\n一号做完$/);
  for (const to of ["Claude-1, Codex-1，Nobody-9", ["Claude-1", "Codex-1", "Nobody-9"]]) {
    const parts = (await t.call("wait_agent", { to })).split("\n\n---\n\n");
    assert.equal(parts.length, 3);
    assert.match(parts[0], /一号做完/);
    assert.match(parts[1], /二号早做完了/);
    assert.match(parts[2], /^Nobody-9：Error: /);
  }
  assert.equal(t.tool("wait_agent").summarize({ to: "a,b" }), "等 a、b 做完");
});

test("only read-only cluster roles may be dispatched side by side", () => {
  const [tool] = dispatchTools({ roles: [{ name: "reviewer", description: "审查", readOnly: true }, { name: "coder", description: "写代码" }], run: async () => "" });
  const safe = tool.parallelSafe as (input: unknown) => boolean;
  assert.equal(typeof safe, "function");
  assert.equal(safe({ role: "reviewer", goal: "", acceptance: [] }), true);
  assert.equal(safe({ role: "coder", goal: "", acceptance: [] }), false);
  assert.equal(safe({ role: "nobody", goal: "", acceptance: [] }), false);
  assert.match(tool.description, /- reviewer（只读）：审查\n- coder：写代码/);
});

test("a model takes a task as a sub-agent, next to the sessions, on the same card", async () => {
  const t = setup(["Claude-1"]);
  const ran: { name: string; message: string; limits: unknown }[] = [];
  const tools = agentBusTools({
    ...({} as AgentBusDeps),
    list: () => "Claude-1 · 空闲",
    find: (name) => (name === "Claude-1" ? session("Claude-1") : { error: `没有叫「${name}」的会话。` }),
    send: (to) => ({ session: session(to), queued: false, done: Promise.resolve(done("会话的回复")) }),
    workers: {
      list: () => "deepseek/deepseek-chat（DeepSeek）· 可用",
      find: (name) => (name.toLowerCase() === "deepseek/deepseek-chat" ? "deepseek/deepseek-chat" : null),
      run: (name, message, _signal, _parent, limits) => {
        ran.push({ name, message, limits });
        return { done: Promise.resolve(done("子代理的汇报")) };
      },
    },
  });
  const asked: ApprovalRequest[] = [];
  const ctx = { signal: new AbortController().signal, requestApproval: async (r: ApprovalRequest) => (asked.push(r), { approved: true }) } as unknown as ToolContext;
  const run = (name: string, input: unknown) => {
    const tool = tools.find((x) => x.name === name)!;
    return tool.run(tool.schema.parse(input), ctx);
  };
  assert.equal(await run("list_agents", {}), "Claude-1 · 空闲\n\ndeepseek/deepseek-chat（DeepSeek）· 可用");
  // wait: false does not apply to a sub-agent: there is no session to ask later.
  const out = await run("send_to_agent", {
    wait: false,
    tasks: [
      { to: "DeepSeek/deepseek-chat", message: "查一下登录流程", owns: ["docs/"] },
      { to: "Claude-1", message: "改界面" },
      { to: "nobody/model", message: "x" },
    ],
  });
  assert.equal(asked.length, 1);
  assert.equal((asked[0] as Extract<ApprovalRequest, { kind: "tool" }>).description, "一次交给 deepseek/deepseek-chat、Claude-1 共 2 个任务");
  assert.deepEqual(ran, [{ name: "deepseek/deepseek-chat", message: "查一下登录流程", limits: { owns: ["docs/"], network: undefined, deps: undefined, typecheck: undefined } }]);
  const parts = out.split("\n\n---\n\n");
  assert.match(parts[0], /^deepseek\/deepseek-chat 做完了这一轮，它的最后回复：\n\n子代理的汇报$/);
  assert.match(parts[1], /^已交给 Claude-1/);
  assert.match(parts[2], /^nobody\/model：Error: /);
  assert.equal(t.asked.length, 0);
});

// ---- 调度核心第一批 F4：子代理结果可回收 ----

/** The bus with one sub-agent model whose jobs the test ends by hand. */
function workerSetup() {
  const jobs = new Map<string, { done: Promise<DispatchJob>; end(job: DispatchJob): void }>();
  let n = 0;
  const tools = agentBusTools({
    ...({} as AgentBusDeps),
    find: (name) => ({ error: `没有叫「${name}」的会话。` }),
    job: (id) => jobs.get(id)?.done ?? null,
    workers: {
      list: () => "",
      find: (name) => (name === "openai/gpt-x" ? name : null),
      run: () => {
        const id = `job-${++n}-0123456789abcdef`;
        let end!: (job: DispatchJob) => void;
        const done = new Promise<DispatchJob>((r) => (end = r));
        jobs.set(id, { done, end });
        return { job: { id } as DispatchJob, done };
      },
    },
  });
  const ctx = { signal: new AbortController().signal, requestApproval: async () => ({ approved: true }) } as unknown as ToolContext;
  const call = (name: string, input: unknown) => {
    const tool = tools.find((x) => x.name === name)!;
    return tool.run(tool.schema.parse(input), ctx);
  };
  return { jobs, call };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test("T4-1: by default a sub-agent is waited for past 20 minutes, until it is done", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const w = workerSetup();
  const out = w.call("send_to_agent", { to: "openai/gpt-x", message: "查一下" });
  await flush();
  mock.timers.tick(25 * 60_000);
  await flush();
  w.jobs.get("job-1-0123456789abcdef")!.end(done("子代理做完了"));
  const text = await out;
  assert.match(text, /做完了这一轮，它的最后回复：\n\n子代理做完了$/);
  assert.doesNotMatch(text, /还没做完/);
});

test("T4-2: a shorter wait names the job, and wait_agent({ job }) gets the result later", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const w = workerSetup();
  const id = "job-1-0123456789abcdef";
  const out = w.call("send_to_agent", { to: "openai/gpt-x", message: "查一下", wait_minutes: 1 });
  await flush();
  mock.timers.tick(60_000);
  const text = await out;
  assert.match(text, /还没做完/);
  assert.ok(text.includes(`#${id.slice(0, 8)}`), text);
  assert.ok(text.includes(`job="${id}"`), text);
  w.jobs.get(id)!.end(done("迟到的结果"));
  assert.match(await w.call("wait_agent", { job: id }), /迟到的结果/);
  assert.match(await w.call("wait_agent", { job: "nope" }), /^Error: 没有任务/);
});

test("T4-3: wait_agent with a model name says to use job", async () => {
  const w = workerSetup();
  assert.match(await w.call("wait_agent", { to: "openai/gpt-x" }), /子代理请用 job 参数等/);
});
