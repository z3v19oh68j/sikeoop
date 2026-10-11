import { promises as fs } from "node:fs";
import path from "node:path";
import { projectDir } from "../agent/session-store";
import { redact } from "./redact";

// c2, session memory (memory-design/c-tier-memory.md): one short summary per conversation, kept
// next to the saved conversations in a summaries/ folder (session-store reads every .json in the
// project folder as a conversation, so they can't sit beside them). Written when the conversation
// is compressed, every few turns, and when the user leaves it; read when a new conversation in the
// same project starts, so the agent knows where the last one got to.

export interface SessionSummary {
  version: 1;
  id: string;
  title: string;
  /** The conversation's turn count when this was written. */
  turn: number;
  source: "compact" | "periodic" | "leave";
  updatedAt: number;
  text: string;
}

/** About 1–2K tokens of Chinese text. */
const MAX_CHARS = 2400;

const dirOf = (root: string) => path.join(projectDir(root), "summaries");

export async function saveSummary(root: string, s: Omit<SessionSummary, "version" | "updatedAt">): Promise<void> {
  if (!/^[a-z0-9-]+$/i.test(s.id)) throw new Error("Invalid session id");
  const text = redact(s.text.trim()).slice(0, MAX_CHARS);
  if (!text) return;
  const file: SessionSummary = { version: 1, ...s, text, updatedAt: Date.now() };
  const dir = dirOf(root);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${s.id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file), "utf8");
  await fs.rename(tmp, target);
}

/** The newest summary in this project within maxAge, other than the given conversation's. */
export async function latestSummary(root: string, maxAgeMs: number, exceptId?: string): Promise<SessionSummary | null> {
  let names: string[];
  try {
    names = (await fs.readdir(dirOf(root))).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  let best: SessionSummary | null = null;
  for (const name of names) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(dirOf(root), name), "utf8")) as SessionSummary;
      if (s.version !== 1 || s.id === exceptId || Date.now() - s.updatedAt > maxAgeMs) continue;
      if (!best || s.updatedAt > best.updatedAt) best = s;
    } catch {
      // Skip a damaged file.
    }
  }
  return best;
}

/** Every summary of this project, newest first. */
export async function allSummaries(root: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dirOf(root))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(dirOf(root), name), "utf8")) as SessionSummary;
      if (s.version === 1) out.push(s);
    } catch {
      // Skip a damaged file.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A conversation was deleted: its summary goes too. */
export async function removeSummary(root: string, id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/i.test(id)) return;
  await fs.rm(path.join(dirOf(root), `${id}.json`), { force: true });
}
