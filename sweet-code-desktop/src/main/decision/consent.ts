import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";

// Which projects the user has agreed to send data from to the decision model. The first decide
// call in a project asks the user (never the long-task reviewer); after that it runs freely.
// Kept in userData/decision-consent.json as { "<project root>": { model, at } }.

const file = () => path.join(app.getPath("userData"), "decision-consent.json");
let cache: Record<string, { model: string; at: number }> | null = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(file(), "utf8"));
  } catch {
    cache = {};
  }
  return cache!;
}

export async function hasConsent(root: string): Promise<boolean> {
  return Boolean((await load())[root]);
}

export async function grantConsent(root: string, model: string): Promise<void> {
  const all = await load();
  all[root] = { model, at: Date.now() };
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(all, null, 2), "utf8");
}
