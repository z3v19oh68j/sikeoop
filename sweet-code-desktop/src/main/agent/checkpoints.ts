import { promises as fs } from "node:fs";
import type { UndoResult } from "@shared/types";
import { resolveSafe } from "../workspace";

interface Entry {
  /** Content before the turn's first write; null when the turn created the file. */
  before: string | null;
  /** Content after the turn's last write. */
  after: string;
}

/**
 * Remembers what each turn's writes replaced, so the whole turn can be undone.
 * Only files the agent wrote are tracked. An undo is skipped for any file that
 * changed again afterwards (by the user or a later turn), so nobody's newer
 * work is silently thrown away.
 */
export class CheckpointStore {
  private turns = new Map<number, Map<string, Entry>>();

  record(turnId: number, path: string, before: string | null, after: string): void {
    let files = this.turns.get(turnId);
    if (!files) this.turns.set(turnId, (files = new Map()));
    const prev = files.get(path);
    // Keep the original "before" across several edits to the same file in one turn.
    files.set(path, { before: prev ? prev.before : before, after });
  }

  files(turnId: number): { path: string; created: boolean }[] {
    return [...(this.turns.get(turnId) ?? [])].map(([path, e]) => ({ path, created: e.before === null }));
  }

  /** Restore every file of the turn. onRestored reports each file's new content (null = deleted). */
  async undo(turnId: number, onRestored: (path: string, content: string | null) => void): Promise<UndoResult> {
    const files = this.turns.get(turnId);
    if (!files) return { restored: [], skipped: [{ path: "", reason: "这一轮的改动已经撤销过了" }] };
    const result: UndoResult = { restored: [], skipped: [] };
    for (const [path, e] of files) {
      try {
        const abs = await resolveSafe(path);
        let now: string | null;
        try {
          now = await fs.readFile(abs, "utf8");
        } catch {
          now = null;
        }
        if (now !== e.after) {
          result.skipped.push({ path, reason: now === null ? "文件已经被删掉了" : "之后又被改过，为了不丢掉新改动，保持原样" });
          continue;
        }
        if (e.before === null) await fs.rm(abs);
        else await fs.writeFile(abs, e.before, "utf8");
        result.restored.push(path);
        onRestored(path, e.before);
      } catch (err) {
        result.skipped.push({ path, reason: (err as Error).message });
      }
    }
    this.turns.delete(turnId);
    return result;
  }

  clear(): void {
    this.turns.clear();
  }

  /** Plain JSON for saving with the conversation, so undo still works after a restart. */
  export(): [number, [string, Entry][]][] {
    return [...this.turns].map(([turn, files]) => [turn, [...files]]);
  }

  import(data: [number, [string, Entry][]][]): void {
    this.turns = new Map(data.map(([turn, files]) => [turn, new Map(files)]));
  }
}
