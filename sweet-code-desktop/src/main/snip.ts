import { BrowserWindow, type NativeImage, desktopCapturer, ipcMain, screen, shell, systemPreferences } from "electron";

// Screenshot for the island: freeze the screen under the pointer, let the user drag a box over
// it in a full-screen overlay (Enter = whole screen, Esc = cancel), and return the cropped image.

export class NeedsPermission extends Error {}

export class Snipper {
  private busy = false;

  constructor(
    private readonly opts: {
      preload: string;
      /** Loads the overlay page into the window. */
      load(win: BrowserWindow): void;
    },
  ) {}

  /** The chosen area, or null when cancelled. Throws NeedsPermission without screen access (macOS). */
  async capture(): Promise<NativeImage | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
        throw new NeedsPermission("截图需要「屏幕录制」权限");
      }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const { width, height } = display.size;
      const scale = display.scaleFactor;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      const shot = source?.thumbnail;
      if (!shot || shot.isEmpty()) {
        // macOS without permission returns an empty image (or only the wallpaper).
        if (process.platform === "darwin") throw new NeedsPermission("截图需要「屏幕录制」权限");
        throw new Error("没能截到屏幕");
      }
      const rect = await this.select(display.bounds, shot);
      if (!rect) return null;
      if (!rect.width || !rect.height) return shot;
      // Overlay CSS px → image px.
      const k = shot.getSize().width / display.bounds.width;
      const r = {
        x: Math.round(rect.x * k),
        y: Math.round(rect.y * k),
        width: Math.max(1, Math.round(rect.width * k)),
        height: Math.max(1, Math.round(rect.height * k)),
      };
      return shot.crop(r);
    } finally {
      this.busy = false;
    }
  }

  /** Opens System Settings at the Screen Recording page (macOS). */
  static openPermissionSettings(): void {
    if (process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }

  /** Shows the frozen screen full-screen and waits for a box (or Enter / Esc). */
  private select(bounds: Electron.Rectangle, shot: NativeImage): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        ...bounds,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        show: false,
        backgroundColor: "#000000",
        webPreferences: { preload: this.opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());

      let settled = false;
      const finish = (rect: { x: number; y: number; width: number; height: number } | null) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener("snip:done", onDone);
        if (!win.isDestroyed()) win.destroy();
        resolve(rect);
      };
      const onDone = (e: Electron.IpcMainEvent, rect: unknown) => {
        if (e.sender !== win.webContents) return;
        const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        if (!r || [r.x, r.y, r.width, r.height].some((v) => typeof v !== "number" || !Number.isFinite(v))) return finish(null);
        finish({ x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number });
      };
      ipcMain.on("snip:done", onDone);
      win.on("closed", () => finish(null));

      win.webContents.on("did-finish-load", () => {
        win.webContents.send("snip:image", shot.toDataURL());
        win.setBounds(bounds);
        win.show();
        win.focus();
      });
      this.opts.load(win);
    });
  }
}
