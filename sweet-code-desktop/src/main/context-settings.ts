import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ContextSettings } from "@shared/types";

// Settings for what goes into the agent's context besides the conversation: project rules,
// memories and retrieved code. Kept in context-settings.json under userData.

const DEFAULTS: ContextSettings = { rules: true, memory: true, autoRecall: true, autoContext: true, embedding: null };
const file = () => path.join(app.getPath("userData"), "context-settings.json");

let current: ContextSettings | null = null;

export async function load(): Promise<ContextSettings> {
  if (current) return current;
  try {
    current = { ...DEFAULTS, ...JSON.parse(await fs.readFile(file(), "utf8")) };
  } catch {
    current = { ...DEFAULTS };
  }
  return current!;
}

/** The settings as last loaded; defaults until load() ran. */
export function get(): ContextSettings {
  return current ?? DEFAULTS;
}

export async function update(change: Partial<ContextSettings>): Promise<ContextSettings> {
  const next = { ...(await load()), ...change };
  if (next.embedding && (!next.embedding.providerId || !next.embedding.model.trim())) next.embedding = null;
  if (next.embedding) next.embedding = { providerId: next.embedding.providerId, model: next.embedding.model.trim() };
  current = next;
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
