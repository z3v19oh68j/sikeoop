import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchJob } from "@shared/types";

// The dispatch console's history, one log per project: userData/dispatch/<sha16(root)>/jobs.jsonl.
// A job is appended when it starts and when it ends; on load the last line per job wins, and a job
// that never got its end line (the app quit or crashed meanwhile) is shown as exited.

const FINISHED = new Set<DispatchJob["status"]>(["done", "failed", "cancelled", "timeout", "exited"]);

export class JobLog {
  private readonly dir: string;
  /** Writes in order, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  /** Unfinished jobs → the project each is logged in. */
  private readonly roots = new Map<string, string>();

  // No parameter properties: dispatch/ is tested under Node's type stripping.
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(root: string): string {
    return path.join(this.dir, createHash("sha256").update(root).digest("hex").slice(0, 16), "jobs.jsonl");
  }

  /**
   * Logs a job's change (queued ones are only noted). Its project is settled the first time it is
   * seen: the folder it works in, else the project open then. Opening another project while it
   * runs doesn't split its start and end across two logs.
   */
  record(job: DispatchJob, openRoot: string | null): Promise<void> {
    const root = this.roots.get(job.id) ?? job.scope?.roots[0] ?? openRoot;
    if (!root) return Promise.resolve();
    if (FINISHED.has(job.status)) this.roots.delete(job.id);
    else this.roots.set(job.id, root);
    return job.status === "queued" ? Promise.resolve() : this.append(root, job);
  }

  append(root: string, job: DispatchJob): Promise<void> {
    const file = this.file(root);
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, JSON.stringify(job) + "\n", "utf8");
      })
      .catch(() => {});
    return this.chain;
  }

  /** The newest `keep` jobs, newest first. Rewrites the file when it has grown well past that. */
  async load(root: string, keep: number): Promise<DispatchJob[]> {
    const file = this.file(root);
    await this.chain;
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter(Boolean);
    const byId = new Map<string, DispatchJob>();
    for (const line of lines) {
      try {
        const job = JSON.parse(line) as DispatchJob;
        if (typeof job?.id !== "string" || typeof job.status !== "string") continue;
        byId.delete(job.id);
        byId.set(job.id, job);
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    const jobs = [...byId.values()]
      .map((j) => (FINISHED.has(j.status) ? j : { ...j, status: "exited" as const, endedAt: j.endedAt ?? j.startedAt, error: j.error ?? "应用关闭时它还没做完" }))
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
      .slice(0, keep);
    if (lines.length > keep * 4) await this.rewrite(file, [...jobs].reverse());
    return jobs;
  }

  private async rewrite(file: string, jobs: DispatchJob[]): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    this.chain = this.chain
      .then(async () => {
        await fs.writeFile(tmp, jobs.map((j) => JSON.stringify(j) + "\n").join(""), "utf8");
        await fs.rename(tmp, file);
      })
      .catch(() => {});
    await this.chain;
  }
}
