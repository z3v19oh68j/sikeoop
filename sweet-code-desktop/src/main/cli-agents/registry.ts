import { promises as fs } from "node:fs";
import path from "node:path";
import { BUNDLED } from "./bundled.ts";
import { parseDefinition } from "./definition.ts";
import type { CliDefinition } from "./definition.ts";

// Which extension CLIs there are: the bundled ones, and one JSON file per CLI in the user's
// extension folder (userData/cli-agents). Read again every time it is asked, so a file edited in
// the folder is picked up by the next tab without restarting sikeoop. Never read from a project
// folder: a definition is a command line, and opening someone's repository must not hand them one.

export interface LoadedDefinition {
  def: CliDefinition;
  /** The file it came from, or "内置" for a bundled one. */
  source: string;
}

export interface Registry {
  defs: LoadedDefinition[];
  /** Files that were skipped, and why. */
  problems: { file: string; problems: string[] }[];
}

export async function loadRegistry(dir: string, bundled: unknown[] = BUNDLED): Promise<Registry> {
  const byId = new Map<string, LoadedDefinition>();
  const problems: Registry["problems"] = [];
  for (const raw of bundled) {
    const r = parseDefinition(raw);
    if (r.ok) byId.set(r.def.id, { def: r.def, source: "内置" });
  }
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch {
    // No folder yet: only the bundled ones.
  }
  const fromFiles = new Set<string>();
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      problems.push({ file: name, problems: [`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`] });
      continue;
    }
    const r = parseDefinition(raw);
    if (!r.ok) {
      problems.push({ file: name, problems: r.problems });
      continue;
    }
    if (fromFiles.has(r.def.id)) {
      problems.push({ file: name, problems: [`id「${r.def.id}」已经被另一个文件用了`] });
      continue;
    }
    const taken = [...byId.values()].find((d) => d.def.id !== r.def.id && d.def.label.toLowerCase() === r.def.label.toLowerCase());
    if (taken) {
      problems.push({ file: name, problems: [`label「${r.def.label}」已经被 ${taken.def.name} 用了，会话会重名`] });
      continue;
    }
    fromFiles.add(r.def.id);
    // Same id as a bundled one: the user's file wins.
    byId.set(r.def.id, { def: r.def, source: file });
  }
  return { defs: [...byId.values()], problems };
}
