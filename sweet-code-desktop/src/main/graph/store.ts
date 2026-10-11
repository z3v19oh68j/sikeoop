import { promises as fs } from "node:fs";
import path from "node:path";
import type { KnowledgeGraph } from "@shared/types";
import { sha } from "../wiki/store";

// A project's knowledge graphs are saved together under userData/graph/<project hash>.json.

export interface StoredGraph extends Omit<KnowledgeGraph, "stale"> {
  /** What the graph was built from: the code's file list with sizes and times, or the document's hash. */
  fingerprint: string;
}

export interface GraphFile {
  version: 1;
  root: string;
  graphs: StoredGraph[];
}

export class GraphStore {
  constructor(private readonly dir: string) {}

  private file(root: string): string {
    return path.join(this.dir, sha(root).slice(0, 16) + ".json");
  }

  async load(root: string): Promise<GraphFile> {
    try {
      const data = JSON.parse(await fs.readFile(this.file(root), "utf8")) as GraphFile;
      if (data.version === 1 && data.root === root) return data;
    } catch {
      // None yet.
    }
    return { version: 1, root, graphs: [] };
  }

  /** Written to a temp file and renamed, so a crash never leaves half a JSON. */
  async save(data: GraphFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(data.root);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, target);
  }
}
