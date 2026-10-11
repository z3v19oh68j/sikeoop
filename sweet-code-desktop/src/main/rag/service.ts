import { createHash } from "node:crypto";
import path from "node:path";
import type { RagStatus } from "@shared/types";
import { CodeIndex } from "./code-index";
import type { Embedder } from "./embeddings";

// One code index for the open project, created the first time anything searches.

export class RagService {
  private index: CodeIndex | null = null;
  private embedderError?: string;

  constructor(
    private readonly opts: {
      cacheDir: string;
      root(): string | null;
      /** The configured embeddings model, or null for keyword search only. Throws if misconfigured. */
      embedder(): Embedder | null;
      onStatus(s: RagStatus): void;
    },
  ) {}

  /** The index of the open project (built lazily on its first search), or null without a project. */
  current(): CodeIndex | null {
    const root = this.opts.root();
    if (!root) return null;
    if (this.index?.root === root) return this.index;
    this.index?.dispose();
    let embedder: Embedder | null = null;
    this.embedderError = undefined;
    try {
      embedder = this.opts.embedder();
    } catch (err) {
      this.embedderError = (err as Error).message;
    }
    this.index = new CodeIndex(root, {
      cacheDir: path.join(this.opts.cacheDir, createHash("sha256").update(root).digest("hex").slice(0, 16)),
      embedder,
      onStatus: (s) => this.opts.onStatus(this.decorate(s)),
    });
    return this.index;
  }

  /** Drop the index (project closed, or the embeddings model changed); the next search rebuilds it. */
  reset(): void {
    this.index?.dispose();
    this.index = null;
    this.opts.onStatus(this.status());
  }

  status(): RagStatus {
    const empty: RagStatus = { state: "empty", files: 0, chunks: 0, semantic: { enabled: false, embedded: 0, total: 0, running: false } };
    return this.decorate(this.index?.root === this.opts.root() && this.index ? this.index.status() : empty);
  }

  async rebuild(): Promise<RagStatus> {
    const index = this.current();
    if (!index) throw new Error("先打开一个项目");
    await index.rebuild();
    return this.status();
  }

  private decorate(s: RagStatus): RagStatus {
    return this.embedderError ? { ...s, semantic: { ...s.semantic, enabled: true, error: this.embedderError } } : s;
  }
}
