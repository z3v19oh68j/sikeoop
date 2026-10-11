import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentCli, CrossSession, DispatchJob, MemberExitCode, SessionAgent, SessionAgentStatus, SessionResult, TimelineEvent } from "@shared/types";
import { CliExecutor } from "../dispatch/cli.ts";
import type { CliBus } from "../dispatch/cli.ts";
import type { Dispatcher } from "../dispatch/scheduler.ts";
import type { SessionPeerEvent } from "../peers.ts";
import { canonicalRoots, checkScope } from "./scope.ts";
import type { SessionStore } from "./store.ts";

// Cross-project sessions (docs/cross-session-spec.md): the user and up to four Claude Code / Codex
// sessions on one timeline, over two or more project folders. This is a view on the dispatch core:
// - a member is a PeerBus session whose group is the session id, wrapped in a `cli` executor
// - an @ from the user, and a send_to between members, is a job; the session id is the jobs' lane,
//   so one member speaks at a time and the rest wait in the dispatcher's queue
// - the job tree's budget stops members calling each other forever (the hopLimit event)
// - a member's hook events arrive through onPeerEvent: scope and lock refusals, replies, exits
// No Electron here: the terminal, the dialogs and the window are handed in, so it runs under node --test.

const MAX_AGENTS = 4;
const MIN_ROOTS = 2;
const PAGE = 200;
const MAX_TEXT = 20_000;
/** `from` of a job the user started from the timeline. */
const USER = "用户";

export interface SessionServiceDeps {
  store: SessionStore;
  dispatcher: Pick<Dispatcher, "submit" | "cancel" | "current">;
  bus: CliBus;
  /** Registers a PeerBus session in `group` and starts the CLI in `tab` over `roots`. Throws when it can't. */
  launch(input: { tab: string; cli: AgentCli; group: string; roots: string[] }): Promise<{ peerId: string; name: string }>;
  /** Ends the member's program and its PeerBus session; `why` is told to whoever is watching its terminal. */
  closeTab(tab: string, why: MemberExitWhy): void;
  /** A folder the user has opened before (recent projects) or has open now. `dir` is a real path. */
  allowedRoot(dir: string): Promise<boolean> | boolean;
  /** The native "add this folder?" box. */
  confirmAddRoot(dir: string, session: CrossSession): Promise<boolean>;
  /** Brings up the member's terminal tab, read-only, with its recent output. Returns why it can't, or nothing. */
  showTerminal(tab: string): string | void;
  onEvent(id: string, event: TimelineEvent): void;
  onChanged(meta: CrossSession): void;
}

/** Why sikeoop itself ended a member's program. */
export type MemberExitWhy = "removed" | "ended";

const MEMBER_TAB = /^s:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/;

/**
 * What term:exit says when sikeoop ends a terminal tab's program itself. Only a session member's
 * tab gets a notice (a read-only view of it may be open); any other tab closes silently, as before.
 */
export function memberExitCode(tab: string, why: MemberExitWhy): MemberExitCode | null {
  if (!MEMBER_TAB.test(tab)) return null;
  return why === "removed" ? -101 : -102;
}

interface Member {
  sessionId: string;
  agentId: string;
  name: string;
  peerId: string;
  executor: MemberExecutor;
}

/** A member's terminal session. It can write every folder it was started with, not just the first. */
class MemberExecutor extends CliExecutor {
  readonly roots: string[];
  private readonly memberCli: AgentCli;

  constructor(bus: CliBus, peerId: string, name: string, cli: AgentCli, roots: string[]) {
    super(bus, peerId, name, frame, { cli, root: roots[0] });
    this.roots = roots;
    this.memberCli = cli;
  }

  env(): { writableRoots: string[]; network: boolean | "ask" } {
    return { writableRoots: this.roots, network: this.memberCli === "codex" ? "ask" : true };
  }
}

/** How a job reads in the member's terminal. */
function frame(job: DispatchJob): { text: string; detail: string } {
  return job.from === USER
    ? { text: `[用户 → 你] ${job.input}\n（用户在跨项目 session 的时间线上点名了你。做完直接结束这一轮，你最后一条回复会自动进入时间线。）`, detail: "收到用户的任务" }
    : { text: `[${job.from} → 你] ${job.input}\n（来自同一个 session 的成员。要回复它用 send_to，to="${job.from}"；做完直接结束这一轮，回复会进入时间线。）`, detail: `收到 ${job.from} 的消息` };
}

const ok = <T>(data: T): SessionResult<T> => ({ ok: true, data });
const done: SessionResult = { ok: true, data: undefined };
const fail = (message: string) => ({ ok: false as const, message });
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class SessionService {
  private readonly deps: SessionServiceDeps;
  /** Running members, by PeerBus session id. */
  private readonly members = new Map<string, Member>();
  /** Unfinished jobs, by job id. */
  private readonly jobs = new Map<string, { sessionId: string; agentId: string }>();
  /** Members being started, per session: they count against the limit before they are listed. */
  private readonly starting = new Map<string, number>();

  constructor(deps: SessionServiceDeps) {
    this.deps = deps;
  }

  /** Reads the saved sessions. Their members ended with the app: the store lists them as exited. */
  async init(): Promise<void> {
    await this.deps.store.load();
  }

  // ---- CrossSessionApi (IPC arguments arrive unchecked) ----

  list(): Promise<SessionResult<CrossSession[]>> {
    return this.safely(async () => ok(this.deps.store.list()));
  }

  get(id: unknown, before?: unknown): Promise<SessionResult<{ meta: CrossSession; events: TimelineEvent[] }>> {
    return this.safely(async () => {
      const meta = this.deps.store.meta(str(id));
      const upTo = typeof before === "number" && Number.isFinite(before) ? before : undefined;
      return ok({ meta, events: this.deps.store.events(meta.id, upTo, PAGE) });
    });
  }

  create(input: unknown): Promise<SessionResult<CrossSession>> {
    return this.safely(async () => {
      const { title, roots } = (input ?? {}) as { title?: unknown; roots?: unknown };
      const name = str(title).trim().slice(0, 80);
      if (!name) return fail("给这个 session 起个名字");
      if (!Array.isArray(roots) || !roots.every((r) => typeof r === "string")) return fail("请选择项目目录");
      const real = await canonicalRoots(roots as string[]);
      if (real.length < MIN_ROOTS) return fail(`跨项目 session 至少要 ${MIN_ROOTS} 个不同的目录`);
      for (const dir of real) if (!(await this.deps.allowedRoot(dir))) return fail(`${dir} 不在最近打开的项目里，先在 sikeoop 里打开它一次`);
      const meta: CrossSession = { id: randomBytes(8).toString("hex"), title: name, roots: real, agents: [], state: "active", createdAt: Date.now() };
      this.save(meta);
      return ok(meta);
    });
  }

  addAgent(id: unknown, cli: unknown): Promise<SessionResult<SessionAgent>> {
    return this.safely(async () => {
      if (cli !== "claude" && cli !== "codex") return fail("只能拉入 Claude Code 或 Codex");
      const sessionId = this.active(str(id)).id;
      const waiting = this.starting.get(sessionId) ?? 0;
      if (this.deps.store.meta(sessionId).agents.filter((a) => a.status !== "exited").length + waiting >= MAX_AGENTS) return fail(`一个 session 最多 ${MAX_AGENTS} 个 AI`);
      const agentId = randomBytes(4).toString("hex");
      const tab = `s:${sessionId}:${agentId}`;
      const roots = this.deps.store.meta(sessionId).roots;
      this.starting.set(sessionId, waiting + 1);
      let started: { peerId: string; name: string };
      try {
        started = await this.deps.launch({ tab, cli, group: sessionId, roots });
      } finally {
        this.starting.set(sessionId, (this.starting.get(sessionId) ?? 1) - 1);
      }
      const meta = this.deps.store.meta(sessionId);
      if (meta.state !== "active") {
        this.deps.closeTab(tab, "ended");
        return fail("这个 session 已经结束了");
      }
      const agent: SessionAgent = { id: agentId, cli, name: started.name, status: "starting", tab };
      // After a restart the names start over: a new Claude-1 takes the place of the exited one.
      meta.agents = [...meta.agents.filter((a) => !(a.status === "exited" && a.name === agent.name)), agent];
      // The list holds four at most: the oldest exited members make room.
      while (meta.agents.length > MAX_AGENTS) {
        const gone = meta.agents.findIndex((a) => a.status === "exited");
        if (gone < 0) break;
        meta.agents.splice(gone, 1);
      }
      this.members.set(started.peerId, { sessionId, agentId, name: agent.name, peerId: started.peerId, executor: new MemberExecutor(this.deps.bus, started.peerId, agent.name, cli, roots) });
      agent.status = this.statusOf(agent);
      this.save(meta);
      this.add(sessionId, { kind: "agentJoined", from: agent.name });
      return ok(agent);
    });
  }

  removeAgent(id: unknown, agentId: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const meta = this.active(str(id));
      const agent = meta.agents.find((a) => a.id === agentId);
      if (!agent) return fail("这个成员已经不在了");
      this.cancelJobs(meta.id, agent.id);
      const member = this.memberOf(agent.id);
      meta.agents = meta.agents.filter((a) => a !== agent);
      this.save(meta);
      if (agent.status !== "exited") this.add(meta.id, { kind: "agentExited", from: agent.name, text: "被移出" });
      // Forgotten first, so the exit that closing the tab reports isn't recorded a second time.
      if (member) this.members.delete(member.peerId);
      this.deps.closeTab(agent.tab, "removed");
      return done;
    });
  }

  send(id: unknown, text: unknown, mentions: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const meta = this.active(str(id));
      const body = str(text).trim();
      if (!body) return fail("先写点什么");
      if (body.length > MAX_TEXT) return fail(`这条太长了（${body.length} 字，上限 ${MAX_TEXT}）`);
      if (!Array.isArray(mentions) || !mentions.every((m) => typeof m === "string")) return fail("点名的成员无效");
      const targets: Member[] = [];
      for (const agentId of new Set(mentions as string[])) {
        const agent = meta.agents.find((a) => a.id === agentId);
        const member = agent && this.memberOf(agent.id);
        if (!agent) return fail("点名的成员不在这个 session 里");
        if (!member || agent.status === "exited") return fail(`${agent.name} 已经退出了，拉一个新的进来再点名`);
        targets.push(member);
      }
      // Recorded either way; without an @ nobody is asked.
      this.add(meta.id, { kind: "user", from: "user", to: targets.map((m) => m.name), text: body });
      // Each speech by the user starts fresh trees, with a fresh budget.
      for (const to of targets) this.submit(to, body, USER);
      this.sync();
      return done;
    });
  }

  addRoot(id: unknown, dir: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const before = this.active(str(id));
      const [real] = await canonicalRoots([str(dir)]);
      if (before.roots.includes(real)) return fail("这个目录已经在 session 里了");
      if (!(await this.deps.confirmAddRoot(real, before))) return fail("没有加入：你取消了");
      const meta = this.active(before.id);
      if (meta.roots.includes(real)) return done;
      meta.roots = [...meta.roots, real];
      this.save(meta);
      this.add(meta.id, { kind: "system", text: `已加入目录 ${real}。已经在运行的 AI 要移出后重新拉入才能用它。`, dir: real });
      return done;
    });
  }

  end(id: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const meta = this.deps.store.meta(str(id));
      if (meta.state === "ended") return done;
      this.cancelJobs(meta.id);
      const tabs = meta.agents.filter((a) => a.status !== "exited").map((a) => a.tab);
      for (const m of [...this.members.values()]) if (m.sessionId === meta.id) this.members.delete(m.peerId);
      meta.agents = meta.agents.map((a) => ({ ...a, status: "exited" }));
      meta.state = "ended";
      meta.endedAt = Date.now();
      this.add(meta.id, { kind: "system", text: "session 已结束，时间线只能看了。" });
      this.save(meta);
      for (const tab of tabs) this.deps.closeTab(tab, "ended");
      return done;
    });
  }

  openTerminal(id: unknown, agentId: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const agent = this.deps.store.meta(str(id)).agents.find((a) => a.id === agentId);
      if (!agent || !this.memberOf(agent.id)) return fail("这个成员已经退出了，没有终端可看");
      const problem = this.deps.showTerminal(agent.tab);
      return problem ? fail(problem) : done;
    });
  }

  /** Cancels what is being said and empties the queue, for the whole session or one member. */
  stop(id: unknown, agentId?: unknown): Promise<SessionResult> {
    return this.safely(async () => {
      const meta = this.deps.store.meta(str(id));
      const agent = typeof agentId === "string" && agentId ? meta.agents.find((a) => a.id === agentId) : undefined;
      if (typeof agentId === "string" && agentId && !agent) return fail("这个成员已经不在了");
      if (this.cancelJobs(meta.id, agent?.id)) this.add(meta.id, { kind: "system", text: `你叫停了${agent ? ` ${agent.name}` : "所有 AI"}，排队的任务已清空。` });
      this.sync();
      return done;
    });
  }

  // ---- from PeerBus and the dispatcher ----

  /**
   * A member's send_to, tool call, finished turn or exit (PeerBus's onSessionEvent). For a send or
   * a tool call the answer is why it was refused, or nothing when it may go ahead.
   */
  async onPeerEvent(e: SessionPeerEvent): Promise<string | void> {
    const member = this.members.get(e.peerId);
    if (!member || member.sessionId !== e.group) {
      // Fail closed: a group session nobody knows may not touch anything.
      return e.kind === "send" || e.kind === "preToolUse" ? "这个会话不属于进行中的跨项目 session，拒绝执行" : undefined;
    }
    try {
      if (e.kind === "send") return this.memberSend(member, e.to ?? "", e.text ?? "");
      if (e.kind === "preToolUse") return await this.toolCall(member, e.input ?? {});
      if (e.kind === "stop") {
        this.add(member.sessionId, { kind: "agent", from: member.name, text: e.text?.trim() || "（这一轮没有文字回复）" });
      } else {
        this.members.delete(member.peerId);
        const meta = this.deps.store.meta(member.sessionId);
        const agent = meta.agents.find((a) => a.id === member.agentId);
        if (agent && agent.status !== "exited") {
          agent.status = "exited";
          this.save(meta);
          this.add(meta.id, { kind: "agentExited", from: member.name });
        }
      }
    } catch (err) {
      // A hook must always get an answer; for a send or a tool call an error is a refusal.
      if (e.kind === "send" || e.kind === "preToolUse") return `安全检查失败，拒绝执行：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The session's title, for naming its members outside the session (the island, the terminal panel). */
  titleOf(id: string): string | undefined {
    try {
      return this.deps.store.meta(id).title;
    } catch {
      return undefined;
    }
  }

  /** Members' statuses follow PeerBus and the dispatcher's queue: call it when either changes. */
  sync(): void {
    for (const sessionId of new Set([...this.members.values()].map((m) => m.sessionId))) {
      try {
        const meta = this.deps.store.meta(sessionId);
        let changed = false;
        for (const a of meta.agents) {
          const status = this.statusOf(a);
          if (status === a.status) continue;
          a.status = status;
          changed = true;
        }
        if (changed) this.save(meta);
      } catch {
        // A session that vanished from the store: nothing to refresh.
      }
    }
  }

  // ---- internals ----

  /** One member asks another (send_to): a child of the job the sender is on. */
  private memberSend(from: Member, toPeer: string, text: string): string | void {
    const to = this.members.get(toPeer);
    if (!to || to.sessionId !== from.sessionId) return "对方不在这个 session 里";
    if (this.deps.store.meta(from.sessionId).state !== "active") return "这个 session 已经结束了";
    const parent = this.deps.dispatcher.current(from.peerId);
    // No job of its own: the user stopped it, and what it still says must not start new work.
    if (!parent) return "你现在没有进行中的任务（可能被用户叫停了），不能再派活。直接结束这一轮。";
    const error = this.submit(to, text, from.name, parent.id);
    if (error) return error;
    this.add(from.sessionId, { kind: "agent", from: from.name, to: [to.name], text });
    this.sync();
  }

  /** Queues a job on the session's lane. Returns the refusal when the tree's budget is used up. */
  private submit(to: Member, input: string, from: string, parentId?: string): string | void {
    const r = this.deps.dispatcher.submit({
      executor: to.executor,
      input,
      origin: "session",
      from,
      parentId,
      // What the member was started with: a folder added later reaches it only after a restart.
      scope: { roots: to.executor.roots },
      lane: to.sessionId,
    });
    if ("error" in r) {
      this.add(to.sessionId, { kind: "hopLimit", from: from === USER ? "user" : from, to: [to.name], text: "这串任务的派活次数用完了。你看一眼进展，再发一条消息（记得 @ 点名）就会重新计数、继续干。" });
      return r.error;
    }
    this.jobs.set(r.job.id, { sessionId: to.sessionId, agentId: to.agentId });
    void r.done.then((job) => {
      this.jobs.delete(job.id);
      try {
        if (job.status === "failed" || job.status === "timeout") {
          this.add(to.sessionId, { kind: "system", text: `${to.name} 这次没做完：${job.status === "timeout" ? "超时了" : (job.error ?? "没有拿到结果")}` });
        }
      } catch {
        // The session is gone.
      }
      this.sync();
    });
  }

  /** A member's tool call, before it runs: files outside the session's folders are refused. */
  private async toolCall(member: Member, hook: Record<string, unknown>): Promise<string | void> {
    if (typeof hook.lockDenied === "string") {
      this.add(member.sessionId, { kind: "lockDenied", from: member.name, path: hook.lockDenied });
      return;
    }
    const tool = str(hook.tool_name);
    // A shell command's paths can't be checked, and the member was started being told so.
    if (tool === "Bash") return "跨项目 session 里不能运行 shell 命令，请用文件工具。";
    const input = (hook.tool_input ?? {}) as Record<string, unknown>;
    const file = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof file !== "string" || !file) return;
    const roots = this.deps.store.meta(member.sessionId).roots;
    const abs = path.resolve(str(hook.cwd) || member.executor.roots[0], file);
    let verdict: { allowed: boolean; path: string };
    try {
      verdict = await checkScope(abs, roots);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.add(member.sessionId, { kind: "outOfScope", from: member.name, path: abs, text: why });
      return `无法确认这个路径在 session 范围内，拒绝执行：${why}`;
    }
    if (verdict.allowed) return;
    const isDir = await fs.stat(verdict.path).then((s) => s.isDirectory(), () => false);
    this.add(member.sessionId, { kind: "outOfScope", from: member.name, path: verdict.path, dir: isDir ? verdict.path : path.dirname(verdict.path), text: tool });
    return `${verdict.path} 不在这个 session 的目录里（${roots.join("、")}），拒绝执行。需要的话请用户把目录加入 session。`;
  }

  private statusOf(agent: SessionAgent): SessionAgentStatus {
    const member = this.memberOf(agent.id);
    const view = member && this.deps.bus.viewOf(member.peerId);
    if (!member || !view) return "exited";
    if (view.status === "starting") return "starting";
    if (this.deps.dispatcher.current(member.peerId) || view.status !== "idle") return "busy";
    for (const j of this.jobs.values()) if (j.agentId === agent.id) return "queued";
    return "idle";
  }

  private cancelJobs(sessionId: string, agentId?: string): number {
    const ids = [...this.jobs].filter(([, j]) => j.sessionId === sessionId && (!agentId || j.agentId === agentId)).map(([id]) => id);
    for (const id of ids) this.deps.dispatcher.cancel(id);
    return ids.length;
  }

  private memberOf(agentId: string): Member | undefined {
    for (const m of this.members.values()) if (m.agentId === agentId) return m;
    return undefined;
  }

  private active(id: string): CrossSession {
    const meta = this.deps.store.meta(id);
    if (meta.state !== "active") throw new Error("这个 session 已经结束了，只能查看");
    return meta;
  }

  private save(meta: CrossSession): void {
    this.deps.store.save(meta);
    this.deps.onChanged(structuredClone(meta));
  }

  private add(id: string, input: Omit<TimelineEvent, "seq" | "at">): void {
    this.deps.onEvent(id, this.deps.store.append(id, input));
  }

  private async safely<T>(run: () => Promise<SessionResult<T>>): Promise<SessionResult<T>> {
    try {
      return await run();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
