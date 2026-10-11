import { BrowserFlowRecording } from "./recording.ts";
import { BrowserFlowStore, flowName, replayFlow } from "./flows.ts";
import { CdpRecorder } from "./cdp/recorder.ts";
import { executeFlowAction, type FlowApprove } from "./flow-actions.ts";
import type { BrowserFlow, BrowserFlowSelector, BrowserFlowRecordingOptions, BrowserFlowRunOptions } from "../../shared/types.ts";
import { getRoot, hasRoot } from "../workspace.ts";
import { projectUploadFiles } from "./files.ts";
import { CdpSession } from "./cdp/session.ts";
import { CdpPage } from "./cdp/page.ts";
import { CdpExperience } from "./cdp/experience.ts";
import { BrowserAutomation } from "./automation.ts";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type WebContents, safeStorage, session } from "electron";
import type { BrowserHistoryItem, BrowserLogin, BrowserSettings, BrowserState } from "@shared/types";

// The built-in browser: a <webview> in the renderer (BrowserPane.tsx) with its own persistent
// session, so cookies, local storage and logins survive restarts. This side keeps:
//   - the visit history (browser/history.json);
//   - saved logins (browser/logins.json), each password encrypted with the system keychain
//     (safeStorage). A password only ever travels page → here (offered at submit) and here → page
//     (filled when the user picks it); the renderer UI and the agent never receive one;
//   - the console of the page, for the agent;
//   - CDP snapshots and real input events on this webview only.

export const PARTITION = "persist:sikeoop-browser";
const MAX_HISTORY = 5000;
const MAX_CONSOLE = 200;

const ENGINES: Record<BrowserSettings["engine"], string> = {
  bing: "https://cn.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  google: "https://www.google.com/search?q=",
};

interface StoredLogin {
  id: string;
  origin: string;
  username: string;
  /** base64 of safeStorage.encryptString(password) */
  secret: string;
  updatedAt: number;
}

export interface ConsoleLine {
  level: "log" | "info" | "warning" | "error";
  text: string;
  source: string;
  at: number;
}

/** localhost, 127.x, ::1, *.localhost, 0.0.0.0, and file: pages: the user's own work. */
export function isLocal(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return true;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export class BrowserService {
  private flows = new BrowserFlowStore(getRoot);
  private recording: {root:string;flow:BrowserFlow;buffer:BrowserFlowRecording;recorder:CdpRecorder;values:"record"|"parameterize";error?:string;stopping?:boolean} | null = null;
  private flowProject: string | null = null;
  private flowApprove: FlowApprove = async () => { throw new Error("浏览器脚本审批未接入"); };
  private flowHeal?: (selector:BrowserFlowSelector,snapshot:string,signal?:AbortSignal)=>Promise<BrowserFlowSelector>;
  configureFlows(approve:FlowApprove, heal:(selector:BrowserFlowSelector,snapshot:string,signal?:AbortSignal)=>Promise<BrowserFlowSelector>):void { this.flowApprove=approve;this.flowHeal=heal; }
  private checkFlowProject():void { if(this.flowProject && (!hasRoot() || getRoot()!==this.flowProject)) throw new Error("当前项目已切换，浏览器脚本已停止"); }
  private wc: WebContents | null = null;
  private experience: CdpExperience | null = null;
  private sequence: BrowserAutomation;
  private batchRunning = false;
  private cdp: CdpSession | null = null;
  private automation: CdpPage | null = null;
  private downloadRoot: string | null | undefined = undefined;
  private downloadSetup: Promise<void> | null = null;
  private waiting: ((wc: WebContents) => void)[] = [];
  private consoleLines: ConsoleLine[] = [];
  private consoleRead = 0;
  private history: BrowserHistoryItem[] | null = null;
  private logins: StoredLogin[] | null = null;
  private settings: BrowserSettings = { engine: "bing", automationSpeed: "normal" };
  /** What the page offered at its last submit, until the user says save or not. Never sent anywhere. */
  private offered: { origin: string; username: string; password: string } | null = null;
  private loginFormOn: string | null = null;

  private readonly dir: string;
  private readonly notify: (channel: string, payload?: unknown) => void;

  constructor(
    dir: string,
    /** Tell the renderer: open the browser tab, a page offers a login to save, a login form appeared… */
    notify: (channel: string, payload?: unknown) => void,
  ) { this.dir = dir; this.notify = notify; this.sequence = new BrowserAutomation(state => this.notify("browser:automation", state)); }

  // ---- the page ----------------------------------------------------------------------

  /** The <webview>'s page attached (did-attach-webview); only this one is listened to. */
  attach(wc: WebContents): void {
    if (this.wc) this.sequence.stop();
    this.cancelRecording();
    this.experience?.dispose();
    this.cdp?.dispose();
    this.wc = wc;
    const cdp = this.cdp = new CdpSession(wc.debugger);
    this.automation = new CdpPage(cdp);
    this.automation.checkpoint = () => this.sequence.checkpoint();
    cdp.actionSignal = () => this.sequence.actionSignal();
    const experience = this.experience = new CdpExperience(cdp, () => this.sequence.userInput(), reason => this.sequence.pause("error", reason));
    cdp.beforeCommand = async (method, params) => {
      this.checkFlowProject();
      // Complete release halves even during takeover: never leave a key/button held down.
      if ((method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') || (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp')) return;
      if (method.startsWith('Input.') || method === 'Runtime.callFunctionOn' || method === 'DOM.setFileInputFiles' || (method === 'Runtime.evaluate' && params?.expression?.startsWith('scrollBy('))) await this.sequence.checkpoint();
    };
    this.automation.beforeVisual = async (kind, point, box) => {
      await this.sequence.checkpoint();
      await experience.visual(this.settings.automationSpeed ?? 'normal', kind, point, box);
      await this.sequence.checkpoint();
    };
    this.downloadRoot = undefined;
    this.downloadSetup = null;
    void this.prepareDownloads().catch(() => { void cdp.denyDownloads().catch(() => {}); });
    wc.on("render-process-gone", () => { if (this.wc === wc) { this.sequence.stop(); this.cancelRecording(); cdp.invalidate(); } });
    wc.on("did-finish-load", () => { if (this.wc === wc) void cdp.connect().catch(() => {}); });
    this.loginFormOn = null;
    wc.setWindowOpenHandler(({ url }) => {
      // New windows open in the same tab: one place to look.
      if (/^https?:|^file:/.test(url)) void wc.loadURL(url);
      return { action: "deny" };
    });
    wc.on("console-message", (details: unknown, ...legacy: unknown[]) => {
      // Electron passes an object (new) or (event, level, message, line, sourceId) (old).
      const d = details as { level?: string | number; message?: string; sourceId?: string; lineNumber?: number };
      const levelRaw = d.level ?? legacy[0];
      const level = typeof levelRaw === "number" ? (["log", "info", "warning", "error"] as const)[levelRaw] ?? "log" : (levelRaw as ConsoleLine["level"]) ?? "log";
      const text = String(d.message ?? legacy[1] ?? "");
      const source = `${d.sourceId ?? legacy[3] ?? ""}:${d.lineNumber ?? legacy[2] ?? ""}`;
      this.consoleLines.push({ level, text: text.slice(0, 2000), source, at: Date.now() });
      if (this.consoleLines.length > MAX_CONSOLE) {
        this.consoleLines.shift();
        this.consoleRead = Math.max(0, this.consoleRead - 1);
      }
    });
    const record = () => void this.recordVisit(wc.getURL(), wc.getTitle());
    const flowNavigate = () => { if(this.recording)this.recordFlowStep({action:"navigate",url:wc.getURL()}); };
    wc.on("did-navigate", () => {
      this.consoleLines = [];
      this.consoleRead = 0;
      record(); flowNavigate();
    });
    wc.on("did-navigate-in-page", () => {record();flowNavigate();});
    wc.on("page-title-updated", record);
    wc.on("destroyed", () => {
      if (this.wc === wc) { this.sequence.stop(); this.cancelRecording(); experience.dispose(); this.experience = null; cdp.dispose(); this.wc = null; this.cdp = null; this.automation = null; }
    });
    for (const w of this.waiting.splice(0)) w(wc);
  }

  /** Messages from the page's preload: replies to the agent, login forms, offered logins. */
  fromPage(sender: WebContents, channel: string, payload: unknown): void {
    if (sender !== this.wc) return;
    if (channel === "login-form") {
      const { origin, present } = payload as { origin: string; present: boolean };
      this.loginFormOn = present ? origin : null;
      void this.loginsFor(origin).then((list) => this.notify("browser:login-form", { origin, present, logins: present ? list : [] }));
    } else if (channel === "credential") {
      const c = payload as { origin: string; username: string; password: string };
      if (!c.password || typeof c.password !== "string") return;
      void this.loadLogins().then((all) => {
        const same = all.find((l) => l.origin === c.origin && l.username === c.username);
        // Already saved with this very password: nothing to ask.
        if (same && safeStorage.isEncryptionAvailable() && safeStorage.decryptString(Buffer.from(same.secret, "base64")) === c.password) return;
        this.offered = { origin: c.origin, username: c.username.slice(0, 200), password: c.password.slice(0, 500) };
        this.notify("browser:offer-login", { origin: c.origin, username: this.offered.username, update: !!same });
      });
    }
  }

  /** The page, opening the browser tab first if needed. */
  async page(): Promise<WebContents> {
    if (this.wc && !this.wc.isDestroyed()) {
      await this.prepareDownloads();
      return this.wc;
    }
    this.notify("browser:open");
    const wc = await new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("浏览器没能打开")), 10_000);
      this.waiting.push((wc) => (clearTimeout(timer), resolve(wc)));
    });
    await this.prepareDownloads();
    return wc;
  }

  /** An address, or words to search for with the chosen engine. */
  toUrl(input: string): string {
    const s = input.trim();
    if (/^(https?|file):\/\//i.test(s)) return s;
    if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) && !/\s/.test(s)) return `https://${s}`;
    return ENGINES[this.settings.engine] + encodeURIComponent(s);
  }

  searchUrl(query: string): string {
    return ENGINES[this.settings.engine] + encodeURIComponent(query);
  }

  /** Load an address and wait for event-driven page quiet. */
  async open(url: string): Promise<{ url: string; title: string }> {
    const wc = await this.page();
    await this.cdp!.connect();
    this.cdp!.beginAction();
    await this.sequence.checkpoint();this.checkFlowProject();
    await wc.loadURL(url);
    await this.settle(wc);
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  current(): { url: string; title: string } | null {
    const wc = this.wc;
    return wc && !wc.isDestroyed() ? { url: wc.getURL(), title: wc.getTitle() } : null;
  }

  private async settle(_wc: WebContents): Promise<void> {
    await this.cdp!.waitForIdle();
  }

  async snapshot(opts: { scope?: number; diff?: boolean } = {}): Promise<string> {
    const wc = await this.page();
    return `Page: ${wc.getTitle()}\nURL: ${wc.getURL()}\n\n${await this.automation!.snapshot(opts)}`;
  }

  async origin(ref?: number): Promise<string> {
    await this.page();
    const origins = await this.automation!.interactionOrigins(ref);
    // A ref-less key can affect any focused frame. Conservatively approve an external frame.
    return origins.find(origin => origin && origin !== "null" && !isLocal(origin)) ?? origins[0] ?? "";
  }

  async rect(ref: number): Promise<{ x: number; y: number; submits: boolean; label: string }> {
    await this.page();
    return this.automation!.actionable(ref);
  }

  automationApproval<T>(request:()=>Promise<T>):Promise<T> { return this.sequence.approval(request); }
  automationState() { return this.sequence.state(); }
  automationPause() { return this.sequence.pause(); }
  automationResume() { return this.sequence.resume(); }
  automationStop() { const state = this.sequence.stop(); void this.experience?.remove(); return state; }
  async runActions<T>(actions: readonly T[], describe: (action: T) => string, execute: (action: T, index: number) => Promise<void>, signal?: AbortSignal) {
    if (this.recording) throw new Error("录制期间不能执行自动化");
    if (this.batchRunning) throw new Error("Browser automation is already running or cleaning up.");
    this.batchRunning = true;
    let experience: CdpExperience | null = null;
    return this.sequence.run(actions, describe, async (action, index) => {
      if (!experience) { await this.page(); await this.loadSettings(); experience = this.experience!; await experience.start(); }
      await this.sequence.checkpoint();
      await execute(action, index);
    }, signal).finally(async () => {
      try { await experience?.stopWatching(); } finally { this.batchRunning = false; }
    });
  }

  async flowList():Promise<BrowserFlow[]> { return this.flows.list(); }
  async flowDelete(name:string):Promise<void> {
    if(this.batchRunning||this.recording||this.flowProject)throw new Error("自动化或录制期间不能删除脚本");
    await this.flows.delete(name);
  }
  async flowRename(oldName:string,newName:string):Promise<void> {
    flowName(oldName);flowName(newName);
    if(this.batchRunning||this.recording||this.flowProject)throw new Error("自动化或录制期间不能改名脚本");
    this.flowProject=getRoot();
    try { await this.flows.rename(oldName,newName); } finally { this.flowProject=null; }
  }
  private cancelRecording():void { const r=this.recording;this.recording=null;if(r)void r.recorder.stop().catch(()=>{}); }
  private recordFlowStep(step:BrowserFlow['steps'][number]):void {
    const r=this.recording;if(!r)return;
    if(!hasRoot()||getRoot()!==r.root){r.error="录制期间项目已切换";return;}
    try {r.buffer.add(step);}catch(error){r.error=(error as Error).message;}
  }
  async flowStartRecording(name?:string, options:BrowserFlowRecordingOptions = {}):Promise<void> {
    if(this.batchRunning||this.recording||this.flowProject)throw new Error("已有自动化或录制正在运行");
    if(options.values!==undefined&&!['record','parameterize'].includes(options.values))throw new Error("录制输入模式无效");
    const root=getRoot();
    const buffer=new BrowserFlowRecording(name,options.values??"parameterize");
    name=buffer.flow.name;
    if((await this.flows.list()).some(f=>f.name===name))throw new Error("脚本已存在，请换一个名称");
    await this.page();if(getRoot()!==root||this.batchRunning||this.recording||this.flowProject)throw new Error("录制开始前状态已变化");
    const recorder=new CdpRecorder(this.cdp!,options,step=>this.recordFlowStep(step),reason=>{if(this.recording?.recorder===recorder)this.recording.error=reason;});
    this.recording={root,flow:buffer.flow,buffer,recorder,values:options.values??'parameterize'};
    const current=this.current();if(current?.url&&/^(https?|file):/.test(current.url))this.recordFlowStep({action:'navigate',url:current.url});
    try { await recorder.start(); } catch(error){this.cancelRecording();throw error;}
  }
  async flowStopRecording(name?:string):Promise<BrowserFlow> {
    const r=this.recording;if(!r)throw new Error("当前没有录制");
    const finalName=flowName(name===undefined?r.flow.name:name);
    if(r.stopping)throw new Error("录制正在停止或保存");
    r.stopping=true;
    try {
      await r.recorder.stop();
      const store=new BrowserFlowStore(()=>{
        if(!hasRoot()||getRoot()!==r.root)throw new Error("项目已切换，录制未写入");
        if(this.recording!==r)throw new Error("录制已取消，未写入");
        return r.root;
      });
      if(r.error)throw new Error(r.error);
      const flow={...r.flow,name:finalName,updatedAt:Date.now()};
      await store.save(flow,true);
      if(this.recording===r)this.recording=null;
      return flow;
    } finally {r.stopping=false;}
  }
  async flowRun(name:string,vars:Record<string,string>={},options:BrowserFlowRunOptions={},signal?:AbortSignal):Promise<import('../../shared/types.ts').BrowserFlowRunResult> {
    if(this.batchRunning||this.recording||this.flowProject)throw new Error("已有自动化或录制正在运行");
    const root=getRoot();this.flowProject=root;
    const check=()=>{this.checkFlowProject();if(signal?.aborted)throw new Error("Browser action cancelled.");};
    try {
      const flow=await this.flows.load(name);check();
      return await replayFlow(flow,this.flows,{
        runActions:(steps,describe,execute,sig)=>this.runActions(steps,describe,execute,sig),
        resolve:async selector=>{check();await this.page();return this.automation!.resolveFlowSelector(selector);},
        execute:async(step,ref)=>executeFlowAction(this,step,ref,(description,detail,sig)=>this.sequence.approval(()=>this.flowApprove(description,detail,sig)),async()=>{check();await this.sequence.checkpoint();check();},signal),
        snapshot:()=>this.snapshot(),
        heal:this.flowHeal?async(selector,snapshot,sig)=>{check();await this.sequence.checkpoint();const signals=[sig,this.sequence.actionSignal(),AbortSignal.timeout(60000)].filter((s):s is AbortSignal=>!!s);return this.flowHeal!(selector,snapshot,AbortSignal.any(signals));}:undefined,
        checkProject:check,
      },vars,options.selfHeal===true,signal);
    } finally {this.flowProject=null;}
  }
  async focus(ref:number):Promise<void> {
    await this.page();const info=await this.automation!.actionable(ref);if(info.password)throw new Error("密码字段只能由用户操作");
    await this.automation!.call(this.automation!.refs.get(ref),'function(){this.focus()}',[],this.automation!.refs.session(ref));
  }

  async click(ref: number): Promise<void> { await this.page(); await this.automation!.click(ref); }
  async type(ref: number, text: string, opts: { clear?: boolean; submit?: boolean }): Promise<void> {
    await this.page(); await this.automation!.type(ref, text, opts);
  }
  async press(key: string): Promise<void> { await this.page(); await this.automation!.press(key); }
  async select(ref: number, value: string): Promise<boolean> { await this.page(); return this.automation!.select(ref, value); }
  async scroll(dy: number, ref?: number): Promise<number> { await this.page(); return this.automation!.scroll(dy, ref); }

  /** Called before the workspace changes: no download may keep using the previous project. */
  async suspendDownloads(): Promise<void> {
    this.sequence.stop(); this.cancelRecording();
    if (!this.cdp) return;
    if (this.downloadSetup) await this.downloadSetup.catch(() => {});
    await this.cdp.denyDownloads();
    this.downloadRoot = undefined;
  }
  async refreshDownloads(): Promise<void> { if (this.cdp) await this.prepareDownloads(); }
  private async prepareDownloads(): Promise<void> {
    if (this.downloadSetup) await this.downloadSetup;
    const root = hasRoot() ? getRoot() : null;
    if (root === this.downloadRoot) return;
    const cdp = this.cdp!;
    this.downloadSetup = (async () => {
      // Fail closed before filesystem checks or project reconfiguration.
      await cdp.denyDownloads();
      try {
        if (root) await cdp.configureDownloads(root);
        if (this.cdp === cdp) this.downloadRoot = root;
      } catch (error) {
        this.downloadRoot = undefined;
        await cdp.denyDownloads().catch(() => {});
        throw error;
      }
    })();
    try { await this.downloadSetup; } finally { this.downloadSetup = null; }
  }
  async hover(ref: number): Promise<void> { await this.page(); await this.automation!.hover(ref); }
  async check(ref: number, checked = true): Promise<void> { await this.page(); await this.automation!.check(ref, checked); }
  async validateUpload(files: string[]): Promise<string[]> { return projectUploadFiles(getRoot(), files); }
  async upload(ref: number, files: string[]): Promise<void> {
    // Revalidate after approval: the project or a symlink may have changed while the card was open.
    const safe = await this.validateUpload(files);
    await this.page(); await this.automation!.upload(ref, safe);
  }
  async wait(opts: Parameters<CdpPage["wait"]>[0]): Promise<void> { await this.page(); await this.automation!.wait(opts); }
  async extract(opts: Parameters<CdpPage["extract"]>[0]): Promise<unknown> { await this.page(); return this.automation!.extract(opts); }
  async network(limit = 50): Promise<unknown> { await this.page(); return this.cdp!.networkSummary(limit); }
  async downloads(): Promise<unknown> { await this.page(); return this.cdp!.downloadSummary(); }

  async nav(how: "back" | "forward" | "reload"): Promise<void> {
    const wc = await this.page();
    await this.cdp!.connect();
    this.cdp!.beginAction();
    const h = wc.navigationHistory;
    if (how === "back" && h.canGoBack()) h.goBack();
    else if (how === "forward" && h.canGoForward()) h.goForward();
    else if (how === "reload") wc.reload();
    await this.settle(wc);
  }

  /** The page as a PNG (base64), at most 1400 px wide. */
  async screenshot(): Promise<string> {
    const wc = await this.page();
    let img = await wc.capturePage();
    const { width } = img.getSize();
    if (width > 1400) img = img.resize({ width: 1400 });
    return img.toPNG().toString("base64");
  }

  /** Console output since the last read (or all of it), errors and warnings first. */
  console(all: boolean): ConsoleLine[] {
    const lines = all ? this.consoleLines : this.consoleLines.slice(this.consoleRead);
    this.consoleRead = this.consoleLines.length;
    return lines;
  }

  openDevTools(): void {
    if (this.wc && !this.wc.isDestroyed()) this.wc.openDevTools({ mode: "detach" });
  }

  // ---- history -----------------------------------------------------------------------

  private async loadHistory(): Promise<BrowserHistoryItem[]> {
    if (this.history) return this.history;
    try {
      this.history = JSON.parse(await fs.readFile(path.join(this.dir, "history.json"), "utf8"));
      if (!Array.isArray(this.history)) this.history = [];
    } catch {
      this.history = [];
    }
    return this.history!;
  }

  private async recordVisit(url: string, title: string): Promise<void> {
    if (!/^(https?|file):/.test(url)) return;
    const h = await this.loadHistory();
    const last = h[0];
    // The same page again (a title change, a reload): update it instead of adding a line.
    if (last && last.url === url) {
      last.title = title || last.title;
      last.at = Date.now();
    } else h.unshift({ url, title: title || url, at: Date.now() });
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
    await this.write("history.json", h);
  }

  async listHistory(query = "", limit = 200): Promise<BrowserHistoryItem[]> {
    const q = query.trim().toLowerCase();
    const h = await this.loadHistory();
    return (q ? h.filter((x) => x.url.toLowerCase().includes(q) || x.title.toLowerCase().includes(q)) : h).slice(0, limit);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.write("history.json", []);
  }

  /** History, cookies, local storage and cache. Saved logins are kept (they're managed apart). */
  async clearBrowsingData(): Promise<void> {
    await this.clearHistory();
    await session.fromPartition(PARTITION).clearStorageData();
    await session.fromPartition(PARTITION).clearCache();
  }

  // ---- logins ------------------------------------------------------------------------

  private async loadLogins(): Promise<StoredLogin[]> {
    if (this.logins) return this.logins;
    try {
      this.logins = JSON.parse(await fs.readFile(path.join(this.dir, "logins.json"), "utf8"));
      if (!Array.isArray(this.logins)) this.logins = [];
    } catch {
      this.logins = [];
    }
    return this.logins!;
  }

  /** Saved logins without their passwords. */
  async listLogins(): Promise<BrowserLogin[]> {
    return (await this.loadLogins()).map(({ id, origin, username, updatedAt }) => ({ id, origin, username, updatedAt }));
  }

  private async loginsFor(origin: string): Promise<BrowserLogin[]> {
    return (await this.listLogins()).filter((l) => l.origin === origin);
  }

  /** The user's answer to "保存密码？". */
  async answerOffer(save: boolean): Promise<void> {
    const o = this.offered;
    this.offered = null;
    if (!save || !o) return;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("这台电脑的系统钥匙串不可用，没法安全地保存密码");
    const all = await this.loadLogins();
    const secret = safeStorage.encryptString(o.password).toString("base64");
    const same = all.find((l) => l.origin === o.origin && l.username === o.username);
    if (same) Object.assign(same, { secret, updatedAt: Date.now() });
    else all.push({ id: randomUUID().slice(0, 8), origin: o.origin, username: o.username, secret, updatedAt: Date.now() });
    await this.write("logins.json", all);
  }

  /** The user picked a saved login for the page in front: fill it in. Only for that page's own origin. */
  async fillLogin(id: string): Promise<void> {
    const wc = this.wc;
    if (!wc || wc.isDestroyed()) return;
    const l = (await this.loadLogins()).find((x) => x.id === id);
    if (!l) return;
    const origin = (() => {
      try {
        return new URL(wc.getURL()).origin;
      } catch {
        return "";
      }
    })();
    if (origin !== l.origin) throw new Error("这个账号不是这个网站的，没有填");
    wc.send("sikeoop-fill", { username: l.username, password: safeStorage.decryptString(Buffer.from(l.secret, "base64")) });
  }

  async removeLogin(id: string): Promise<void> {
    const all = await this.loadLogins();
    this.logins = all.filter((l) => l.id !== id);
    await this.write("logins.json", this.logins);
  }

  // ---- settings and state -----------------------------------------------------------------

  async loadSettings(): Promise<BrowserSettings> {
    try {
      const s = JSON.parse(await fs.readFile(path.join(this.dir, "settings.json"), "utf8"));
      if (s && s.engine in ENGINES) this.settings = { engine: s.engine, automationSpeed: ["demo", "normal", "fast"].includes(s.automationSpeed) ? s.automationSpeed : "normal" };
    } catch {
      // Defaults.
    }
    return this.settings;
  }

  async setSettings(s: BrowserSettings): Promise<BrowserSettings> {
    if (s && s.engine in ENGINES) this.settings = { engine: s.engine, automationSpeed: ["demo", "normal", "fast"].includes(s.automationSpeed ?? "") ? s.automationSpeed : this.settings.automationSpeed };
    await this.write("settings.json", this.settings);
    return this.settings;
  }

  async state(): Promise<BrowserState> {
    return { settings: await this.loadSettings(), logins: await this.listLogins(), loginFormOrigin: this.loginFormOn };
  }

  private async write(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), "utf8");
    await fs.rename(tmp, target);
  }
}
