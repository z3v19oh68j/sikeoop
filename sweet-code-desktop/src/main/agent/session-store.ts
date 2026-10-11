import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { SessionSummary, TranscriptItem } from "@shared/types";

// Conversations are saved per project folder under userData/sessions/<project hash>/<id>.json.
// Each file holds everything needed to pick the conversation up again after a restart.

export interface SessionFile {
  version: 1;
  id: string;
  root: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: { id: string; name: string; kind: string; model: string; auto?: boolean };
  /** The provider-native history (ModelAdapter.exportState). */
  adapterState: unknown;
  /** Tool definitions the conversation started with; reused when it is reopened. Absent in older files. */
  toolDefs?: import("../providers/types").ToolDef[];
  snapshotSent: boolean;
  turnCounter: number;
  notes: string[];
  readTracker: [string, string][];
  checkpoints: [number, [string, { before: string | null; after: string }][]][];
  /** The agent's plan (update_plan). Absent in older files. */
  plan?: import("@shared/types").PlanItem[];
  topEffort?: import("@shared/types").Effort | null;
  autoResume?: import("./auto-resume.ts").AutoResumeState;
  originalTask?: string;
  taskMode?: { autopilot: boolean; lazy: boolean; orchestrate?: boolean };
  /** turnCounter when the last c2 summary was written (memory/session-summary.ts). Absent in older files. */
  summaryTurn?: number;
  transcript: TranscriptItem[];
}

const dirFor = (root: string) =>
  path.join(app.getPath("userData"), "sessions", createHash("sha256").update(root).digest("hex").slice(0, 16));

/** The folder holding a project's conversations (and their c2 summaries, in summaries/). */
export const projectDir = dirFor;

const fileFor = (root: string, id: string) => {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid session id");
  return path.join(dirFor(root), `${id}.json`);
};

export async function save(file: SessionFile): Promise<void> {
  const target = fileFor(file.root, file.id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Write then rename, so a crash mid-write never leaves a half-written conversation.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file), "utf8");
  await fs.rename(tmp, target);
}

export async function load(root: string, id: string): Promise<SessionFile> {
  return JSON.parse(await fs.readFile(fileFor(root, id), "utf8")) as SessionFile;
}

export async function remove(root: string, id: string): Promise<void> {
  await fs.rm(fileFor(root, id), { force: true });
}

/** Paths of every saved conversation of a project. */
export async function filesOf(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(dirFor(root))).filter((n) => n.endsWith(".json")).map((n) => path.join(dirFor(root), n));
  } catch {
    return [];
  }
}

/** Newest first. Unreadable files are skipped rather than breaking the list. */
export async function list(root: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dirFor(root))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    try {
      const f = JSON.parse(await fs.readFile(path.join(dirFor(root), name), "utf8")) as SessionFile;
      out.push({
        id: f.id,
        title: f.title,
        updatedAt: f.updatedAt,
        providerId: f.provider.id,
        providerName: f.provider.name,
        model: f.provider.model,
      });
    } catch {
      // Skip a damaged file.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
