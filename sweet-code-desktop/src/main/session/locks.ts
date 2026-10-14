import { realFile } from "./scope.ts";

const TTL = 10 * 60_000;
/** Use the shared `fileLocks` below; it covers PeerBus sessions and sikeoop's own write tools alike. */
export class FileLocks {
  private readonly held = new Map<string, { owner: string; until: number }>();
  private readonly timer = setInterval(() => this.sweep(), 30_000);
  constructor() { this.timer.unref(); }
  private sweep(): void {
    const now = Date.now();
    for (const [file, lock] of this.held) if (lock.until <= now) this.held.delete(file);
  }
  async acquire(owner: string, files: string[]): Promise<{ ok: true } | { ok: false; path: string; owner: string }> {
    const keys = await Promise.all(files.map(realFile));
    this.sweep();
    for (const file of keys) {
      const lock = this.held.get(file);
      if (lock && lock.owner !== owner) return { ok: false, path: file, owner: lock.owner };
    }
    for (const file of keys) this.held.set(file, { owner, until: Date.now() + TTL });
    return { ok: true };
  }
  /** Renew live locks only; an expired lock must be acquired again. */
  touch(owner: string): void {
    this.sweep();
    const until = Date.now() + TTL;
    for (const lock of this.held.values()) if (lock.owner === owner) lock.until = until;
  }
  release(owner: string): void {
    for (const [file, lock] of this.held) if (lock.owner === owner) this.held.delete(file);
  }
  close(): void { clearInterval(this.timer); this.held.clear(); }
}

/** The one lock table for every agent that writes files (CLI sessions and sikeoop's own sessions). */
export const fileLocks = new FileLocks();
