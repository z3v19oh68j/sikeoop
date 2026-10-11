import { promises as fs } from "node:fs";
import path from "node:path";
import type { RegressBaseline, RegressItem, RegressRun, RegressSettings } from "@shared/types";
import { clampSettings, DEFAULT_SETTINGS } from "./view.ts";

// The regression panel's files, in the open project's .sikeoop/regress/ (.claude/regress-plan.md):
//   items.json           RegressItem[], written whole (tmp + rename)
//   runs.jsonl           one RegressRun per line, append only; the last line of an id is the run
//   baselines/<id>.json  one RegressBaseline, never changed once written
//   replies/<runId>.txt  a session's reply, its last 64KB
//   settings.json        RegressSettings
// Only ever given a project root by the main process; ids are checked before they become file
// names; nothing here follows a symlink out of the project.

/** Ids are made by the main process; ones that come back from the window are checked against this. */
export const ID = /^[a-z0-9-]{8,40}$/;
export const validId = (id: unknown): id is string => typeof id === "string" && ID.test(id);
const REPLY_BYTES = 64 * 1024;

export class RegressStore {
  /** Writes happen one at a time, in the order they were asked for. */
  private chain: Promise<unknown> = Promise.resolve();

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * The project's .sikeoop/regress folder (or a folder inside it), made if `create`. Null when it
   * doesn't exist and isn't to be made. Refuses a symlink anywhere on the way.
   */
  private async folder(root: string, create: boolean, sub?: "baselines" | "replies"): Promise<string | null> {
    const real = await fs.realpath(root);
    let dir = real;
    for (const part of [".sikeoop", "regress", ...(sub ? [sub] : [])]) {
      dir = path.join(dir, part);
      const st = await fs.lstat(dir).catch(() => null);
      if (st?.isSymbolicLink()) throw new Error(`${part} 是符号链接，回归面板不会跟着它读写`);
      if (st && !st.isDirectory()) throw new Error(`${part} 不是文件夹`);
      if (!st) {
        if (!create) return null;
        await fs.mkdir(dir);
      }
    }
    const inside = path.relative(real, await fs.realpath(dir));
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("回归数据目录不在项目里");
    return dir;
  }

  /** A file in the folder that is not a symlink. */
  private async file(dir: string, name: string): Promise<string> {
    const target = path.join(dir, name);
    const st = await fs.lstat(target).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`${name} 是符号链接，回归面板不会跟着它读写`);
    return target;
  }

  private async read(root: string, name: string, sub?: "baselines" | "replies"): Promise<string | null> {
    // After whatever is still being written.
    await this.chain;
    const dir = await this.folder(root, false, sub);
    if (!dir) return null;
    return fs.readFile(await this.file(dir, name), "utf8").catch(() => null);
  }

  private async writeWhole(root: string, name: string, text: string, sub?: "baselines" | "replies"): Promise<void> {
    const dir = (await this.folder(root, true, sub))!;
    const target = await this.file(dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, target);
  }

  async items(root: string): Promise<RegressItem[]> {
    const text = await this.read(root, "items.json");
    if (!text) return [];
    try {
      const list = JSON.parse(text);
      return Array.isArray(list) ? list.filter(isItem) : [];
    } catch {
      return [];
    }
  }

  saveItems(root: string, items: RegressItem[]): Promise<void> {
    return this.queued(() => this.writeWhole(root, "items.json", JSON.stringify(items, null, 2)));
  }

  /** Every run, oldest first. A run changed later (a verdict overridden) is its last line. */
  async runs(root: string): Promise<RegressRun[]> {
    await this.chain;
    const text = await this.read(root, "runs.jsonl");
    const byId = new Map<string, RegressRun>();
    for (const line of (text ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line);
        if (isRun(run)) byId.set(run.id, run);
      } catch {
        // A torn or damaged line: skipped.
      }
    }
    return [...byId.values()];
  }

  appendRun(root: string, run: RegressRun): Promise<void> {
    return this.queued(async () => {
      const dir = (await this.folder(root, true))!;
      await fs.appendFile(await this.file(dir, "runs.jsonl"), JSON.stringify(run) + "\n", "utf8");
    });
  }

  async baselines(root: string): Promise<RegressBaseline[]> {
    await this.chain;
    const dir = await this.folder(root, false, "baselines");
    if (!dir) return [];
    const out: RegressBaseline[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json") || !validId(name.slice(0, -5))) continue;
      try {
        const b = JSON.parse(await fs.readFile(await this.file(dir, name), "utf8"));
        if (b && b.id === name.slice(0, -5) && typeof b.name === "string" && typeof b.createdAt === "number" && typeof b.results === "object" && b.results) out.push(b);
      } catch {
        // Unreadable: not listed.
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  saveBaseline(root: string, baseline: RegressBaseline): Promise<void> {
    return this.queued(() => this.writeWhole(root, `${baseline.id}.json`, JSON.stringify(baseline, null, 2), "baselines"));
  }

  deleteBaseline(root: string, id: string): Promise<void> {
    return this.queued(async () => {
      const dir = await this.folder(root, false, "baselines");
      if (dir) await fs.rm(await this.file(dir, `${id}.json`), { force: true });
    });
  }

  reply(root: string, runId: string): Promise<string | null> {
    return this.read(root, `${runId}.txt`, "replies");
  }

  /** Keeps the end of a long reply: that is where the verdict is. */
  saveReply(root: string, runId: string, text: string): Promise<void> {
    const bytes = Buffer.from(text, "utf8");
    // A cut may land inside a character; the broken start is dropped.
    const kept = bytes.length > REPLY_BYTES ? bytes.subarray(bytes.length - REPLY_BYTES).toString("utf8").replace(/^�+/, "") : text;
    return this.queued(() => this.writeWhole(root, `${runId}.txt`, kept, "replies"));
  }

  async settings(root: string): Promise<RegressSettings> {
    const text = await this.read(root, "settings.json");
    if (!text) return { ...DEFAULT_SETTINGS };
    try {
      return clampSettings(JSON.parse(text));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(root: string, settings: RegressSettings): Promise<void> {
    return this.queued(() => this.writeWhole(root, "settings.json", JSON.stringify(settings, null, 2)));
  }
}

function isItem(v: unknown): v is RegressItem {
  const i = v as RegressItem;
  return !!i && validId(i.id) && typeof i.title === "string" && typeof i.detail === "string" && typeof i.criteria === "string" && typeof i.owner === "string";
}

function isRun(v: unknown): v is RegressRun {
  const r = v as RegressRun;
  return !!r && validId(r.id) && validId(r.itemId) && typeof r.session === "string" && (r.cli === "claude" || r.cli === "codex") && typeof r.status === "string" && typeof r.startedAt === "number";
}
