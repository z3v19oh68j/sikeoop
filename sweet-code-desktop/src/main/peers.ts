import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileLocks } from "./session/locks";
import { fromNeutral, toNeutral } from "./cli-agents/protocol";
import { QuietWatch } from "./cli-agents/quiet";
import type { AgentCli, AgentCliId, AgentSessionView } from "@shared/types";

// The agent bus: Claude Code and Codex sessions in sikeoop's terminal tabs, and a small MCP server
// on 127.0.0.1 that lets them talk to each other (list_peers, send_to). A message is typed into
// the other session's terminal as a new prompt, the way the user would type it.
//
// Both CLIs reach the server through a stdio bridge (a tiny script run by Electron's own node),
// so nothing has to be installed and neither CLI's global config is touched. Claude Code also
// reports its state through hooks in its --settings file; Codex through its `notify` command.

/** Agent-to-agent messages in a row without the user typing in between, before the bus says stop. */
const MAX_HOPS = 5;
/** How long a permission request waits for an answer on the island before the terminal asks instead. */
const ASK_TIMEOUT_MS = 110_000;
/**
 * Longest message send_to delivers. Both sides pay for it in tokens (the sender writes it, the
 * receiver reads it), so long ones are turned back with a hint to point at files instead.
 */
const MAX_MESSAGE = 4000;
/** After an interrupt, a terminal this long without output has stopped. */
const INTERRUPT_SETTLE_MS = 3000;

/**
 * Who the session is and what "Claude" / "Codex" mean here. Without it a model asked to "send
 * Claude a message" can't tell the peer from the Claude desktop app, and goes for computer use.
 * Claude Code reads it from the MCP server's instructions; Codex ignores those, so it gets it as
 * developer_instructions.
 */
export function peerPrompt(name: string, roots?: string[]): string {
  return (
    `你是 ${name}，运行在 sikeoop 的终端里。${roots ? `这是跨项目 session，工作目录为 ${roots.join("、")}，只与本 session 成员通信。` : "同一项目"}的其他终端里还有别的 AI 会话：Claude Code 叫 Claude-1、Claude-2…，Codex 叫 Codex-1、Codex-2…，其他 CLI 也是“名字-序号”（用 list_peers 看有谁）。` +
    "用户让你给 Claude 或 Codex 发消息、问它、交给它时，指的就是这些会话：用 sikeoop 的 send_to，不要去开桌面 App、浏览器或用电脑操作。" +
    "消息写清要做什么，代码只给文件路径和行号，对方会自己读。收到的消息以「[X → 你]」开头，怎么回复按消息末尾括号里说的做。"
  );
}

interface Session {
  id: string;
  /** The terminal tab it runs in. */
  tab: string;
  name: string;
  cli: AgentCliId;
  /** What the CLI is called: "Claude Code", "Codex", or an extension CLI's name. */
  cliName: string;
  /** Set for an extension CLI. */
  extension: boolean;
  /** An extension CLI that can't report the end of a turn: judged by its terminal going quiet. */
  quiet?: QuietWatch;
  /** After an interrupt: watches for the terminal to settle (a CLI may not report an interrupted turn). */
  halt?: QuietWatch;
  /** The Enter that sends a pasted prompt, while it is still to come. */
  enter?: NodeJS.Timeout;
  token: string;
  group: string | null;
  status: AgentSessionView["status"];
  detail: string;
  since: number;
  /** Agent messages delivered to it since the user last typed there. */
  hops: number;
}

export interface SessionPeerEvent {
  group: string;
  peerId: string;
  tab: string;
  kind: "send" | "stop" | "preToolUse" | "exit";
  to?: string;
  text?: string;
  input?: Record<string, unknown>;
}

interface PendingAsk {
  session: Session;
  resolve(decision: "allow" | "deny" | null): void;
  timer: NodeJS.Timeout;
}

export class PeerBus {
  private server: http.Server | null = null;
  private port = 0;
  private bridgeFile = "";
  private sessions = new Map<string, Session>();
  private counters = new Map<string, Record<string, number>>();
  private readonly locks = fileLocks;
  private asks = new Map<string, PendingAsk>();
  /** Waiting for a session's turn to end (host_wait), by session id: called with its last reply. */
  private turnWaiters = new Map<string, Set<(last: string) => void>>();

  constructor(
    private readonly opts: {
      dir: string;
      onLimitText?(session: AgentSessionView, text: string): void;
      onUserInput?(session: AgentSessionView): void;
      onSessionEvent?(event: SessionPeerEvent): Promise<string | void> | string | void;
      /**
       * Hands an agent-to-agent message to the dispatch core, which queues it until the receiver is
       * free and counts it against the chain's budget. Returns what send_to tells the sender.
       */
      route?(from: AgentSessionView, to: AgentSessionView, message: string): string | { error: string };
      /** Why this session may not write the file now (its dispatch job owns other files), or nothing. */
      guardWrite?(sessionId: string, abs: string): Promise<string | null | void> | string | null | void;
      version: string;
      /** Types into a terminal tab. */
      write(tab: string, data: string): void;
      onChange(sessions: AgentSessionView[]): void;
      /** A session finished its turn, or needs the user. */
      onNotice(kind: "done" | "waiting", s: AgentSessionView, text: string): void;
      /** Claude Code asks for permission: show it on the island. */
      onAsk(id: string, s: AgentSessionView, title: string, detail: string): void;
      onAskGone(id: string): void;
      /** One agent sent another a message. */
      onMessage(from: string, to: string, text: string): void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.bridgeFile = path.join(this.opts.dir, "sikeoop-mcp-bridge.cjs");
    await fs.mkdir(this.opts.dir, { recursive: true });
    await fs.writeFile(this.bridgeFile, BRIDGE, "utf8");
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop(): void {
    for (const a of this.asks.values()) a.resolve(null);
    for (const s of this.sessions.values()) this.locks.release(s.id);
    this.server?.close();
    this.server = null;
  }

  /**
   * A new agent session in a tab: its name, and what to add to its command line. `extension` for a
   * CLI that isn't one of the built-in two: what its sessions are called, and how its turns end.
   */
  register(
    tab: string,
    cli: AgentCliId,
    group: string | null = null,
    extension?: { label: string; cliName: string; quietMs?: number },
  ): { id: string; name: string; mcpUrl: string; hookUrl: string; bridge: { command: string; args: string[]; env: Record<string, string> } } {
    if (this.byTab(tab)) this.unregister(tab);
    const token = randomBytes(18).toString("hex");
    const counts = this.counters.get(group ?? "") ?? {};
    this.counters.set(group ?? "", counts);
    const label = extension?.label ?? (cli === "codex" ? "Codex" : "Claude");
    counts[cli] = (counts[cli] ?? 0) + 1;
    const name = `${label}-${counts[cli]}`;
    const s: Session = {
      id: token.slice(0, 12), tab, name, cli, token, group, status: "starting", detail: "正在启动", since: Date.now(), hops: 0,
      cliName: extension?.cliName ?? (cli === "codex" ? "Codex" : "Claude Code"),
      extension: !!extension,
    };
    if (extension?.quietMs) {
      s.quiet = new QuietWatch(extension.quietMs, (tail) => void this.wentQuiet(s, tail));
      // Its first silence is the end of starting up.
      s.quiet.arm();
    }
    this.sessions.set(s.id, s);
    this.changed();
    const mcpUrl = `http://127.0.0.1:${this.port}/rpc/${token}`;
    return {
      id: s.id,
      name,
      mcpUrl,
      hookUrl: `http://127.0.0.1:${this.port}/hook/${token}`,
      // Electron runs the bridge as plain node: nothing extra to install.
      bridge: { command: process.execPath, args: [this.bridgeFile, mcpUrl], env: { ELECTRON_RUN_AS_NODE: "1" } },
    };
  }

  /** The tab's program ended (or was replaced). */
  unregister(tab: string): void {
    for (const s of this.sessions.values()) {
      if (s.tab !== tab) continue;
      this.sessions.delete(s.id);
      s.quiet?.stop();
      this.settled(s);
      clearTimeout(s.enter);
      this.locks.release(s.id);
      if (s.group) void this.opts.onSessionEvent?.({ group: s.group, peerId: s.id, tab: s.tab, kind: "exit" });
      for (const [id, a] of this.asks) if (a.session === s) this.answer(id, null);
    }
    this.changed();
  }

  /** The user sent a prompt in a tab (Enter): the agent chain there starts over, and it's working. */
  userTyped(tab: string, data: string): void {
    const s = this.byTab(tab);
    // A session member's tab is read-only; keys the user is let through to answer a startup prompt
    // are not a prompt of theirs, and must not leave the member looking busy.
    if (!s || s.group || !data.includes("\r")) return;
    this.opts.onUserInput?.(view(s));
    s.quiet?.arm();
    this.settled(s);
    s.hops = 0;
    if (s.status !== "working") this.set(s, "working", "正在干活");
  }

  viewOf(id: string): AgentSessionView | null {
    const s = this.sessions.get(id);
    return s ? view(s) : null;
  }

  /** Type a prompt into a session's terminal as the user would, and mark it working. */
  deliver(id: string, text: string, detail: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    // Bracketed paste keeps line breaks inside one prompt; the Enter after it sends it.
    this.opts.write(s.tab, `\x1b[200~${text}\x1b[201~`);
    clearTimeout(s.enter);
    s.enter = setTimeout(() => {
      s.enter = undefined;
      this.opts.write(s.tab, "\r");
    }, 150);
    s.quiet?.arm();
    this.settled(s);
    this.set(s, "working", detail);
    return true;
  }

  /** What a tab's program printed: only a session that is judged by silence listens. */
  output(tab: string, data: string): void {
    for (const s of this.sessions.values()) {
      if (s.tab !== tab) continue;
      s.quiet?.output(data);
      s.halt?.output(data);
    }
  }

  /**
   * Stops what a session is doing, as the user pressing Esc in its terminal would (a cancelled
   * job). Whether the CLI then reports the turn as over differs, so the terminal is watched: once
   * it has gone still the session counts as idle again. One that keeps working keeps printing, and
   * stays busy.
   */
  interrupt(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.status === "idle" || s.status === "starting") return;
    if (s.enter) {
      // The prompt was pasted but not sent yet: it is taken back instead, and nothing ran.
      clearTimeout(s.enter);
      s.enter = undefined;
      this.opts.write(s.tab, "\x03");
      s.quiet?.stop();
      this.locks.release(s.id);
      this.set(s, "idle", "已叫停");
      return;
    }
    this.opts.write(s.tab, "\x1b");
    // Judged by silence anyway: its own watch ends the turn.
    if (s.quiet) return;
    this.settled(s);
    s.halt = new QuietWatch(INTERRUPT_SETTLE_MS, () => {
      s.halt = undefined;
      if (!this.sessions.has(s.id) || s.status === "idle") return;
      this.locks.release(s.id);
      this.set(s, "idle", "已叫停");
    });
    s.halt.arm(true);
  }

  /** The watch an interrupt left is over: the turn ended by itself, or a new one began. */
  private settled(s: Session): void {
    s.halt?.stop();
    s.halt = undefined;
  }

  sessionsView(): AgentSessionView[] {
    return [...this.sessions.values()].map(view);
  }

  tabOf(id: string): string | null {
    return this.sessions.get(id)?.tab ?? null;
  }

  /** The island's answer to a permission request. */
  answer(id: string, decision: "allow" | "deny" | null): void {
    const a = this.asks.get(id);
    if (!a) return;
    this.asks.delete(id);
    clearTimeout(a.timer);
    a.resolve(decision);
    this.opts.onAskGone(id);
  }

  /** Claude Code's --settings additions: hooks that report to the bus, and its tools allowed without asking. */
  claudeSettings(hookUrl: string): { hooks: Record<string, unknown>; allow: string[] } {
    // Claude Code runs hook commands in bash (Git Bash on Windows), where curl is always present.
    const post = (timeout: number) => ({
      type: "command",
      command: `curl -fsS -m ${timeout} -X POST -H 'Content-Type: application/json' --data-binary @- '${hookUrl}' || { echo 'sikeoop hook 超时或不可用，拒绝执行' >&2; exit 2; }`,
      timeout: timeout + 5,
    });
    const quick = [{ hooks: [post(5)] }];
    return {
      hooks: {
        UserPromptSubmit: quick,
        PreToolUse: [{ matcher: "*", hooks: [post(5)] }],
        Notification: quick,
        Stop: quick,
        PermissionRequest: [{ matcher: "*", hooks: [post(Math.ceil(ASK_TIMEOUT_MS / 1000) + 5)] }],
      },
      allow: ["mcp__sikeoop__list_peers", "mcp__sikeoop__send_to"],
    };
  }

  /** Codex's -c overrides: the bridge as an MCP server, who it is, and `notify` for finished turns. */
  codexArgs(reg: ReturnType<PeerBus["register"]>, roots?: string[]): string[] {
    const toml = (v: unknown) => JSON.stringify(v);
    const hook = reg.hookUrl;
    return [
      // One inline table, not a -c per field: Codex's side threads (title generation) apply the
      // overrides one by one and reject a server that has env but no command yet.
      "-c", `mcp_servers.sikeoop={ command = ${toml(reg.bridge.command)}, args = ${toml(reg.bridge.args)}, env = { ELECTRON_RUN_AS_NODE = "1" } }`,
      "-c", `developer_instructions=${toml(peerPrompt(reg.name, roots))}`,
      // Codex appends the event JSON as the last argument.
      "-c", `notify=${toml(["curl", "-s", "-m", "5", "-X", "POST", "-H", "Content-Type: application/json", hook, "-d"])}`,
    ];
  }

  // ---- the host: sikeoop's own agent (and through it, WeChat) directing the sessions ----

  /** What every session is doing, for the host agent. */
  hostList(): string {
    const all = [...this.sessions.values()].filter((p) => p.group === null);
    if (!all.length) return "现在没有 Claude Code 或 Codex 会话。可以用 start_agent 开一个。";
    return all.map((p) => `${p.name}（${p.cliName}）· ${STATUS_TEXT[p.status]} · ${p.detail}`).join("\n");
  }

  /** missing: no session of this kind is running (the host may open one). */
  hostFind(name: string): AgentSessionView | { error: string; missing?: AgentCli } {
    const s = this.resolve(null, name);
    return "error" in s ? s : view(s);
  }

  /** The host gives a session a task, as the user would type it. Resolves the name like send_to. */
  hostSend(toName: string, message: string, framing?: { group: string; raw?: boolean }): AgentSessionView | { error: string } {
    const to = framing ? [...this.sessions.values()].find((p) => p.group === framing.group && (p.id === toName || p.name === toName)) ?? { error: "session 成员已退出" } : this.resolve(null, toName);
    if ("error" in to) return to;
    if (to.status === "starting") return { error: `${to.name} 还在启动，稍等再发` };
    // The host speaks for the user: the agent-to-agent chain starts over.
    to.hops = 0;
    const text = framing?.raw ? message : hostFraming(message);
    this.deliver(to.id, text, "收到 sikeoop 的任务");
    return view(to);
  }

  /** Resolves with the session's last reply when its current turn ends, or null on timeout / abort / exit. */
  waitTurn(id: string, ms: number, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.sessions.has(id) || signal.aborted) return resolve(null);
      let set = this.turnWaiters.get(id);
      if (!set) this.turnWaiters.set(id, (set = new Set()));
      const done = (v: string | null) => {
        clearTimeout(timer);
        clearInterval(gone);
        signal.removeEventListener("abort", onAbort);
        set!.delete(w);
        resolve(v);
      };
      const w = (last: string) => done(last);
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), ms);
      // The tab closed: nothing more will come.
      const gone = setInterval(() => !this.sessions.has(id) && done(null), 2000);
      set.add(w);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A session of `cli` registered after `known` and done starting, or null after `ms`. */
  async waitStarted(cli: AgentCliId, known: Set<string>, ms: number, signal: AbortSignal): Promise<AgentSessionView | null> {
    const end = Date.now() + ms;
    while (Date.now() < end && !signal.aborted) {
      const s = [...this.sessions.values()].find((p) => p.cli === cli && !known.has(p.id));
      if (s && s.group === null && s.status !== "starting") return view(s);
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  sessionIds(): Set<string> {
    return new Set(this.sessions.keys());
  }

  // ---- internals ----

  private byTab(tab: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.tab === tab);
  }

  private byToken(token: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.token === token);
  }

  private set(s: Session, status: Session["status"], detail: string): void {
    if (s.status !== status) s.since = Date.now();
    s.status = status;
    s.detail = detail.slice(0, 60);
    this.changed();
  }

  private changed(): void {
    this.opts.onChange(this.sessionsView());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = req.url?.match(/^\/(rpc|hook)\/([0-9a-f]+)$/);
    const s = m && req.method === "POST" ? this.byToken(m[2]) : undefined;
    if (!m || !s) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return void res.writeHead(413).end();
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return void res.writeHead(400).end();
    }
    const out = m[1] === "rpc" ? await this.rpc(s, msg) : await this.hook(s, msg);
    res.writeHead(200, { "Content-Type": "application/json" }).end(out === null ? "" : JSON.stringify(out));
  }

  /** An extension CLI went quiet: it finished starting, or finished a turn. */
  private async wentQuiet(s: Session, tail: string): Promise<void> {
    if (!this.sessions.has(s.id)) return;
    if (s.status === "starting") return this.set(s, "idle", "准备好了");
    // Its last screen stands in for the reply it can't hand over.
    await this.hook(s, { hook_event_name: "Stop", last_assistant_message: tail });
  }

  /** Claude Code hook events, Codex notify events, and an extension CLI's events (cli-agents/protocol.ts). */
  private async hook(s: Session, body: Record<string, unknown>): Promise<unknown> {
    const neutral = fromNeutral(body);
    if (neutral) return toNeutral(await this.hook(s, neutral));
    const e = body;
    const event = String(e.hook_event_name ?? e.type ?? "");
    if (event === "Ready") {
      if (s.status === "starting") this.set(s, "idle", "准备好了");
    } else if (event === "SessionStart" || event === "UserPromptSubmit") {
      this.settled(s);
      this.set(s, "working", "正在思考");
    }
    else if (event === "PreToolUse") {
      this.set(s, "working", toolLine(String(e.tool_name ?? ""), e.tool_input));
      let reason: string | void = undefined;
      try {
        if (s.group) reason = await this.opts.onSessionEvent?.({ group: s.group, peerId: s.id, tab: s.tab, kind: "preToolUse", input: e });
        if (!reason && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(String(e.tool_name))) {
          const i = (e.tool_input ?? {}) as Record<string, unknown>;
          const file = i.file_path ?? i.notebook_path ?? i.path;
          if (typeof file !== "string" || !file) reason = "文件工具缺少路径，拒绝执行";
          else if ((reason = (await this.opts.guardWrite?.(s.id, path.resolve(String(e.cwd ?? process.cwd()), file))) || undefined)) {
            // Refused by the job's file ownership.
          } else {
            const lock = await this.locks.acquire(s.id, [path.resolve(String(e.cwd ?? process.cwd()), file)]);
            if (!lock.ok) {
              reason = `文件被其他 AI 锁定：${lock.path}`;
              if (s.group) await this.opts.onSessionEvent?.({ group: s.group, peerId: s.id, tab: s.tab, kind: "preToolUse", input: { ...e, lockDenied: lock.path } });
            }
          }
        }
      } catch { reason = "安全检查失败，拒绝执行"; }
      if (reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    }
    else if (event === "Notification") {
      const text = String(e.message ?? "在等你");
      this.opts.onLimitText?.(view(s), text);
      // "waiting for your input" after a long idle is not worth a ping when it already said done.
      if (s.status !== "idle") {
        this.set(s, "waiting", text);
        this.opts.onNotice("waiting", view(s), text);
      }
    } else if (event === "Stop" || event === "agent-turn-complete") {
      const full = String(e["last-assistant-message"] ?? e.last_assistant_message ?? "").trim() || (await lastClaudeReply(e.transcript_path));
      this.settled(s);
      this.locks.release(s.id);
      if (s.group) await this.opts.onSessionEvent?.({ group: s.group, peerId: s.id, tab: s.tab, kind: "stop", text: full });
      const waiters = this.turnWaiters.get(s.id);
      this.turnWaiters.delete(s.id);
      for (const w of waiters ?? []) w(full);
      this.opts.onLimitText?.(view(s), full);
      const last = full.replace(/\s+/g, " ").trim();
      this.set(s, "idle", last ? last.slice(0, 60) : "这一轮做完了");
      this.opts.onNotice("done", view(s), last.slice(0, 80) || "这一轮做完了");
    } else if (event === "PermissionRequest") {
      this.set(s, "waiting", "等你批准");
      const decision = await this.ask(s, String(e.tool_name ?? ""), e.tool_input);
      if (decision) this.set(s, "working", decision === "allow" ? "已批准，继续干活" : "被拒绝了");
      // No answer on the island: say nothing and Claude Code asks in its terminal as usual.
      return decision
        ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: decision, ...(decision === "deny" ? { message: "用户在灵动岛上拒绝了" } : {}) } } }
        : {};
    }
    return {};
  }

  private ask(s: Session, tool: string, input: unknown): Promise<"allow" | "deny" | null> {
    const id = `peer:${randomBytes(6).toString("hex")}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(id, null), ASK_TIMEOUT_MS);
      this.asks.set(id, { session: s, resolve, timer });
      this.opts.onAsk(id, view(s), `${s.name} 想${tool === "Bash" ? "运行一条命令" : tool.startsWith("mcp__") ? "使用一个工具" : "改文件"}`, toolLine(tool, input));
    });
  }

  /** MCP over JSON-RPC, one message per request (the bridge forwards stdio lines here). */
  private async rpc(s: Session, msg: Record<string, unknown>): Promise<unknown> {
    const id = msg.id;
    const method = String(msg.method ?? "");
    if (id === undefined || id === null) return null; // notifications need no answer
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        if (s.status === "starting") this.set(s, "idle", "准备好了");
        return ok({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sikeoop", version: this.opts.version },
          instructions: peerPrompt(s.name),
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const text = name === "list_peers" ? this.listPeers(s) : name === "send_to" ? await this.sendTo(s, args) : { error: `没有这个工具：${name}` };
        return ok({ content: [{ type: "text", text: typeof text === "string" ? text : text.error }], ...(typeof text === "string" ? {} : { isError: true }) });
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  private listPeers(self: Session): string {
    const others = [...this.sessions.values()].filter((p) => p !== self && p.group === self.group);
    if (!others.length) return "现在只有你一个，sikeoop 里没有其他 AI 会话。";
    return others.map((p) => `${p.name}（${p.cliName}）· ${STATUS_TEXT[p.status]} · ${p.detail}`).join("\n");
  }

  /**
   * The session `to` names: its exact name, or just "claude" / "codex" when only one of that kind
   * is running, or nothing at all when there's a single other session. Saves a list_peers call.
   */
  private resolve(from: Session | null, toName: string): Session | { error: string; missing?: AgentCli } {
    const others = [...this.sessions.values()].filter((p) => p !== from && p.group === (from?.group ?? null));
    const online = `现在在线的：${others.map((p) => p.name).join("、") || "没有别的会话"}`;
    const key = toName.toLowerCase().replace(/[\s_-]+/g, "");
    if (key && from && key === from.name.toLowerCase().replace(/-/g, "")) return { error: "不能发给自己" };
    const exact = others.find((p) => p.name.toLowerCase().replace(/-/g, "") === key);
    if (exact) return exact;
    // A numbered name that isn't online (Claude-3) must not quietly reach Claude-1.
    if (/\d/.test(key)) return { error: `没有叫「${toName}」的会话。${online}` };
    // An extension CLI is named by its id, its name or its sessions' prefix ("opencode").
    const extension = others.find((p) => p.extension && [p.cli, p.cliName, p.name.replace(/-\d+$/, "")].some((n) => n.toLowerCase().replace(/[\s_-]+/g, "") === key));
    const kind: AgentCliId | null = !key ? null : extension ? extension.cli : /^(claude|claudecode|克劳德|cc)/.test(key) ? "claude" : /^codex/.test(key) ? "codex" : null;
    if (key && !kind) return { error: `没有叫「${toName}」的会话。${online}` };
    const pool = kind ? others.filter((p) => p.cli === kind) : others;
    if (pool.length === 1) return pool[0];
    const kindName = extension?.cliName ?? (kind === "codex" ? "Codex" : kind ? "Claude Code" : "其他");
    if (pool.length) return { error: `有好几个，用全名指定一个。${online}` };
    return { error: `sikeoop 里没有在线的 ${kindName} 会话。${online}`, ...(!extension && kind ? { missing: kind as AgentCli } : {}) };
  }

  private async sendTo(from: Session, args: Record<string, unknown>): Promise<string | { error: string }> {
    const message = String(args.message ?? "").trim();
    if (!message) return { error: "message 不能是空的" };
    if (message.length > MAX_MESSAGE) return { error: `消息太长（${message.length} 字，上限 ${MAX_MESSAGE}）。代码和日志别贴进来，写文件路径和行号，对方会自己读。` };
    const to = this.resolve(from, String(args.to ?? "").trim());
    if ("error" in to) return to;
    if (from.group) {
      const error = await this.opts.onSessionEvent?.({ group: from.group, peerId: from.id, tab: from.tab, kind: "send", to: to.id, text: message });
      return error ? { error } : `已加入 session 发言队列：${to.name}`;
    }
    if (this.opts.route) {
      const routed = this.opts.route(view(from), view(to), message);
      if (typeof routed === "string") this.opts.onMessage(from.name, to.name, message);
      return routed;
    }
    // A ping-pong between two agents stops here until the user steps in.
    if (to.hops >= MAX_HOPS) return { error: `${to.name} 已经连续收到 ${MAX_HOPS} 条 AI 消息了，等用户确认后再继续。先把情况告诉用户。` };
    to.hops++;
    this.deliver(to.id, peerFraming(from.name, message), `收到 ${from.name} 的消息`);
    this.opts.onMessage(from.name, to.name, message);
    // Said outright so the sender doesn't poll list_peers waiting for the answer.
    return `已送达 ${to.name}。它的回复会作为一条新消息自动出现，不用等，也不用去查。`;
  }
}

/** How a task from sikeoop's own agent reads in the receiving terminal. */
export function hostFraming(message: string, report = false): string {
  return `[sikeoop → 你] ${message}\n（这是 sikeoop 主控转来的用户任务。做完直接结束这一轮，你最后一条回复会自动交回给 sikeoop，不用 send_to 回复。${report ? REPORT_FORMAT : ""}）`;
}

/**
 * What the last reply of a handed-over task should hold. The coordinator reads every word of it
 * (and pays for it), so it is asked to be the report and nothing else.
 */
const REPORT_FORMAT = "最后一条回复只写四项：结果（完成 / 部分完成 / 受阻）、改动文件（路径加一句话）、验证（跑了什么、结果如何）、遗留问题。不贴代码，不复述任务。";

/**
 * How a message from another agent reads in the receiving terminal. autoReply: the dispatch core
 * hands this turn's last reply back to the sender, so it is not written a second time into send_to.
 */
export function peerFraming(from: string, message: string, autoReply = false): string {
  return `[${from} → 你] ${message}\n（${autoReply ? `直接回答：你这一轮最后一条回复会自动送回 ${from}，不用 send_to 回复` : `回复：send_to，to="${from}"`}）`;
}

/** How the answer to an earlier send_to reads back in the sender's terminal. Nothing is sent back for it. */
export function replyFraming(from: string, reply: string): string {
  return `[${from} 的回复 → 你] ${reply}\n（这是你之前发给 ${from} 的消息的回复，不用再回。）`;
}

/** What send_to tells the sender when the dispatch core carries the answer back. */
export function routedText(to: string, queued: boolean): string {
  return `${queued ? `${to} 现在在忙，消息已排队，它空下来就会收到` : `已送达 ${to}`}。它的回复会作为一条新消息自动出现，不用等，也不用去查。`;
}

/** The longest reply carried back: what send_to itself would have let through. */
export const MAX_REPLY = MAX_MESSAGE;

/** The text of Claude Code's last assistant message, from the transcript its Stop hook points at. */
async function lastClaudeReply(transcript: unknown): Promise<string> {
  if (typeof transcript !== "string" || !transcript) return "";
  try {
    const lines = (await fs.readFile(transcript, "utf8")).trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      const e = JSON.parse(lines[i]) as { type?: string; message?: { content?: unknown } };
      if (e.type !== "assistant") continue;
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => String(b.text)).join("\n") : "";
      if (text.trim()) return text.trim();
    }
  } catch {
    // Unreadable transcript: the caller says the turn ended without text.
  }
  return "";
}

const STATUS_TEXT: Record<AgentSessionView["status"], string> = { starting: "正在启动", working: "在干活", waiting: "在等用户", idle: "空闲" };

const view = (s: Session): AgentSessionView => ({ id: s.id, name: s.name, cli: s.cli, status: s.status, detail: s.detail, since: s.since, ...(s.group ? { group: s.group } : {}), ...(s.extension ? { cliName: s.cliName } : {}) });

function toolLine(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const arg = String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? "").replace(/\s+/g, " ");
  const short = tool.startsWith("mcp__") ? tool.split("__").slice(1).join(" · ") : tool;
  return `${short}${arg ? ` · ${arg}` : ""}`.slice(0, 200);
}

const TOOLS = [
  {
    name: "list_peers",
    description: "List the other AI agent sessions (Claude Code / Codex) in sikeoop's terminals and what each is doing. Not needed before send_to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_to",
    description:
      "Message another AI agent in sikeoop's terminals. This is how to reach \"Claude\" or \"Codex\" when the user asks: never a desktop app or computer use. " +
      "It arrives as a new prompt there; the reply comes back to you as a new message on its own. Point at files and lines instead of pasting code.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Session name (Codex-1), or just claude / codex if only one is running. Omit if there is only one other session." },
        message: { type: "string", description: `What to tell or ask it, at most ${MAX_MESSAGE} characters` },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

/** stdio ⇄ HTTP: each JSON-RPC line on stdin is POSTed to the bus; answers go to stdout in order. */
const BRIDGE = `"use strict";
const url = process.argv[2];
let chain = Promise.resolve();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    chain = chain.then(() =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: line })
        .then((r) => r.text())
        .then((t) => { if (t) process.stdout.write(t + "\\n"); })
        .catch((e) => {
          try {
            const id = JSON.parse(line).id;
            if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "sikeoop 没有响应：" + e.message } }) + "\\n");
          } catch {}
        }),
    );
  }
});
process.stdin.on("end", () => chain.then(() => process.exit(0)));
`;
