import { randomUUID } from "node:crypto";
import type { ClusterRun, ClusterView } from "@shared/types";

// Records every dispatch to a Harmony cluster role for the cluster console and the island.
// It only sees what index.ts reports (start, live activity, the final envelope); it never
// touches a role's session.

/** Dispatches kept in the console; the oldest finished ones go first. */
const KEEP = 100;

export class ClusterMonitor {
  /** Newest first. */
  private runs: ClusterRun[] = [];
  private batchTotal = 0;
  private batchDone = 0;
  private batchFailed = 0;

  constructor(private opts: { onChange(view: ClusterView): void }) {}

  start(role: string, goal: string): string {
    if (this.running() === 0) {
      this.batchTotal = 0;
      this.batchDone = 0;
      this.batchFailed = 0;
    }
    const run: ClusterRun = {
      id: randomUUID(),
      role,
      goal,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      activity: "启动中",
      summary: "",
      routeRole: null,
      errors: [],
    };
    this.runs.unshift(run);
    this.batchTotal++;
    if (this.runs.length > KEEP) this.runs.length = KEEP;
    this.changed();
    return run.id;
  }

  /** The role's latest tool call, shown while it runs. */
  activity(id: string, text: string): void {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== "running") return;
    run.activity = text.slice(0, 120);
    this.changed();
  }

  /** The dispatch is over. `text` is the role's final output envelope; `aborted` means it was cancelled. */
  finish(id: string, text: string, aborted: boolean): void {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== "running") return;
    const parsed = parseEnvelope(text);
    run.status = aborted ? "cancelled" : (parsed.status ?? "fail");
    run.summary = parsed.summary || (aborted ? "被停下了" : "（没有返回输出信封）");
    run.routeRole = parsed.route;
    run.errors = parsed.errors;
    run.endedAt = Date.now();
    run.activity = "";
    this.batchDone++;
    if (run.status === "fail" || run.status === "blocked") this.batchFailed++;
    this.changed();
  }

  clearFinished(): ClusterView {
    this.runs = this.runs.filter((r) => r.status === "running");
    this.changed();
    return this.view();
  }

  view(): ClusterView {
    return {
      runs: this.runs,
      running: this.running(),
      batchTotal: this.batchTotal,
      batchDone: this.batchDone,
      batchFailed: this.batchFailed,
    };
  }

  private running(): number {
    return this.runs.filter((r) => r.status === "running").length;
  }

  private changed(): void {
    this.opts.onChange(this.view());
  }
}

/**
 * Reads the parts of an output envelope the console shows. The envelope is YAML, but only a few
 * flat fields are needed, so this is a lenient line match: a field that is missing or unreadable
 * stays empty rather than failing the dispatch.
 */
export function parseEnvelope(text: string): {
  status: ClusterRun["status"] | null;
  summary: string;
  route: string | null;
  errors: string[];
} {
  const status = text.match(/^\s*status:\s*(ok|fail|blocked)\b/m)?.[1] as ClusterRun["status"] | undefined;
  const rawSummary = text.match(/^\s*summary:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const route = text.match(/^route:\s*\n\s+role:\s*([\w-]+)/m)?.[1] ?? null;
  const errors = [...text.matchAll(/^\s*message:\s*(.+)$/gm)].map((m) => unquote(m[1].trim()));
  return { status: status ?? null, summary: unquote(rawSummary).slice(0, 200), route, errors };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}
