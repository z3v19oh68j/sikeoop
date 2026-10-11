import os from "node:os";
import type { WebContents } from "electron";
import * as pty from "node-pty";
import { GIT_BASH_MISSING, bashEnv, terminalShell } from "./shell-env";
import { isSessionMarker } from "./workspace-mode/launch";
import { Scrollback } from "./session/scrollback";

/**
 * The user's own terminal panel: a real pseudo-terminal running their shell in
 * the project folder. The agent never types here; its commands run separately
 * through run_command, so the two can't interfere.
 */
export class TerminalHost {
  /** One pseudo-terminal per tab. */
  private procs = new Map<string, pty.IPty>();
  /** Each tab's recent output, for a viewer that attaches after it was printed. */
  private buffers = new Map<string, Scrollback>();
  /** Tabs a viewer is about to open: its first resize gets the replay. */
  private viewers = new Set<string>();

  constructor(
    private readonly target: () => WebContents | undefined,
    /** Sees every chunk of terminal output and the tab it came from (the built-in browser watches for dev server addresses). */
    private readonly onOutput?: (data: string, tab: string) => void,
  ) {}

  /** Returns a message to show instead of a prompt when no shell can be started. */
  start(tab: string, cwd: string | null, cols: number, rows: number): { ok: boolean; message?: string } {
    const shell = terminalShell();
    if (!shell) {
      this.kill(tab);
      return { ok: false, message: GIT_BASH_MISSING };
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !isSessionMarker(k)));
    this.spawn(tab, shell.file, shell.args, cwd ?? os.homedir(), cols, rows, {
      ...env,
      ...bashEnv(),
      TERM_PROGRAM: "SweetCode",
      COLORTERM: "truecolor",
    } as Record<string, string>);
    return { ok: true };
  }

  /** Runs one program (Claude Code, Codex) in a tab instead of the shell, with exactly this environment. */
  startProgram(tab: string, file: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number, onExit?: () => void): void {
    this.spawn(tab, file, args, cwd, cols, rows, env, onExit);
  }

  private spawn(tab: string, file: string, args: string[], cwd: string, cols: number, rows: number, env: Record<string, string>, onExit?: () => void): void {
    this.kill(tab);
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd,
      env,
    });
    const buffer = new Scrollback();
    this.buffers.set(tab, buffer);
    proc.onData((data) => {
      buffer.push(data);
      this.target()?.send("term:data", tab, data);
      this.onOutput?.(data, tab);
    });
    proc.onExit(({ exitCode }) => {
      // A newer program may already have replaced this one in the tab.
      if (this.procs.get(tab) === proc) {
        this.procs.delete(tab);
        this.target()?.send("term:exit", tab, exitCode);
        // Only when it ended by itself: a replaced program's late exit must not end the new one.
        onExit?.();
      }
    });
    this.procs.set(tab, proc);
  }

  write(tab: string, data: string): void {
    this.procs.get(tab)?.write(data);
  }

  resize(tab: string, cols: number, rows: number): void {
    // Before the resize, so what the program redraws for the new size comes after the replay.
    if (this.viewers.delete(tab)) this.target()?.send("term:data", tab, this.buffers.get(tab)?.replay() ?? "");
    if (cols > 0 && rows > 0) this.procs.get(tab)?.resize(cols, rows);
  }

  /** The tab's recent output (at most Scrollback's limit), or "" when it never ran. */
  scrollback(tab: string): string {
    return this.buffers.get(tab)?.text() ?? "";
  }

  /**
   * A viewer is being opened on a tab that is already running (a session member's, read-only).
   * When it reports its size, it is sent a reset and the tab's recent output, once; live output
   * continues after that.
   */
  expectViewer(tab: string): void {
    if (this.buffers.has(tab)) this.viewers.add(tab);
  }

  /**
   * Ends the tab's program. Silent by default: whoever closed the tab knows. With `notice`, a
   * running program's end is reported as term:exit with that code (a session member's tab, which
   * the user may be watching read-only).
   */
  kill(tab: string, notice?: number): void {
    const p = this.procs.get(tab);
    if (p && notice !== undefined) this.target()?.send("term:exit", tab, notice);
    this.procs.delete(tab);
    this.buffers.delete(tab);
    this.viewers.delete(tab);
    p?.kill();
  }

  killAll(): void {
    for (const tab of [...this.procs.keys()]) this.kill(tab);
  }
}
