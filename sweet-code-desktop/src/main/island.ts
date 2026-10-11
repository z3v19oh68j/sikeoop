import { promises as fs } from "node:fs";
import path from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import type { AgentEvent, AgentSessionView, IslandLayout, IslandState, ProcInfo, AcpPermissionOption } from "@shared/types";
import { listProcs } from "./procs";

// The Dynamic Island: a small transparent window pinned at the top centre of the screen that
// shows what the AI is doing. The window is a fixed transparent box sized for the largest state;
// the island itself is drawn inside it and morphs. Areas outside the island let clicks through.

/** Big enough for every state plus its shadow and glow. */
const WIDTH = 520;
/** Tall enough for the screenshot answer card. */
const HEIGHT = 480;
/** A menu bar this tall on a Mac's built-in screen means the screen has a camera notch. */
const NOTCH_MENU_BAR = 32;

/** What can be going on at once, most important first. The island shows the first one present. */
const ORDER = ["ask", "question", "error", "done", "progress", "working", "cli"] as const;
type SlotKind = (typeof ORDER)[number];
/** Each slot's state without the shared fields. */
type Slot<K extends SlotKind> = Omit<Extract<IslandState, { kind: K }>, "kind" | "providerId" | "badge">;

export class Island {
  private win: BrowserWindow | null = null;
  private enabled = false;
  private layout: IslandLayout = { mode: "pill", top: 0 };
  private slots: { [K in SlotKind]?: Slot<K> } = {};
  /** Background jobs by key (archive, wiki); the newest shows in the progress slot. */
  private jobs = new Map<string, Slot<"progress">>();
  private hovered = false;
  /** The screenshot flow, shown above everything else while it lasts. */
  private shot: Extract<IslandState, { kind: "shot" | "shotThinking" | "shotAnswer" }> | null = null;
  /** Opened just for a screenshot while the island is switched off: close it afterwards. */
  private temporary = false;
  /** Voice input while it lasts: recording, waiting for the audio, or being transcribed. */
  private voice: { phase: "listening" | "sending" | "thinking"; startedAt: number; timer: NodeJS.Timeout | null } | null = null;
  /** The question slot holds a terminal agent's "waiting for you" (not the chat's question). */
  private peerQuestion = false;
  /** The process card while it is open: refreshed every few seconds. */
  private procs: { sort: "cpu" | "mem"; list: ProcInfo[]; timer: NodeJS.Timeout } | null = null;
  /** The current turn: when it started and how many files it changed. */
  private turn: { startedAt: number; files: Set<string> } | null = null;

  constructor(
    private readonly opts: {
      settingsFile: string;
      preload: string;
      /** Loads the island page into the window. */
      load(win: BrowserWindow): void;
      /** The provider of the active partner (whose avatar shows). */
      providerId(): string;
      /** The main window, to place the island on its screen and to bring it forward. */
      main(): BrowserWindow | null;
      showMain(): void;
      onChange(enabled: boolean): void;
      /** A session row was clicked: show its terminal tab. */
      focusAgent(id: string): void;
      /** Approve or reject a pending action from the island. */
      decide(id: string, approve: boolean): void;
      selectAgentPermission?(id: string, optionId: string | null): void;
      /** Today's and all-time tokens, shown when hovering the idle island. */
      usage(): { today: string; total: string };
      /** Voice input: can it run, ask for the microphone, turn audio into text, send the text to the chat. */
      voice: {
        ready(): boolean;
        permit(): Promise<boolean>;
        transcribe(audio: Buffer, mime: string): Promise<string>;
        send(text: string): void;
      };
      /** Screenshot flow: ask the vision model, copy the answer, continue in the chat. */
      shot: { ask(question: string): void; copy(): void; toChat(): void; cancel(): void };
    },
  ) {}

  async init(): Promise<void> {
    try {
      this.enabled = !!(JSON.parse(await fs.readFile(this.opts.settingsFile, "utf8")) as { enabled?: boolean }).enabled;
    } catch {
      // Off by default.
    }
    const mine = (e: Electron.IpcMainEvent) => e.sender === this.win?.webContents;
    ipcMain.on("island:hover", (e, over: unknown) => {
      if (!mine(e)) return;
      // Over the island it takes clicks; elsewhere they pass through to what's underneath.
      this.win!.setIgnoreMouseEvents(!over, { forward: true });
      this.hovered = over === true;
      if (this.top() === "idle") this.push();
    });
    ipcMain.on("island:open", (e) => {
      if (mine(e)) this.opts.showMain();
    });
    ipcMain.on("island:settled", (e) => {
      if (!mine(e)) return;
      delete this.slots.done;
      delete this.slots.error;
      this.push();
    });
    ipcMain.on("island:shotAsk", (e, q: unknown) => {
      if (mine(e) && this.shot?.kind === "shot") this.opts.shot.ask(String(q ?? "").slice(0, 2000));
    });
    ipcMain.on("island:shotClose", (e) => {
      if (!mine(e)) return;
      this.opts.shot.cancel();
      this.shotEnd();
    });
    ipcMain.on("island:shotCopy", (e) => {
      if (mine(e)) this.opts.shot.copy();
    });
    ipcMain.on("island:shotToChat", (e) => {
      if (!mine(e)) return;
      this.opts.shot.toChat();
      this.shotEnd();
    });
    ipcMain.on("island:focusAgent", (e, id: unknown) => {
      if (mine(e) && typeof id === "string") this.opts.focusAgent(id);
    });
    ipcMain.on("island:agentPermission", (e, id: unknown, optionId: unknown) => {
      const card = this.slots.ask;
      if (!mine(e) || typeof id !== "string" || card?.id !== id || !card.options || !id.startsWith("acp")) return;
      if (optionId !== null && (typeof optionId !== "string" || !card.options.some(o => o.optionId === optionId))) return;
      this.opts.selectAgentPermission?.(id, optionId);
    });
    ipcMain.on("island:decide", (e, id: unknown, approve: unknown) => {
      if (!mine(e) || typeof id !== "string" || this.slots.ask?.id !== id) return;
      if (!(id.startsWith("acp:") && approve === true)) {
        delete this.slots.ask;
        this.push();
      }
      this.opts.decide(id, approve === true);
    });
    ipcMain.on("island:procs", (e, open: unknown, sort: unknown) => {
      if (!mine(e)) return;
      if (open !== true) return this.procsEnd();
      const by = sort === "mem" ? "mem" : "cpu";
      if (this.procs) {
        this.procs.sort = by;
        return this.push();
      }
      this.procs = { sort: by, list: [], timer: setInterval(() => void this.procsRefresh(), 3000) };
      void this.procsRefresh();
    });
    ipcMain.on("island:voice", (e, action: unknown) => {
      if (!mine(e)) return;
      if (action === "start") void this.voiceStart();
      else if (action === "stop") this.voiceStop();
      else if (action === "cancel") this.voiceEnd();
    });
    ipcMain.on("island:voiceAudio", (e, audio: unknown, mime: unknown, error: unknown) => {
      if (!mine(e) || this.voice?.phase !== "sending") return;
      if (typeof error === "string" && error) return this.voiceFail(error);
      if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) return this.voiceFail("没录到声音");
      const buf = Buffer.from(audio instanceof ArrayBuffer ? audio : audio.buffer);
      // Under ~2 KB is a click, not speech.
      if (buf.length < 2000) return this.voiceFail("太短了，没听清");
      this.voice.phase = "thinking";
      this.push();
      this.opts.voice
        .transcribe(buf, typeof mime === "string" ? mime : "audio/webm")
        .then((text) => {
          if (!this.voice) return; // cancelled meanwhile
          if (!text) return this.voiceFail("没听清，再说一次？");
          this.voiceEnd();
          this.opts.voice.send(text);
        })
        .catch((err: unknown) => this.voiceFail(err instanceof Error ? err.message : String(err)));
    });
    screen.on("display-metrics-changed", () => this.place());
    screen.on("display-removed", () => this.place());
    screen.on("display-added", () => this.place());
    if (this.enabled) this.open();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Until when the island is hidden for a while (0 = not hidden). */
  private snoozeUntil = 0;
  private snoozeTimer: NodeJS.Timeout | null = null;

  isSnoozed(): boolean {
    return this.snoozeUntil > Date.now();
  }

  /** Hide the island for a while (a fullscreen video on Windows), or show it again (ms = 0). */
  snooze(ms: number): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = null;
    this.snoozeUntil = ms > 0 ? Date.now() + ms : 0;
    if (ms > 0) {
      this.win?.hide();
      this.snoozeTimer = setTimeout(() => this.snooze(0), ms);
    } else if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
    }
    this.opts.onChange(this.enabled);
  }

  /** sikeoop's window moved: follow it to its screen (debounced). */
  private followTimer: NodeJS.Timeout | null = null;
  follow(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.place(), 300);
  }

  async setEnabled(on: boolean): Promise<boolean> {
    this.enabled = on;
    if (on) this.open();
    else this.close();
    await fs.mkdir(path.dirname(this.opts.settingsFile), { recursive: true });
    await fs.writeFile(this.opts.settingsFile, JSON.stringify({ enabled: on }), "utf8").catch(() => {});
    this.opts.onChange(on);
    return on;
  }

  /** The partner changed: the island shows the new avatar. */
  refreshPartner(): void {
    this.push();
  }

  /** A background job's progress (pct 0–100, or null when unknown). */
  progress(key: string, label: string, pct: number | null): void {
    this.jobs.delete(key);
    this.jobs.set(key, { label, pct: pct === null ? null : Math.max(0, Math.min(100, Math.round(pct))) });
    this.slots.progress = [...this.jobs.values()].pop();
    this.push();
  }

  /** A background job ended; `done` shows a short "finished" message. */
  progressEnd(key: string, done?: { text: string; detail: string }, error?: string): void {
    this.jobs.delete(key);
    this.slots.progress = [...this.jobs.values()].pop();
    if (error) this.slots.error = { text: error };
    else if (done) this.slots.done = done;
    this.push();
  }

  /** Shows a screenshot step. Opens the island for the occasion when it is switched off. */
  shotShow(s: NonNullable<Island["shot"]>): void {
    if (!this.win || this.win.isDestroyed()) {
      this.temporary = !this.enabled;
      this.open();
    }
    this.shot = s;
    // Typing the question needs keyboard focus and clicks, which the island normally gives up.
    if (this.win) {
      this.win.setFocusable(true);
      this.win.setIgnoreMouseEvents(false);
      if (s.kind === "shot") this.win.focus();
    }
    this.push();
  }

  shotEnd(): void {
    if (!this.shot) return;
    this.shot = null;
    if (this.win) {
      this.win.setFocusable(false);
      this.win.setIgnoreMouseEvents(!this.hovered, { forward: true });
    }
    this.push();
    if (this.temporary) {
      this.temporary = false;
      // Let the island shrink back before it goes away.
      setTimeout(() => {
        if (!this.enabled && !this.shot) this.close();
      }, 600);
    }
  }

  /** The voice shortcut: start listening, or stop and send. Opens the island for it when it is off. */
  voiceToggle(): void {
    if (!this.voice) void this.voiceStart();
    else if (this.voice.phase === "listening") this.voiceStop();
  }

  private async voiceStart(): Promise<void> {
    if (this.voice) return;
    if (!this.opts.voice.ready()) {
      this.slots.error = { text: "先在设置 → 灵动岛里填语音识别的 Key" };
      if (!this.win || this.win.isDestroyed()) this.open();
      return this.push();
    }
    if (!(await this.opts.voice.permit())) {
      this.slots.error = { text: "没有麦克风权限，去系统设置里允许 sikeoop 使用麦克风" };
      return this.push();
    }
    if (!this.win || this.win.isDestroyed()) {
      this.temporary = !this.enabled;
      this.open();
    }
    this.procsEnd();
    delete this.slots.done;
    delete this.slots.error;
    // Stops by itself after a minute.
    this.voice = { phase: "listening", startedAt: Date.now(), timer: setTimeout(() => this.voiceStop(), 60_000) };
    this.push();
  }

  /** Ask the island page for the recording; transcription starts when it arrives. */
  private voiceStop(): void {
    if (this.voice?.phase !== "listening") return;
    if (this.voice.timer) clearTimeout(this.voice.timer);
    this.voice.timer = null;
    this.voice.phase = "sending";
    this.push();
  }

  private voiceFail(message: string): void {
    this.voiceEnd();
    this.slots.error = { text: message.slice(0, 80) };
    this.push();
  }

  private voiceEnd(): void {
    if (!this.voice) return;
    if (this.voice.timer) clearTimeout(this.voice.timer);
    this.voice = null;
    this.push();
    if (this.temporary && !this.shot) {
      this.temporary = false;
      setTimeout(() => {
        if (!this.enabled && !this.shot && !this.voice) this.close();
      }, 600);
    }
  }

  private async procsRefresh(): Promise<void> {
    const list = await listProcs().catch(() => null);
    if (!this.procs || !list) return;
    this.procs.list = list;
    this.push();
  }

  private procsEnd(): void {
    if (!this.procs) return;
    clearInterval(this.procs.timer);
    this.procs = null;
    this.push();
  }

  /** The agent sessions in the terminal tabs changed. */
  agents(sessions: AgentSessionView[]): void {
    if (sessions.length) this.slots.cli = { sessions };
    else delete this.slots.cli;
    // "X 在等你" goes away once nobody is waiting any more.
    if (this.peerQuestion && !sessions.some((s) => s.status === "waiting")) {
      this.peerQuestion = false;
      delete this.slots.question;
    }
    this.push();
  }

  /** A terminal agent asks for permission (ids start with "peer:"); approve / reject goes back through `decide`. */
  peerAsk(id: string, title: string, detail: string, options?: AcpPermissionOption[]): void {
    this.slots.ask = { id, title, detail, ...(options ? { options } : {}) };
    this.push();
  }

  peerAskGone(id: string): void {
    if (this.slots.ask?.id !== id) return;
    delete this.slots.ask;
    this.push();
  }

  /** A short note: a session finished, needs you, or agents talked. */
  notice(text: string, detail: string, kind: "done" | "question" = "done"): void {
    if (kind === "question") {
      this.slots.question = { title: `${text}：${detail}`.slice(0, 60) };
      this.peerQuestion = true;
    }
    else this.slots.done = { text, detail: detail.slice(0, 80) };
    this.push();
  }

  onAgentEvent(e: AgentEvent): void {
    const s = this.slots;
    if (e.type === "status") {
      if (e.state === "idle") {
        delete s.working;
      } else {
        if (!this.turn) this.turn = { startedAt: Date.now(), files: new Set() };
        // A new turn replaces the last one's "done".
        delete s.done;
        if (!s.working || e.state === "compacting") s.working = { text: e.state === "compacting" ? "正在整理上下文" : "正在思考" };
      }
    } else if (e.type === "tool_start") {
      s.working = { text: e.summary.slice(0, 40) || "正在干活" };
    } else if (e.type === "file_changed") {
      this.turn?.files.add(e.path);
      s.working = { text: `正在改文件 · 已改 ${this.turn?.files.size ?? 1} 个` };
    } else if (e.type === "approval_request" && !e.autoApproved) {
      const sub = e.subject;
      s.ask =
        sub.kind === "file"
          ? { id: e.id, title: sub.change.created ? "想新建一个文件" : "想修改一个文件", detail: sub.change.path }
          : sub.kind === "command"
            ? { id: e.id, title: "想运行一条命令", detail: sub.command.command.slice(0, 200), ...(sub.command.warning ? { warning: sub.command.warning } : {}) }
            : { id: e.id, title: "想使用一个工具", detail: `${sub.call.server} · ${sub.call.tool}` };
    } else if (e.type === "approval_result") {
      if (s.ask?.id === e.id) delete s.ask;
    } else if (e.type === "question") {
      s.question = { title: e.intro?.slice(0, 60) || e.questions[0]?.question.slice(0, 60) || "有问题想问你" };
    } else if (e.type === "question_answered") {
      delete s.question;
    } else if (e.type === "done") {
      const turn = this.turn;
      this.turn = null;
      delete s.working;
      delete s.ask;
      delete s.question;
      if (e.reason === "end_turn" && turn) {
        const secs = Math.max(1, Math.round((Date.now() - turn.startedAt) / 1000));
        const time = secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
        s.done = { text: "做完了", detail: `${turn.files.size ? `改了 ${turn.files.size} 个文件` : "这一轮完成了"} · 用时 ${time}` };
      } else if (e.reason === "step_limit") {
        s.done = { text: "先停下了", detail: "做了很多步，等你看一眼再继续" };
      }
    } else if (e.type === "error") {
      this.turn = null;
      delete s.working;
      s.error = { text: e.message.slice(0, 80) };
    } else {
      return;
    }
    this.push();
  }

  private top(): SlotKind | "idle" {
    return ORDER.find((k) => this.slots[k]) ?? "idle";
  }

  /** Sends the most important state, with the count of the others as a badge. */
  private push(): void {
    if (!this.win) return;
    const providerId = this.opts.providerId();
    const k = this.top();
    const others = ORDER.filter((x) => x !== k && this.slots[x]).length;
    const badge = others ? { badge: others } : {};
    if (this.shot) {
      const all = ORDER.filter((x) => this.slots[x]).length;
      this.win.webContents.send("island:state", { ...this.shot, providerId, ...(all ? { badge: all } : {}) });
      return;
    }
    if (this.voice) {
      const { phase, startedAt } = this.voice;
      this.win.webContents.send("island:state", { kind: "voice", providerId, phase, startedAt });
      return;
    }
    if (this.procs) {
      const { sort, list } = this.procs;
      // All of them, busiest first; the card scrolls.
      const procs = [...list].sort((a, b) => b[sort] - a[sort] || b.cpu - a.cpu);
      this.win.webContents.send("island:state", { kind: "procs", providerId, procs, total: list.length, sort });
      return;
    }
    const state: IslandState =
      k === "idle"
        ? { kind: "idle", providerId, ...(this.hovered ? { usage: this.opts.usage() } : {}) }
        : ({ kind: k, providerId, ...this.slots[k], ...badge } as IslandState);
    this.win.webContents.send("island:state", state);
  }

  private open(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      // Never takes keyboard focus away from what the user is typing in.
      focusable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: { preload: this.opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => {
      win.webContents.send("island:layout", this.layout);
      this.push();
      if (!this.isSnoozed()) win.showInactive();
    });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    this.place();
    this.opts.load(win);
  }

  private close(): void {
    if (this.procs) clearInterval(this.procs.timer);
    this.procs = null;
    if (this.voice?.timer) clearTimeout(this.voice.timer);
    this.voice = null;
    const win = this.win;
    this.win = null;
    win?.destroy();
  }

  /**
   * Top centre of the screen sikeoop's window is on. On a notched Mac screen the window starts
   * at the very top edge so the island wraps the notch; elsewhere it floats just below the menu
   * bar / screen edge.
   */
  private place(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const main = this.opts.main();
    const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const menuBar = display.workArea.y - display.bounds.y;
    const notch = process.platform === "darwin" && display.internal && menuBar >= NOTCH_MENU_BAR;
    this.layout = notch ? { mode: "notch", top: menuBar } : { mode: "pill", top: 0 };
    const y = notch ? display.bounds.y : display.workArea.y + (process.platform === "darwin" ? 6 : 8);
    this.win.setBounds({ x: Math.round(display.bounds.x + (display.bounds.width - WIDTH) / 2), y, width: WIDTH, height: HEIGHT });
    this.win.webContents.send("island:layout", this.layout);
  }
}
