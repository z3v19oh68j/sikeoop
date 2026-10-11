import { promises as fs } from "node:fs";
import { type BrowserWindow, Menu, Notification, Tray, app, nativeImage } from "electron";
import type { AgentEvent } from "@shared/types";
import trayIconFile from "../../build/icon.png?asset";

// Running in the background: a tray / menu-bar icon, closing the window hides it instead of
// quitting (so a long AI task keeps going), and system notifications when something needs the
// user while the window isn't in front. Both can be switched off from the tray menu.

interface BackgroundSettings {
  /** Closing the window keeps sikeoop running in the tray. */
  closeToTray: boolean;
  /** System notifications while the window is hidden or not focused. */
  notify: boolean;
}

const DEFAULTS: BackgroundSettings = { closeToTray: true, notify: true };

export class Background {
  private tray: Tray | null = null;
  private settings: BackgroundSettings = DEFAULTS;
  private quitting = false;
  private busy = false;
  private hintShown = false;
  /** Kept referenced until clicked or closed, or macOS may drop the click handler. */
  private live = new Set<Notification>();

  constructor(
    private readonly opts: {
      window(): BrowserWindow | null;
      /** Recreates the window when it was destroyed (macOS keeps the app without windows). */
      createWindow(): void;
      settingsFile: string;
      /** The open project's folder name, for notification text. */
      project(): string | null;
      /** The Dynamic Island switch, shown in the tray menu. */
      island: { enabled(): boolean; set(on: boolean): void; snoozed(): boolean; snooze(ms: number): void };
    },
  ) {}

  async init(): Promise<void> {
    try {
      this.settings = { ...DEFAULTS, ...(JSON.parse(await fs.readFile(this.opts.settingsFile, "utf8")) as Partial<BackgroundSettings>) };
    } catch {
      // First run: defaults.
    }
    app.on("before-quit", () => (this.quitting = true));
    this.createTray();
  }

  /** Call for every new window: closing it hides it while background mode is on. */
  attach(win: BrowserWindow): void {
    win.on("close", (e) => {
      if (this.quitting || !this.settings.closeToTray) return;
      e.preventDefault();
      win.hide();
      if (!this.hintShown) {
        this.hintShown = true;
        this.notify("sikeoop 还在后台运行", process.platform === "darwin" ? "点菜单栏的图标可以打开，选「退出」才会真正关闭。" : "点托盘图标可以打开，右键选「退出」才会真正关闭。", true);
      }
    });
  }

  show(): void {
    const win = this.opts.window();
    if (!win || win.isDestroyed()) return this.opts.createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** Watches the agent for moments worth a notification. */
  onAgentEvent(e: AgentEvent): void {
    if (e.type === "status") {
      this.busy = e.state !== "idle";
      this.refreshMenu();
      return;
    }
    const where = this.opts.project() ? `「${this.opts.project()}」` : "";
    if (e.type === "done") {
      if (e.reason === "end_turn") this.notify("AI 做完了", `${where}这一轮的工作完成了，回来看看结果吧。`);
      else if (e.reason === "step_limit") this.notify("AI 先停下了", `${where}已经做了很多步，停下来等你看一眼再继续。`);
    } else if (e.type === "approval_request" && !e.autoApproved) {
      // With the island showing, approvals happen there; no second popup.
      if (this.opts.island.enabled() && !this.opts.island.snoozed()) return;
      this.notify("AI 在等你确认", `${where}${approvalText(e.subject)}`);
    } else if (e.type === "question") {
      if (this.opts.island.enabled() && !this.opts.island.snoozed()) return;
      this.notify("AI 有问题想问你", `${where}${e.intro ?? e.questions[0]?.question ?? "回来回答一下吧。"}`);
    } else if (e.type === "error") {
      this.notify("AI 出错了", e.message.slice(0, 120));
    }
  }

  /**
   * A system notification; clicking it brings the window back. Skipped while the window is in
   * front (the user sees it there) unless `always`.
   */
  notify(title: string, body: string, always = false): void {
    if (!this.settings.notify || !Notification.isSupported()) return;
    const win = this.opts.window();
    if (!always && win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
    const n = new Notification({ title, body, silent: false });
    this.live.add(n);
    n.on("click", () => {
      this.live.delete(n);
      this.show();
    });
    n.on("close", () => this.live.delete(n));
    n.show();
  }

  private createTray(): void {
    let icon = nativeImage.createFromPath(trayIconFile);
    // Menu bar / tray icons are small; the app icon scaled down keeps the brand colour.
    icon = icon.resize({ width: process.platform === "darwin" ? 18 : 16, height: process.platform === "darwin" ? 18 : 16 });
    this.tray = new Tray(icon);
    this.tray.setToolTip("sikeoop");
    // Windows / Linux: a left click opens the window; the menu is on right click.
    if (process.platform !== "darwin") this.tray.on("click", () => this.show());
    this.refreshMenu();
  }

  /** Rebuilds the tray menu (a switch changed elsewhere). */
  refreshMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: "打开 sikeoop", click: () => this.show() },
      { label: this.busy ? "● AI 正在工作…" : "AI 空闲", enabled: false },
      { type: "separator" },
      {
        label: "关闭窗口时留在后台",
        type: "checkbox",
        checked: this.settings.closeToTray,
        click: (item) => void this.save({ closeToTray: item.checked }),
      },
      {
        label: "灵动岛",
        type: "checkbox",
        checked: this.opts.island.enabled(),
        click: (item) => this.opts.island.set(item.checked),
      },
      ...(this.opts.island.enabled()
        ? [
            this.opts.island.snoozed()
              ? { label: "重新显示灵动岛", click: () => this.opts.island.snooze(0) }
              : { label: "暂时隐藏灵动岛（1 小时）", click: () => this.opts.island.snooze(3600_000) },
          ]
        : []),
      {
        label: "通知提醒",
        type: "checkbox",
        checked: this.settings.notify,
        click: (item) => void this.save({ notify: item.checked }),
      },
      { type: "separator" },
      {
        label: "退出 sikeoop",
        click: () => {
          this.quitting = true;
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(this.busy ? "sikeoop · AI 正在工作" : "sikeoop");
  }

  private async save(change: Partial<BackgroundSettings>): Promise<void> {
    this.settings = { ...this.settings, ...change };
    this.refreshMenu();
    await fs.writeFile(this.opts.settingsFile, JSON.stringify(this.settings), "utf8").catch(() => {});
  }
}

function approvalText(s: Extract<AgentEvent, { type: "approval_request" }>["subject"]): string {
  if (s.kind === "file") return `想修改 ${s.change.path}`;
  if (s.kind === "command") return `想运行命令：${s.command.command.slice(0, 80)}`;
  return `想使用工具 ${s.call.server} · ${s.call.tool}`;
}
