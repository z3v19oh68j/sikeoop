import { promises as fs } from "node:fs";
import path from "node:path";
import { BrowserWindow, clipboard, ipcMain, screen, shell, systemPreferences } from "electron";
import type { DictationKey, DictationState, DictationView } from "@shared/types";
import { acquireHook, hookKeys, releaseHook } from "./hook";

// Dictation anywhere: hold a key (right Option on a Mac, right Ctrl on Windows), talk, let go —
// a small bubble by the pointer listens, the speech is transcribed, and the text is typed into
// whatever has focus (pasted through the clipboard, which is put back afterwards).
// Apps don't say where their text cursor is, so the bubble sits by the mouse pointer.

/**
 * Keys that can be held to talk, per system. Right-hand modifiers: nobody holds them alone while
 * typing. Not right Alt on Windows: letting go of a lone Alt opens the menu bar of most apps.
 */
const KEYS: Record<"mac" | "win", { id: DictationKey; label: string; code: (K: ReturnType<typeof hookKeys>) => number }[]> = {
  mac: [
    { id: "right-alt", label: "右 Option", code: (K) => K.AltRight },
    { id: "right-meta", label: "右 Command", code: (K) => K.MetaRight },
    { id: "right-shift", label: "右 Shift", code: (K) => K.ShiftRight },
  ],
  win: [
    { id: "right-ctrl", label: "右 Ctrl", code: (K) => K.CtrlRight },
    { id: "right-shift", label: "右 Shift", code: (K) => K.ShiftRight },
    { id: "menu", label: "菜单键（右 Ctrl 左边那个）", code: () => 0x0e5d },
  ],
};
const keysHere = () => KEYS[process.platform === "darwin" ? "mac" : "win"];

/** Held this long before it counts (a quick tap, or the key as part of a shortcut, does nothing). */
const HOLD_MS = 250;
/** Longest recording; it stops and types by itself after this. */
const MAX_MS = 60_000;
const W = 280;
const H = 64;

export class Dictation {
  private enabled = true;
  /** macOS: the Accessibility prompt was shown once already (first launch). */
  private asked = false;
  private key: DictationKey = keysHere()[0].id;
  private error: string | undefined;
  private running = false;
  private win: BrowserWindow | null = null;
  private held = false;
  private holdTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private phase: DictationState["phase"] | null = null;
  /** Waiting for the user to allow Accessibility in System Settings: starts by itself once they do. */
  private waitTimer: NodeJS.Timeout | null = null;
  /** Tells the settings page the state changed (permission granted while it was open). */
  onChange: (v: DictationView) => void = () => {};

  constructor(
    private readonly opts: {
      settingsFile: string;
      preload: string;
      load(win: BrowserWindow): void;
      ready(): boolean;
      transcribe(audio: Buffer, mime: string): Promise<string>;
    },
  ) {}

  async init(): Promise<void> {
    try {
      const s = JSON.parse(await fs.readFile(this.opts.settingsFile, "utf8")) as { enabled?: boolean; asked?: boolean; key?: DictationKey };
      this.enabled = s.enabled !== false;
      if (keysHere().some((k) => k.id === s.key)) this.key = s.key!;
      this.asked = !!s.asked;
    } catch {
      // On by default.
    }
    const mine = (e: Electron.IpcMainEvent) => e.sender === this.win?.webContents;
    ipcMain.on("dict:audio", (e, audio: unknown, error: unknown) => {
      if (!mine(e) || this.phase !== "sending") return;
      if (typeof error === "string" && error) return this.fail(error);
      const buf = audio instanceof ArrayBuffer ? Buffer.from(audio) : ArrayBuffer.isView(audio) ? Buffer.from(audio.buffer) : null;
      if (!buf || buf.length < 8000) return this.end(); // a quarter second or less: nothing said
      this.show("thinking");
      this.opts
        .transcribe(buf, "audio/wav")
        .then((text) => {
          if (this.phase !== "thinking") return;
          if (!text) return this.fail("没听清，再说一次？");
          this.end();
          // Let the bubble go and focus settle back on the app before typing.
          setTimeout(() => void this.type(text), 80);
        })
        .catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)));
    });
    if (this.enabled) {
      // The first launch asks for the permission it needs; later launches never nag.
      if (this.asked) this.start(false);
      else {
        // First launch: ask for everything right away, so the first hold of the key just works.
        this.asked = true;
        await this.save();
        await this.grant();
      }
    }
  }

  view(): DictationView {
    return {
      enabled: this.enabled,
      running: this.running,
      key: this.key,
      keys: keysHere().map(({ id, label }) => ({ id, label })),
      mic: this.micStatus(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Gets every permission dictation needs, as far as the system lets an app: the microphone
   * prompt, and on a Mac the Accessibility prompt plus its System Settings page (that switch can
   * only be flipped by the user). Listening starts by itself the moment access is granted.
   */
  async grant(): Promise<DictationView> {
    if (process.platform === "darwin") {
      if (systemPreferences.getMediaAccessStatus("microphone") === "not-determined") await systemPreferences.askForMediaAccess("microphone");
      else if (systemPreferences.getMediaAccessStatus("microphone") === "denied")
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
      if (!systemPreferences.isTrustedAccessibilityClient(true)) {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      }
    } else if (process.platform === "win32") {
      // Windows asks nothing of apps, but the microphone can be switched off for desktop apps.
      // Two switches there: "Microphone access" and "Let desktop apps access your microphone".
      if (this.micStatus() === "denied") {
        void shell.openExternal("ms-settings:privacy-microphone");
        this.waitForMic();
      }
    }
    if (this.enabled) this.start(false);
    return this.view();
  }

  async setKey(key: DictationKey): Promise<DictationView> {
    if (!keysHere().some((k) => k.id === key)) return this.view();
    this.key = key;
    await this.save();
    // Restart the listener on the new key.
    if (this.running) {
      this.stop();
      this.start(false);
    }
    return this.view();
  }

  /** The microphone switch as the system sees it (Windows: Settings › Privacy › Microphone). */
  private micStatus(): DictationView["mic"] {
    if (process.platform !== "darwin" && process.platform !== "win32") return "granted";
    const s = systemPreferences.getMediaAccessStatus("microphone");
    return s === "granted" ? "granted" : s === "not-determined" ? "unknown" : "denied";
  }

  /** Windows: after opening the microphone settings, notice when the switch goes on. */
  private waitForMic(): void {
    if (this.waitTimer) return;
    const until = Date.now() + 10 * 60_000;
    this.waitTimer = setInterval(() => {
      if (Date.now() > until) return this.stopWaiting();
      if (this.micStatus() !== "granted") return;
      this.stopWaiting();
      this.onChange(this.view());
    }, 2000);
  }

  /** macOS: check every two seconds (for ten minutes) whether Accessibility was allowed, then start. */
  private waitForAccess(): void {
    if (this.waitTimer || process.platform !== "darwin") return;
    const until = Date.now() + 10 * 60_000;
    this.waitTimer = setInterval(() => {
      if (!this.enabled || Date.now() > until) return this.stopWaiting();
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return;
      this.stopWaiting();
      this.start(false);
      this.onChange(this.view());
    }, 2000);
  }

  private stopWaiting(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
  }

  async setEnabled(on: boolean): Promise<DictationView> {
    this.enabled = on;
    this.stop();
    await this.save();
    return on ? this.grant() : this.view();
  }

  stop(): void {
    this.stopWaiting();
    this.cancel();
    if (!this.running) return;
    this.running = false;
    releaseHook("dictation");
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.settingsFile), { recursive: true });
    await fs.writeFile(this.opts.settingsFile, JSON.stringify({ enabled: this.enabled, asked: this.asked, key: this.key }), "utf8").catch(() => {});
  }

  /** Watches the keyboard. `ask`: show macOS's Accessibility prompt when access is missing. */
  private start(ask: boolean): void {
    this.error = undefined;
    if (this.running) return;
    if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(ask)) {
      this.error = "需要在「系统设置 › 隐私与安全性 › 辅助功能」里打开 sikeoop 的开关，打开后自动生效";
      this.waitForAccess();
      return;
    }
    let hook;
    try {
      hook = acquireHook("dictation");
    } catch (err) {
      this.error = `键盘监听没能启动：${(err as Error).message}`;
      return;
    }
    this.running = true;
    const K = hookKeys();
    const trigger = (keysHere().find((k) => k.id === this.key) ?? keysHere()[0]).code(K);
    hook.on("keydown", (e) => {
      if (!this.running) return;
      if (e.keycode === trigger) {
        if (this.held) return; // key repeat
        this.held = true;
        this.holdTimer = setTimeout(() => void this.begin(), HOLD_MS);
      } else if (e.keycode === K.Escape && this.phase) {
        this.cancel();
      } else if (this.holdTimer) {
        // Part of a shortcut (right Ctrl + C…): not dictation.
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
    });
    hook.on("keyup", (e) => {
      if (!this.running || e.keycode !== trigger) return;
      this.held = false;
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = null;
      if (this.phase === "listening") this.finish();
    });
  }

  private async begin(): Promise<void> {
    this.holdTimer = null;
    if (!this.held || this.phase) return;
    if (!this.opts.ready()) return this.fail("先在设置 → 语音输入里填好语音识别");
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      if (!(await systemPreferences.askForMediaAccess("microphone"))) return this.fail("没有麦克风权限");
      if (!this.held) return; // let go while the prompt was up
    }
    if (process.platform === "win32" && this.micStatus() === "denied") return this.fail("麦克风被系统关掉了：去设置 → 语音输入点「一键授权」");
    this.show("listening");
    this.maxTimer = setTimeout(() => this.finish(), MAX_MS);
  }

  /** Stop listening: the bubble page sends the recording, then it is transcribed. */
  private finish(): void {
    if (this.phase !== "listening") return;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.show("sending");
  }

  private cancel(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.holdTimer = this.maxTimer = null;
    if (this.phase) this.end();
  }

  private fail(message: string): void {
    this.show("error", message.slice(0, 60));
    setTimeout(() => {
      if (this.phase === "error") this.end();
    }, 2500);
  }

  private end(): void {
    this.phase = null;
    this.send({ phase: "idle" });
    this.win?.hide();
  }

  private show(phase: DictationState["phase"], message?: string): void {
    const win = this.window();
    const fresh = !this.phase;
    this.phase = phase;
    if (fresh) {
      // Beside the pointer, kept on its screen.
      const p = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(p).workArea;
      const x = Math.min(Math.max(p.x + 14, area.x), area.x + area.width - W);
      const y = p.y + 22 + H > area.y + area.height ? p.y - H - 10 : p.y + 22;
      win.setBounds({ x, y, width: W, height: H });
      win.showInactive();
    }
    this.send({ phase, ...(message ? { message } : {}) });
  }

  private send(s: DictationState): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("dict:state", s);
  }

  /** The bubble window, made once and kept (hidden) so the microphone starts fast. */
  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: W,
      height: H,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      // Never takes focus: the text goes to the app the user is typing in.
      focusable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: { preload: this.opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("did-finish-load", () => this.phase && this.send({ phase: this.phase }));
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    this.opts.load(win);
    return win;
  }

  /** Types `text` into the focused app: paste it, then put the clipboard back as it was. */
  private async type(text: string): Promise<void> {
    const before = await clipboard.read().catch(() => null);
    await clipboard.writeText(text);
    try {
      const K = hookKeys();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { uIOhook } = require("uiohook-napi") as typeof import("uiohook-napi");
      uIOhook.keyTap(K.V, [process.platform === "darwin" ? K.Meta : K.Ctrl]);
    } catch {
      // Could not press the keys: the text stays on the clipboard to paste by hand.
      return;
    }
    setTimeout(async () => {
      if ((await clipboard.readText()) !== text) return; // the user copied something meanwhile
      if (before?.length) await clipboard.write(before).catch(() => {});
      else clipboard.clear();
    }, 600);
  }
}
