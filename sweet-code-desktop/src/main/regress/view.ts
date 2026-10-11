import type { AgentCli, DispatchJob, RegressBaseline, RegressDiffRow, RegressItem, RegressRun, RegressSettings, RegressView } from "@shared/types";

// What the regression panel shows, worked out from what is stored (.claude/regress-plan.md).
// Pure functions: tested on their own.

export const DEFAULT_SETTINGS: RegressSettings = { runTimeoutSec: 300, generateTimeoutSec: 600, maxPerBatch: 50, maxCandidates: 30 };
const RANGES: Record<keyof RegressSettings, [number, number]> = {
  runTimeoutSec: [30, 3600],
  generateTimeoutSec: [60, 3600],
  maxPerBatch: [1, 200],
  maxCandidates: [1, 100],
};
const CLIS: AgentCli[] = ["claude", "codex"];

/** Settings with every value a whole number inside its range; anything else falls back to `base`. */
export function clampSettings(patch: unknown, base: RegressSettings = DEFAULT_SETTINGS): RegressSettings {
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const key of Object.keys(RANGES) as (keyof RegressSettings)[]) {
    const v = p[key];
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : base[key];
    out[key] = Math.min(RANGES[key][1], Math.max(RANGES[key][0], n));
  }
  return out;
}

/** A run's status for the state its dispatch job is in. */
export function runStatus(job: DispatchJob["status"]): RegressRun["status"] {
  switch (job) {
    case "queued":
      return "queued";
    case "starting":
    case "running":
    case "waiting_approval":
      return "running";
    case "done":
      return "done";
    case "timeout":
      return "timeout";
    case "exited":
      return "gone";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "error";
  }
}

/** The latest run of each item that still exists, per CLI. */
export function latestRuns(items: RegressItem[], runs: RegressRun[]): RegressView["latest"] {
  const known = new Set(items.map((i) => i.id));
  const latest: RegressView["latest"] = {};
  for (const r of runs) {
    if (!known.has(r.itemId)) continue;
    const slot = (latest[r.itemId] ??= {});
    const cur = slot[r.cli];
    if (!cur || r.startedAt >= cur.startedAt) slot[r.cli] = r;
  }
  return latest;
}

/** Items whose latest Claude and Codex verdicts are both decided and differ. */
export function conflictsOf(items: RegressItem[], latest: RegressView["latest"]): string[] {
  return items
    .filter((i) => {
      const a = latest[i.id]?.claude?.verdict;
      const b = latest[i.id]?.codex?.verdict;
      return !!a && !!b && a !== "pending" && b !== "pending" && a !== b;
    })
    .map((i) => i.id);
}

/** What a baseline records: the latest verdict of every item on every CLI, undecided ones included. */
export function snapshotResults(latest: RegressView["latest"]): RegressBaseline["results"] {
  const results: RegressBaseline["results"] = {};
  for (const [itemId, per] of Object.entries(latest)) {
    for (const cli of CLIS) {
      const run = per[cli];
      if (run) (results[itemId] ??= {})[cli] = { runId: run.id, verdict: run.verdict };
    }
  }
  return results;
}

/** The latest verdicts against a baseline, the same CLI on both sides. */
export function diffRows(baseline: RegressBaseline, latest: RegressView["latest"]): RegressDiffRow[] {
  const rows: RegressDiffRow[] = [];
  for (const itemId of new Set([...Object.keys(baseline.results), ...Object.keys(latest)])) {
    for (const cli of CLIS) {
      const base = baseline.results[itemId]?.[cli]?.verdict ?? null;
      const now = latest[itemId]?.[cli]?.verdict ?? null;
      if (base === null && now === null) continue;
      const kind: RegressDiffRow["kind"] =
        base === null ? "new" : now === null ? "missing" : base === "pass" && now === "fail" ? "regressed" : base === "fail" && now === "pass" ? "fixed" : "same";
      rows.push({ itemId, cli, base, now, kind });
    }
  }
  return rows;
}
