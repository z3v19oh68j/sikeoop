import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentPermissionCard, DispatchProgress } from "../../shared/types.ts";
import { object, parseAcpLine, permissionCard, permissionOutcome, updateProgress, type RpcId, type RpcMessage } from "./acp-protocol.ts";

const MAX_FRAME = 1024 * 1024;
export interface AcpOptions {
  cwd: string;
  bin?: string;
  /** Test injection only; production always uses ["acp"], without a shell. */
  args?: string[];
  model?: string;
  readOnly?: boolean;
  requestTimeoutMs?: number;
  permissionTimeoutMs?: number;
  cancelGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  permission(card: AgentPermissionCard, signal: AbortSignal): Promise<string | null>;
  progress(progress: DispatchProgress): void;
}
/** Only OS/runtime variables; tools use their own disk-based login, not sikeoop's provider keys. */
export function acpEnvironment(source: NodeJS.ProcessEnv, model?: string, readOnly = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...(model ? { model } : {}), permission: "ask", plugin: [], ...(readOnly ? { default_agent: "plan" } : {}) });
  return env;
}

/** A single task owns a single child/session. No multiplexing or hidden session resumption in batch 1. */
export class AcpConnector {
  private readonly opts: AcpOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private buffer = "";
  private failure: Error | null = null;
  private busy = false;
  private closed = false;
  private sessionId = "";
  private pending = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }>();
  private permissions = new Set<AbortController>();
  private childClosed: Promise<void> = Promise.resolve();
  constructor(opts: AcpOptions) { this.opts = opts; }
  ready(): boolean { return !this.busy && !this.closed; }
  alive(): boolean { return !this.closed; }
  pid(): number | undefined { return this.child?.pid; }
  close(): void { this.closed = true; this.fail(Error("ACP connector closed")); this.child?.kill("SIGTERM"); }

  async run(jobId: string, text: string, signal: AbortSignal): Promise<{ text: string; outcome: string }> {
    if (!this.ready()) throw Error("ACP connector unavailable");
    if (signal.aborted) throw Error("ACP task cancelled");
    this.busy = true;
    let output = "";
    let cancelTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      for (const c of this.permissions) c.abort();
      if (this.sessionId && !this.failure) this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
      cancelTimer = setTimeout(() => this.fail(Error("ACP cancellation grace expired")), this.opts.cancelGraceMs ?? 1500);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.start((message) => {
        const progress = updateProgress(message, this.sessionId);
        if (progress) {
          if (progress.type === "text") output = (output + (progress.text ?? "")).slice(-256000);
          this.opts.progress(progress);
        }
        if (message.method && message.id !== undefined) void this.handleRequest(message, jobId, signal);
      });
      const initialized = await this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "sikeoop", version: "1" } });
      if (!object(initialized) || initialized.protocolVersion !== 1) throw Error("ACP incompatible protocolVersion");
      if (signal.aborted) throw Error("ACP task cancelled during initialize");
      const session = await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] });
      if (!object(session) || typeof session.sessionId !== "string" || !session.sessionId) throw Error("ACP missing sessionId");
      this.sessionId = session.sessionId;
      if (signal.aborted) throw Error("ACP task cancelled during session/new");
      if (this.opts.readOnly) {
        // Fail closed if the agent cannot confirm plan mode, never silently use build.
        await this.request("session/set_mode", { sessionId: this.sessionId, modeId: "plan" });
      }
      if (signal.aborted) throw Error("ACP task cancelled before prompt");
      this.opts.progress({ type: "status", at: Date.now(), text: "running" });
      const result = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, false);
      if (!object(result) || typeof result.stopReason !== "string") throw Error("ACP missing stopReason");
      this.opts.progress({ type: "status", at: Date.now(), text: result.stopReason });
      return { text: output, outcome: result.stopReason };
    } finally {
      signal.removeEventListener("abort", abort);
      if (cancelTimer) clearTimeout(cancelTimer);
      for (const c of this.permissions) c.abort();
      // A cancelled task resolves only after its child has really exited. Success also releases it.
      await this.stop();
      this.busy = false;
      this.closed = true;
    }
  }

  private start(onMessage: (m: RpcMessage) => void): void {
    const child = spawn(this.opts.bin ?? "opencode", this.opts.args ?? ["acp"], {
      cwd: this.opts.cwd, env: acpEnvironment(this.opts.env ?? process.env, this.opts.model, this.opts.readOnly), stdio: "pipe", shell: false,
    });
    this.child = child;
    this.childClosed = new Promise(resolve => child.once("close", () => resolve()));
    child.on("error", e => this.fail(e));
    child.on("exit", (code, sig) => this.fail(Error(`ACP child exited (${code ?? sig})`)));
    child.stdout.on("end", () => this.fail(Error("ACP stdout disconnected")));
    child.stdout.on("error", e => this.fail(e));
    child.stdin.on("error", e => this.fail(e));
    // Drain stderr, but do not log it: tools may print credentials or private context.
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      try {
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > MAX_FRAME) throw Error("ACP frame too large");
          if (!line.trim()) continue;
          const m = parseAcpLine(line);
          if (m.method) onMessage(m);
          else if (m.id !== undefined) {
            const wait = this.pending.get(m.id);
            if (!wait) continue;
            this.pending.delete(m.id); if (wait.timer) clearTimeout(wait.timer);
            if (m.error) wait.reject(Error(`ACP RPC error: ${m.error.message}`)); else wait.resolve(m.result);
          }
        }
        if (Buffer.byteLength(this.buffer) > MAX_FRAME) throw Error("ACP frame too large");
      } catch (e) { this.fail(e instanceof Error ? e : Error(String(e))); }
    });
  }
  private send(m: RpcMessage): void {
    if (this.failure || !this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(m) + "\n", e => { if (e) this.fail(e); });
  }
  private request(method: string, params: Record<string, unknown>, timed = true): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timed ? setTimeout(() => this.fail(Error(`ACP ${method} timed out`)), this.opts.requestTimeoutMs ?? 15000) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private async handleRequest(m: RpcMessage, jobId: string, signal: AbortSignal): Promise<void> {
    if (m.method !== "session/request_permission") {
      this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Client method not supported" } }); return;
    }
    let card: AgentPermissionCard;
    try {
      card = permissionCard(m, jobId, `acp:${randomUUID()}`);
      if (card.sessionId !== this.sessionId) throw Error("ACP permission session mismatch");
    } catch {
      this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Invalid permission request" } }); return;
    }
    const controller = new AbortController(); this.permissions.add(controller);
    let timer: NodeJS.Timeout | undefined;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let selected: string | null = null;
    try {
      if (signal.aborted || this.failure) controller.abort();
      this.opts.progress({ type: "permission", at: Date.now(), permission: card });
      selected = await new Promise<string | null>(resolve => {
        controller.signal.addEventListener("abort", () => resolve(null), { once: true });
        if (controller.signal.aborted) return resolve(null);
        timer = setTimeout(() => controller.abort(), this.opts.permissionTimeoutMs ?? 100000);
        Promise.resolve().then(() => this.opts.permission(card, controller.signal)).then(resolve, () => resolve(null));
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort(); this.permissions.delete(controller);
    }
    this.send({ jsonrpc: "2.0", id: m.id, result: permissionOutcome(card, signal.aborted ? null : selected) });
    if (!signal.aborted && !this.failure) this.opts.progress({ type: "status", at: Date.now(), text: "running" });
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const c of this.permissions) c.abort();
  }
  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.fail(Error("ACP task ended"));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), this.opts.cancelGraceMs ?? 1500);
    await this.childClosed;
    clearTimeout(timer);
  }
}
