import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { PlanItem, UnfinishedTask } from "@shared/types";

// At startup: the newest conversation of each recent project whose plan still has open steps,
// so sikeoop can ask whether to pick it up again. "Not now" lasts for this launch only;
// "don't ask again" is remembered for that conversation until it changes.

interface SessionLike {
  id: string;
  title: string;
  updatedAt: number;
  provider: { id: string; name: string };
  plan?: PlanItem[];
}

export class ResumeStore {
  constructor(private readonly file: string) {}

  private async dismissed(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  /** Stop asking about this conversation, unless it is worked on again later. */
  async dismiss(sessionId: string, updatedAt: number): Promise<void> {
    const all = await this.dismissed();
    all[sessionId] = updatedAt;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(all), "utf8");
  }

  async pending(
    projects: string[],
    sessionFiles: (root: string) => Promise<string[]>,
    limit = 3,
  ): Promise<UnfinishedTask[]> {
    const dismissed = await this.dismissed();
    const out: UnfinishedTask[] = [];
    for (const root of projects) {
      if (!existsSync(root)) continue;
      const newest = await newestSession(await sessionFiles(root));
      if (!newest?.plan?.length || dismissed[newest.id] === newest.updatedAt) continue;
      const open = newest.plan.filter((p) => p.status === "pending" || p.status === "in_progress");
      if (!open.length) continue;
      out.push({
        root,
        project: path.basename(root),
        sessionId: newest.id,
        title: newest.title,
        updatedAt: newest.updatedAt,
        providerId: newest.provider.id,
        providerName: newest.provider.name,
        done: newest.plan.length - open.length,
        total: newest.plan.length,
        remaining: open.map((p) => p.text),
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

async function newestSession(files: string[]): Promise<SessionLike | null> {
  let best: { file: string; mtime: number } | null = null;
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null);
    if (st && (!best || st.mtimeMs > best.mtime)) best = { file: f, mtime: st.mtimeMs };
  }
  if (!best) return null;
  try {
    return JSON.parse(await fs.readFile(best.file, "utf8")) as SessionLike;
  } catch {
    return null;
  }
}
