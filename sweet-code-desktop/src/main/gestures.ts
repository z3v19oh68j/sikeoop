import { systemPreferences } from "electron";

// Mouse gestures that start a screenshot from anywhere, not just inside sikeoop:
//   macOS: four quick clicks / taps with the trackpad (or mouse) in the same spot;
//   Windows: a mouse side button (back = 4, forward = 5).
// Global mouse input needs a native hook (uiohook-napi). It only watches; the click still
// reaches the app under the pointer, which cannot be prevented from here.

/** Clicks closer together than this (ms) and nearer than this (px) count as one run. */
const CLICK_GAP = 350;
const CLICK_SLOP = 8;
const CLICKS = 4;

import { acquireHook, releaseHook, type Hook } from "./hook";

export class SnipGestures {
  private hook: Hook | null = null;
  private running = false;
  private sideButton: 4 | 5 = 5;
  private run = { count: 0, at: 0, x: 0, y: 0 };

  constructor(private readonly onTrigger: () => void) {}

  /** Which side button triggers (Windows): 4 = back, 5 = forward. */
  setSideButton(b: 4 | 5): void {
    this.sideButton = b;
  }

  /**
   * Starts watching. Returns a message for the user when it can't (permission, missing module).
   * `ask`: show macOS's permission prompt when access is missing (only when the user just switched
   * it on, never at startup).
   */
  start(ask = false): string | null {
    if (this.running) return null;
    if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
      // Shows the system prompt that leads to Privacy & Security › Accessibility.
      if (ask) systemPreferences.isTrustedAccessibilityClient(true);
      return "需要在「系统设置 › 隐私与安全性 › 辅助功能」里允许 sikeoop，然后重新打开 sikeoop";
    }
    try {
      this.hook = acquireHook("gestures");
    } catch (err) {
      return `鼠标手势没能启动：${(err as Error).message}`;
    }
    const hook = this.hook;
    hook.removeAllListeners("mousedown");
    hook.on("mousedown", (e) => {
      const button = Number(e.button);
      if (process.platform === "darwin") {
        if (button !== 1) return;
        const now = Date.now();
        const near = Math.abs(e.x - this.run.x) <= CLICK_SLOP && Math.abs(e.y - this.run.y) <= CLICK_SLOP;
        this.run = now - this.run.at <= CLICK_GAP && near ? { count: this.run.count + 1, at: now, x: e.x, y: e.y } : { count: 1, at: now, x: e.x, y: e.y };
        if (this.run.count === CLICKS) {
          this.run.count = 0;
          this.onTrigger();
        }
      } else if (button === this.sideButton) {
        this.onTrigger();
      }
    });
    this.running = true;
    return null;
  }

  stop(): void {
    if (!this.running || !this.hook) return;
    this.running = false;
    this.hook.removeAllListeners("mousedown");
    releaseHook("gestures");
  }
}
