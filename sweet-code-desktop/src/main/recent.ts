import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { RecentProject } from "@shared/types";

// Recently opened project folders, newest first, for the start page.

const MAX = 12;
const file = () => path.join(app.getPath("userData"), "recent-projects.json");

async function read(): Promise<{ path: string; openedAt: number }[]> {
  try {
    const list = JSON.parse(await fs.readFile(file(), "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x?.path === "string" && typeof x?.openedAt === "number") : [];
  } catch {
    return [];
  }
}

/** Folders that no longer exist are listed as missing rather than dropped, so a moved drive comes back. */
export async function list(): Promise<RecentProject[]> {
  const items = await read();
  return Promise.all(
    items.map(async (x) => ({
      path: x.path,
      name: path.basename(x.path),
      openedAt: x.openedAt,
      exists: await fs.stat(x.path).then((s) => s.isDirectory(), () => false),
    })),
  );
}

export async function add(dir: string): Promise<void> {
  const items = (await read()).filter((x) => x.path !== dir);
  items.unshift({ path: dir, openedAt: Date.now() });
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(items.slice(0, MAX), null, 2), "utf8");
}

export async function remove(dir: string): Promise<void> {
  const items = (await read()).filter((x) => x.path !== dir);
  await fs.writeFile(file(), JSON.stringify(items, null, 2), "utf8");
}

export async function has(dir: string): Promise<boolean> {
  return (await read()).some((x) => x.path === dir);
}
