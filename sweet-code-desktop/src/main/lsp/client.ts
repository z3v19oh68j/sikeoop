import { type ChildProcess, spawn } from "node:child_process";

// A small Language Server Protocol client: JSON-RPC over the server's stdin/stdout with
// Content-Length framing. The server runs as a plain Node process from Electron's own binary.

type Handler = (params: unknown) => unknown;

export class LspClient {
  private proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private buffer = Buffer.alloc(0);
  private readonly notificationHandlers = new Map<string, Handler>();
  private readonly requestHandlers = new Map<string, Handler>();
  private exited = false;

  constructor(
    script: string,
    args: string[],
    opts: { cwd: string; onExit(code: number | null, stderr: string): void },
  ) {
    let stderr = "";
    this.proc = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // Keep the tail for error messages; the server logs a lot.
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error("语言服务器已退出"));
      this.pending.clear();
      opts.onExit(code, stderr);
    });
    this.proc.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  onNotification(method: string, handler: Handler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Requests the server sends to the client (configuration, registrations…). */
  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.exited) return Promise.reject(new Error("语言服务器没有在运行"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new Error("已取消"));
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.send({ jsonrpc: "2.0", method, params });
  }

  kill(): void {
    if (this.exited) return;
    this.proc.kill();
  }

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin!.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
      if (!Number.isFinite(length)) {
        // Not a frame header: drop up to it and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // A malformed message is skipped, not fatal.
      }
    }
  }

  private dispatch(msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (msg.method && msg.id !== undefined) {
      // A request from the server: answer it, with null when we have nothing to say.
      const handler = this.requestHandlers.get(msg.method);
      Promise.resolve()
        .then(() => (handler ? handler(msg.params) : null))
        .then(
          (result) => this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
          (err: Error) => this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } }),
        );
      return;
    }
    if (msg.method) {
      this.notificationHandlers.get(msg.method)?.(msg.params);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
}
