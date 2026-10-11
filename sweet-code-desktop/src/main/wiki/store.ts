import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WikiPage } from "@shared/types";

// The project wiki is saved per project folder under userData/wiki/<project hash>.json.

export interface StoredPage extends Omit<WikiPage, "stale"> {
  /** sha256 of each of its files when the page was written, to tell when it went stale. */
  hashes?: Record<string, string>;
}

export interface WikiFile {
  version: 1;
  root: string;
  title: string;
  summary: string;
  pages: StoredPage[];
  generatedAt: number;
  model: string;
}

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Where the wiki of a project is saved. */
export const wikiFile = (dir: string, root: string) => path.join(dir, sha(root).slice(0, 16) + ".json");

export class WikiStore {
  constructor(private readonly dir: string) {}

  private file(root: string): string {
    return wikiFile(this.dir, root);
  }

  async load(root: string): Promise<WikiFile | null> {
    try {
      const data = JSON.parse(await fs.readFile(this.file(root), "utf8")) as WikiFile;
      return data.version === 1 && data.root === root ? data : null;
    } catch {
      return null;
    }
  }

  /** Written to a temp file and renamed, so a crash never leaves half a JSON. */
  async save(data: WikiFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(data.root);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, target);
  }
}
