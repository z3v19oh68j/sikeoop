import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "@shared/types";

// App updates from the site's download folder (package.json build.publish: a generic server, so
// electron-builder writes latest.yml / latest-mac.yml next to the installers). electron-updater
// checks the sha512 in those files before installing anything.
//   Windows installer: downloads in the background (block-level, only the changed parts), installs
//   when the person restarts or quits.
//   macOS (ad-hoc signed, not notarized) and the Windows portable build can't replace themselves:
//   they only learn that a new version exists and open the download page.

const { autoUpdater } = electronUpdater;
const DOWNLOAD_PAGE = "https://sikeoop.modgert.online/#download";
const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 6 * 60 * 60_000;

export class Updater {
  private state: UpdateState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onChange: (s: UpdateState) => void;

  constructor(onChange: (s: UpdateState) => void) {
    this.onChange = onChange;
    this.state = { status: "idle", current: app.getVersion(), canInstall: canInstall(), autoDownload: readAutoDownload() };
  }

  /** Off: a found version waits for the person to press download (it still installs on quit once downloaded). */
  async setAutoDownload(on: boolean): Promise<UpdateState> {
    autoUpdater.autoDownload = this.state.canInstall && on;
    this.set({ autoDownload: on });
    await fs.writeFile(prefsFile(), JSON.stringify({ autoDownload: on }), "utf8").catch(() => {});
    return this.state;
  }

  /** Download the version found while automatic download was off. */
  async download(): Promise<UpdateState> {
    if (this.state.status !== "available" || !this.state.canInstall) return this.state;
    this.set({ status: "downloading", percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.set({ status: "error", error: friendly(e) });
    }
    return this.state;
  }

  get(): UpdateState {
    return this.state;
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  start(): void {
    // Development runs from source: nothing to update.
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = this.state.canInstall && this.state.autoDownload;
    autoUpdater.autoInstallOnAppQuit = this.state.canInstall;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: undefined }));
    autoUpdater.on("update-not-available", () => this.set({ status: "none" }));
    autoUpdater.on("update-available", (info) =>
      this.set({
        status: this.state.canInstall && this.state.autoDownload ? "downloading" : "available",
        version: info.version,
        notes: notesOf(info.releaseNotes),
        percent: 0,
      }),
    );
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.set({ status: "ready", version: info.version, percent: 100 }));
    autoUpdater.on("error", (e) => this.set({ status: "error", error: friendly(e) }));
    const first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    first.unref?.();
    this.timer = setInterval(() => void this.check(), EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) {
      this.set({ status: "none" });
      return this.state;
    }
    // Already downloading or downloaded: nothing new to ask for.
    if (this.state.status === "downloading" || this.state.status === "ready") return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set({ status: "error", error: friendly(e) });
    }
    return this.state;
  }

  /** Restarts into the downloaded version (Windows installer only). */
  install(): void {
    if (this.state.status !== "ready" || !this.state.canInstall) return;
    this.set({ status: "installing" });
    autoUpdater.quitAndInstall(false, true);
  }

  openDownload(): Promise<void> {
    return shell.openExternal(DOWNLOAD_PAGE);
  }
}

const prefsFile = () => path.join(app.getPath("userData"), "update.json");

/** Automatic download is on unless the person turned it off. */
function readAutoDownload(): boolean {
  try {
    return (JSON.parse(readFileSync(prefsFile(), "utf8")) as { autoDownload?: unknown }).autoDownload !== false;
  } catch {
    return true;
  }
}

/** Only the Windows NSIS install can replace itself: not macOS (unsigned), not the portable exe. */
function canInstall(): boolean {
  return process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function notesOf(notes: unknown): string | undefined {
  const text = typeof notes === "string" ? notes : Array.isArray(notes) ? notes.map((n) => (n as { note?: string }).note ?? "").join("\n") : "";
  const plain = text.replace(/<[^>]+>/g, "").trim();
  return plain ? plain.slice(0, 8000) : undefined;
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(m)) return "连不上更新服务器，稍后会再试";
  if (/sha512|checksum/i.test(m)) return "下载的更新文件校验不对，已丢弃";
  if (/404/.test(m)) return "服务器上还没有更新信息";
  return m.slice(0, 200);
}
