import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DispatchJob } from "@shared/types";

// The dispatch console's history, one log per project: userData/dispatch/<sha16(root)>/jobs.jsonl.
// A line is appended each time a job's status changes (queued, running, waiting for approval, its
// end), and again whenever a finished job is touched (marked for review, a late result). Progress
// is dropped from unfinished lines and trimmed to the last 20 on finished ones. On load the last
// line per job wins, and a job that never got its end line (the app quit or crashed meanwhile) is
// shown as exited.

const FINISHED = new Set<DispatchJob["status"]>(["done", "failed", "cancelled", "timeout", "exited"]);
const KEEP_PROGRESS = 20;

/** What a line keeps: no progress while it runs; the last few, without permission cards, once it ends. */
function slim(job: DispatchJob): DispatchJob {
  if (!FINISHED.has(job.status)) {
    const { progress: _, ...rest } = job;
    return rest;
  }
  if (!job.progress) return job;
  return { ...job, progress: job.progress.slice(-KEEP_PROGRESS).map(({ permission: _, ...p }) => p) };
}

export class JobLog {
  private readonly dir: string;
  /** Writes in order, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  /** Unfinished jobs → the project each is logged in. */
  private readonly roots = new Map<string, string>();
  /** Unfinished jobs → the status last written, so an unchanged one isn't written again. */
  private readonly written = new Map<string, DispatchJob["status"]>();

  // No parameter properties: dispatch/ is tested under Node's type stripping.
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(root: string): string {
    return path.join(this.dir, createHash("sha256").update(root).digest("hex").slice(0, 16), "jobs.jsonl");
  }

  /**
   * Logs a job's status change; an unfinished job whose status is unchanged is skipped, a finished
   * one is always written. Its project is settled the first time it is
   * seen: the folder it works in, else the project open then. Opening another project while it
   * runs doesn't split its start and end across two logs.
   */
  record(job: DispatchJob, openRoot: string | null): Promise<void> {
    const root = this.roots.get(job.id) ?? job.scope?.roots[0] ?? openRoot;
    if (!root) return Promise.resolve();
    if (FINISHED.has(job.status)) {
      this.roots.delete(job.id);
      this.written.delete(job.id);
    } else {
      this.roots.set(job.id, root);
      if (this.written.get(job.id) === job.status) return Promise.resolve();
      this.written.set(job.id, job.status);
    }
    return this.append(root, slim(job));
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
      .map((j) =>
        FINISHED.has(j.status)
          ? j
          : {
              ...j,
              status: "exited" as const,
              endedAt: j.endedAt ?? j.startedAt ?? j.createdAt,
              error: j.error ?? (j.startedAt === undefined ? "应用关闭时还在排队，没有派出去" : "应用关闭时它还没做完"),
            },
      )
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
