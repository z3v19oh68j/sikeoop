import { SELF_INPUT_TIMESTAMP } from "./input-origin.ts";
import { EventEmitter } from "node:events";
import { realpath, mkdir } from "node:fs/promises";
import path from "node:path";

export interface DebuggerTransport {
  isAttached(): boolean;
  attach(version?: string): void;
  detach(): void;
  sendCommand(method: string, params?: any, sessionId?: string): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
export class CdpSession extends EventEmitter {
  private transport: DebuggerTransport;
  actionSignal?: () => AbortSignal | undefined;
  beforeCommand?: (method: string, params?: any) => Promise<void>;
  private ready: Promise<void> | null = null;
  private disposed = false;
  private generation = 0;
  private cancel = new Set<(error: Error) => void>();
  private requests = new Set<string>();
  private changed = Date.now();
  private timeout: number;
  private frames = new Map<string, string>();
  private children = new Set<string>();
  private initializing = new Map<string, Promise<void>>();
  private downloadBehavior: any = { behavior: "deny" };
  private history: any[] = [];
  private downloads = new Map<string, any>();
  private downloadDir: string | undefined;
  sessionIds(): string[] { return [...this.children]; }
  frameSession(frameId: string): string | undefined { return this.frames.get(frameId); }
  frameIdForSession(sessionId: string): string | undefined { return [...this.frames].find(([, id]) => id === sessionId)?.[0]; }
  private message = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      const id = params.sessionId;
      const initialization = this.initialize(id).then(() => {
        if (!this.initializing.has(id)) return;
        this.children.add(id);
        this.emit("framesChanged");
      });
      this.initializing.set(id, initialization);
      void initialization.catch(() => {
        this.initializing.delete(id);
        this.children.delete(id);
        for (const [frame, child] of this.frames) if (child === id) this.frames.delete(frame);
        this.emit("framesChanged");
      });
    }
    if (method === "Target.detachedFromTarget") {
      const id = params.sessionId;
      this.children.delete(id);
      this.initializing.delete(id);
      for (const [frame, child] of this.frames) if (child === id) this.frames.delete(frame);
      for (const request of this.requests) if (request.startsWith(`${id}:`)) this.requests.delete(request);
      this.emit("framesChanged");
    }
    const requestKey = `${sessionId ?? ""}:${params.requestId}`;
    if (method === "Network.requestWillBeSent") {
      this.requests.add(requestKey);
      this.history.push({ requestId: params.requestId, sessionId, url: safeUrl(params.request?.url), method: params.request?.method,
        type: params.type, requestHeaders: safeHeaders(params.request?.headers), timestamp: params.timestamp });
      if (this.history.length > 200) this.history.shift();
    }
    if (method === "Network.responseReceived") {
      const record = [...this.history].reverse().find(r => r.requestId === params.requestId && r.sessionId === sessionId);
      if (record) Object.assign(record, { status: params.response?.status, mimeType: params.response?.mimeType, responseHeaders: safeHeaders(params.response?.headers) });
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      this.requests.delete(requestKey);
      const record = [...this.history].reverse().find(r => r.requestId === params.requestId && r.sessionId === sessionId);
      if (record) Object.assign(record, { finished: true, failed: method === "Network.loadingFailed", bytes: params.encodedDataLength });
    }
    if (method === "Browser.downloadWillBegin" && this.downloadDir && typeof params.guid === "string") {
      const suggested = String(params.suggestedFilename ?? "");
      const basename = path.basename(suggested.replace(/\\/g, "/"));
      const filename = !basename || basename === "." || basename === ".." || /[\x00-\x1f]/.test(basename) ? "download" : basename;
      this.downloads.set(params.guid, { guid: params.guid, filename, expectedPath: path.join(this.downloadDir, filename), url: safeUrl(params.url), state: "inProgress", receivedBytes: 0 });
    }
    if (method === "Browser.downloadProgress") {
      const record = this.downloads.get(params.guid);
      if (record) Object.assign(record, { state: params.state, receivedBytes: params.receivedBytes, totalBytes: params.totalBytes });
    }
    if (method === "Page.frameNavigated" && !params.frame?.parentId) {
      if (sessionId) { this.frames.set(params.frame.id, sessionId); this.emit("framesChanged"); }
      else this.emit("document");
    }
    if (method === "DOM.documentUpdated") {
      this.emit(sessionId ? "framesChanged" : "document");
      void this.raw("DOM.getDocument", { depth: -1, pierce: true }, sessionId).catch(() => {});
    }
    if (method.startsWith("DOM.") || method.startsWith("Network.") || method.startsWith("Page.")) this.changed = Date.now();
    this.emit("event", method, params, sessionId);
    this.emit("activity");
  };
  networkSummary(limit = 50): any[] {
    return structuredClone(this.history.slice(-Math.max(1, Math.min(200, Math.floor(limit) || 50))));
  }
  downloadSummary(): any[] { return structuredClone([...this.downloads.values()]); }
  async denyDownloads(): Promise<void> {
    this.downloadBehavior = { behavior: "deny" };
    await this.send("Browser.setDownloadBehavior", this.downloadBehavior);
    this.downloadDir = undefined;
    this.downloads.clear();
  }
  async configureDownloads(projectRoot: string): Promise<string> {
    const root = await realpath(projectRoot);
    const internal = path.join(root, ".sikeoop");
    await mkdir(internal, { recursive: true });
    const realInternal = await realpath(internal);
    if (!within(root, realInternal)) throw new Error("下载目录不在当前项目内");
    const directory = path.join(realInternal, "downloads");
    await mkdir(directory, { recursive: true });
    const realDirectory = await realpath(directory);
    if (!within(root, realDirectory)) throw new Error("下载目录不在当前项目内");
    const behavior = { behavior: "allow", downloadPath: realDirectory, eventsEnabled: true };
    await this.send("Browser.setDownloadBehavior", behavior);
    this.downloadBehavior = behavior;
    if (this.downloadDir !== realDirectory) this.downloads.clear();
    this.downloadDir = realDirectory;
    return realDirectory;
  }
  private async initialize(sessionId?: string): Promise<void> {
    for (const domain of ["Page", "DOM", "Accessibility", "Runtime", "Network"]) await this.raw(`${domain}.enable`, undefined, sessionId);
    await this.raw("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    await this.raw("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
    if (sessionId) {
      const tree = await this.raw("Page.getFrameTree", {}, sessionId);
      if (tree.frameTree?.frame?.id && this.initializing.has(sessionId)) this.frames.set(tree.frameTree.frame.id, sessionId);
    }
    await this.raw("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  }
  private detached = () => {
    this.generation++;
    this.ready = null;
    this.requests.clear();
    this.frames.clear();
    this.children.clear();
    this.initializing.clear();
    this.emit("disconnected");
    this.emit("framesChanged");
    for (const cancel of this.cancel) cancel(new Error("CDP 会话已断开"));
    this.emit("document");
    this.emit("activity");
  };
  constructor(transport: DebuggerTransport, timeout = 5000) {
    super();
    this.transport = transport;
    this.timeout = timeout;
    transport.on("message", this.message);
    transport.on("detach", this.detached);
  }
  async connect(): Promise<void> {
    if (this.disposed) throw new Error("CDP 会话已关闭");
    if (!this.ready) {
      const generation = this.generation;
      this.ready = (async () => {
        if (!this.transport.isAttached()) this.transport.attach("1.3");
        await this.initialize();
        await this.raw("Browser.setDownloadBehavior", this.downloadBehavior);
        if (generation !== this.generation) throw new Error("CDP 会话已断开");
      })().catch((error) => { this.ready = null; throw error; });
    }
    await this.ready;
  }
  private raw(method: string, params?: any, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); this.cancel.delete(fail); reject(error); };
      const timer = setTimeout(() => fail(new Error(`CDP 命令超时：${method}`)), this.timeout);
      this.cancel.add(fail);
      Promise.resolve().then(() => this.transport.sendCommand(method, params, sessionId)).then((result) => {
        clearTimeout(timer); this.cancel.delete(fail); resolve(result);
      }, fail);
    });
  }
  async send(method: string, params?: any, sessionId?: string): Promise<any> {
    await this.beforeCommand?.(method, params);
    if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent") params = { ...params, timestamp: SELF_INPUT_TIMESTAMP };
    await this.connect();
    if (sessionId) {
      const initialization = this.initializing.get(sessionId);
      if (initialization) await initialization;
      if (!this.children.has(sessionId)) throw new Error("CDP 子会话已断开");
    }
    return this.raw(method, params, sessionId);
  }
  /** Start before dispatching input, so synchronous network/DOM events are not lost. */
  beginAction(): void { this.changed = Date.now(); }
  async waitForIdle(timeout = 3000, quiet = 80): Promise<void> {
    await this.connect();
    const signal = this.actionSignal?.();
    if (signal?.aborted) throw new Error("Browser action cancelled.");
    return new Promise((resolve, reject) => {
      let wake: ReturnType<typeof setTimeout>;
      const end = (error?: Error) => {
        clearTimeout(wake); clearTimeout(deadline); this.off("activity", check); signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const check = () => {
        clearTimeout(wake);
        if (this.disposed || !this.transport.isAttached()) return end(new Error("CDP 会话已断开"));
        const left = quiet - (Date.now() - this.changed);
        if (!this.requests.size && left <= 0) return end();
        if (!this.requests.size) wake = setTimeout(check, Math.max(1, left));
      };
      const abort = () => end(new Error("Browser action cancelled."));
      signal?.addEventListener("abort", abort, {once:true});
      const deadline = setTimeout(() => end(new Error("等待页面空闲超时")), timeout);
      this.on("activity", check); check();
    });
  }
  invalidate(): void { this.detached(); }
  dispose(): void {
    this.disposed = true;
    this.transport.removeListener("message", this.message);
    this.transport.removeListener("detach", this.detached);
    this.detached();
    if (this.transport.isAttached()) this.transport.detach();
    this.removeAllListeners();
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function safeUrl(value: unknown): string {
  try { const url = new URL(String(value)); if (url.protocol !== "http:" && url.protocol !== "https:") return "[redacted URL]"; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
  catch { return "[invalid URL]"; }
}
function safeHeaders(headers: any): Record<string, string> {
  const safe: Record<string, string> = {};
  const allowed = new Set(["content-type", "content-length", "accept", "accept-language", "cache-control", "expires", "last-modified"]);
  for (const [name, value] of Object.entries(headers ?? {})) if (allowed.has(name.toLowerCase())) safe[name.toLowerCase()] = String(value);
  return safe;
}
