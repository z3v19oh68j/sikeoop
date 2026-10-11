// For a CLI that can't report the end of a turn: the turn is over when its terminal has printed
// something and then stayed quiet for a while. Crude (a long silent tool call ends the turn early,
// a spinner that never stops ends it never), so it is the fallback, not the default. Pure, for tests.

const TAIL = 4000;
/** Colours, cursor moves, window titles: everything a terminal understands and a reader doesn't. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function plainTail(output: string, max = 1200): string {
  const lines = output.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(-max);
}

export class QuietWatch {
  private readonly ms: number;
  private readonly onQuiet: (tail: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armed = false;
  private seen = false;
  private tail = "";

  constructor(ms: number, onQuiet: (tail: string) => void) {
    this.ms = ms;
    this.onQuiet = onQuiet;
  }

  /**
   * A prompt went in (or the program just started): the next silence ends the turn. The silence
   * counts from the first output after this, or from now when `fromNow` (nothing may be printed).
   */
  arm(fromNow = false): void {
    this.armed = true;
    this.seen = fromNow;
    this.tail = "";
    this.clear();
    if (fromNow) {
      this.timer = setTimeout(() => this.fire(), this.ms);
      this.timer.unref?.();
    }
  }

  output(data: string): void {
    if (!this.armed || !data) return;
    this.seen = true;
    this.tail = (this.tail + data).slice(-TAIL);
    this.clear();
    this.timer = setTimeout(() => this.fire(), this.ms);
    this.timer.unref?.();
  }

  stop(): void {
    this.armed = false;
    this.clear();
  }

  private fire(): void {
    this.timer = null;
    if (!this.armed || !this.seen) return;
    this.armed = false;
    this.onQuiet(plainTail(this.tail));
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
