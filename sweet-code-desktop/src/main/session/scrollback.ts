// The last stretch of a terminal's output, kept so a viewer that attaches later (the read-only
// tab of a cross-project session's member) sees what is already on screen. No imports: it is
// tested on its own under node --test.

/** Characters kept per terminal. */
export const SCROLLBACK_LIMIT = 256 * 1024;
/** After the oldest output was dropped, the replay starts at the next line break found this close to the cut. */
const LINE_SEARCH = 4096;
/** Full reset (RIS): whatever the viewer already shows is cleared before the replay. */
const RESET = "\x1bc";

export class Scrollback {
  private chunks: string[] = [];
  private size = 0;
  private cut = false;
  private readonly limit: number;

  constructor(limit: number = SCROLLBACK_LIMIT) {
    this.limit = limit;
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit) {
      const head = this.chunks[0];
      const over = this.size - this.limit;
      this.cut = true;
      if (head.length <= over) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.slice(over);
        this.size -= over;
      }
    }
  }

  /** What is kept, oldest first. Once output was dropped it starts on a whole line where it can. */
  text(): string {
    const all = this.chunks.join("");
    this.chunks = all ? [all] : [];
    if (!this.cut) return all;
    const nl = all.slice(0, LINE_SEARCH).indexOf("\n");
    return nl < 0 ? all : all.slice(nl + 1);
  }

  /** What to send a viewer that attaches now: a reset, then everything kept. Live output follows it. */
  replay(): string {
    return RESET + this.text();
  }
}
