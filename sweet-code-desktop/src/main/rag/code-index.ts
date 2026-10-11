import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RagStatus } from "@shared/types";
import { Bm25 } from "../search/text";
import { IGNORED_DIRS } from "../workspace";
import { chunkLines } from "./chunk";
import { type Embedder, VectorCache, cosine } from "./embeddings";

// The project's code index, built the first time something searches it and kept up to date
// by comparing file sizes and modification times before each search. Keyword search (BM25)
// always works offline; with an embeddings model configured, a semantic index is built in
// the background and both are combined (reciprocal rank fusion).

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 300 * 1024;
/** Re-scan the folder at most this often; a search right after another reuses the scan. */
const RESCAN_MS = 3000;
const MAX_EMBED_CHUNKS = 8000;

/** Text files worth searching. Secrets (.env, keys) and lock files are left out on purpose. */
const CODE_EXT = new Set(
  (
    "js jsx mjs cjs ts tsx mts cts vue nvue svelte astro html htm css scss sass less styl json jsonc json5 md mdx " +
    "py pyi rb go rs java kt kts scala swift m mm c h cc cpp cxx hpp hh ino cu cs fs vb php lua dart r jl ex exs erl " +
    "clj sql graphql gql proto sh bash zsh fish ps1 bat cmd yaml yml toml ini cfg conf xml gradle cmake mk " +
    "wxml wxss wxs ets txt rst tex sol"
  ).split(" "),
);
const SKIP_NAMES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|^\.env/i;
const EXTRA_NAMES = /^(Makefile|Dockerfile|README|LICENSE|AGENTS\.md|CLAUDE\.md)$/i;

export interface Chunk {
  key: string;
  path: string;
  start: number;
  end: number;
  text: string;
  hash: string;
}

export interface Hit {
  chunk: Chunk;
  /** Keyword score, when keyword search found it. */
  bm25?: number;
  /** Share of the query the keywords explain (0–1). */
  coverage?: number;
  /** Cosine similarity, when semantic search found it. */
  cosine?: number;
  score: number;
}

interface FileEntry {
  mtime: number;
  size: number;
  keys: string[];
}

export class CodeIndex {
  private bm = new Bm25<Chunk>();
  private chunks = new Map<string, Chunk>();
  private files = new Map<string, FileEntry>();
  private lastScan = 0;
  private scanning: Promise<void> | null = null;
  private indexedAt?: number;
  private vectors: VectorCache | null = null;
  private embedJob: Promise<void> | null = null;
  private embedAbort = new AbortController();
  private embedError?: string;
  private truncated = false;

  constructor(
    readonly root: string,
    private readonly opts: {
      cacheDir: string;
      embedder: Embedder | null;
      onStatus(s: RagStatus): void;
    },
  ) {}

  dispose(): void {
    this.embedAbort.abort();
  }

  status(): RagStatus {
    const total = Math.min(this.chunks.size, MAX_EMBED_CHUNKS);
    let embedded = 0;
    if (this.vectors) for (const c of this.chunks.values()) if (this.vectors.has(c.hash)) embedded++;
    return {
      state: this.scanning && !this.indexedAt ? "indexing" : this.indexedAt ? "ready" : "empty",
      files: this.files.size,
      chunks: this.chunks.size,
      indexedAt: this.indexedAt,
      semantic: {
        enabled: !!this.opts.embedder,
        model: this.opts.embedder?.id.split(":").slice(1).join(":"),
        embedded,
        total,
        running: !!this.embedJob,
        error: this.embedError,
      },
    };
  }

  /** Bring the index up to date with the files on disk (cheap when nothing changed). */
  async sync(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.lastScan < RESCAN_MS) return;
    this.scanning = this.scan().finally(() => {
      this.scanning = null;
      this.lastScan = Date.now();
      this.indexedAt = Date.now();
      this.opts.onStatus(this.status());
      this.startEmbedding();
    });
    if (!this.indexedAt) this.opts.onStatus(this.status());
    return this.scanning;
  }

  /** Forget everything and index again from scratch. */
  async rebuild(): Promise<void> {
    await this.scanning;
    this.bm.clear();
    this.chunks.clear();
    this.files.clear();
    this.indexedAt = undefined;
    this.embedError = undefined;
    await this.sync(true);
  }

  private async scan(): Promise<void> {
    const ignore = await readGitignore(this.root);
    const seen = new Set<string>();
    const queue = [""];
    this.truncated = false;
    while (queue.length) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await fs.readdir(path.join(this.root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".") || ignore(rel, true)) continue;
          queue.push(rel);
          continue;
        }
        if (!e.isFile() || ignore(rel, false) || SKIP_NAMES.test(e.name)) continue;
        const ext = e.name.includes(".") ? e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase() : "";
        if (!CODE_EXT.has(ext) && !EXTRA_NAMES.test(e.name)) continue;
        if (seen.size >= MAX_FILES) {
          this.truncated = true;
          break;
        }
        seen.add(rel);
        await this.indexFile(rel);
      }
    }
    for (const rel of [...this.files.keys()]) if (!seen.has(rel)) this.dropFile(rel);
  }

  private async indexFile(rel: string): Promise<void> {
    const abs = path.join(this.root, rel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return this.dropFile(rel);
    }
    const known = this.files.get(rel);
    if (known && known.mtime === st.mtimeMs && known.size === st.size) return;
    this.dropFile(rel);
    if (st.size > MAX_FILE_BYTES) return;
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      return;
    }
    // Binary, or minified into a few huge lines: not useful to search.
    if (text.includes("\u0000")) return;
    const lines = text.split("\n").length;
    if (text.length / lines > 300) return;
    const keys: string[] = [];
    for (const c of chunkLines(text)) {
      const key = `${rel}#${c.start}`;
      const hash = createHash("sha1").update(rel).update("\0").update(c.text).digest("hex");
      const chunk: Chunk = { key, path: rel, start: c.start, end: c.end, text: c.text, hash };
      this.chunks.set(key, chunk);
      // The path is searchable too: "login page" should find src/pages/Login.vue.
      this.bm.set(key, chunk, `${rel.replace(/[/._-]/g, " ")}\n${c.text}`);
      keys.push(key);
    }
    this.files.set(rel, { mtime: st.mtimeMs, size: st.size, keys });
  }

  private dropFile(rel: string): void {
    const f = this.files.get(rel);
    if (!f) return;
    for (const k of f.keys) {
      this.bm.delete(k);
      this.chunks.delete(k);
    }
    this.files.delete(rel);
  }

  /** Embed chunks that have no vector yet, in the background. Search works meanwhile. */
  private startEmbedding(): void {
    const embedder = this.opts.embedder;
    if (!embedder || this.embedJob) return;
    this.embedJob = (async () => {
      const signal = this.embedAbort.signal;
      this.vectors ??= await VectorCache.open(this.opts.cacheDir, embedder.id);
      const vectors = this.vectors;
      const todo = [...this.chunks.values()].slice(0, MAX_EMBED_CHUNKS).filter((c) => !vectors.has(c.hash));
      let sinceSave = 0;
      for (let i = 0; i < todo.length && !signal.aborted; i += 64) {
        const batch = todo.slice(i, i + 64);
        const vecs = await embedder.embed(batch.map((c) => `${c.path}\n${c.text}`), signal);
        batch.forEach((c, j) => vecs[j] && vectors.set(c.hash, vecs[j]));
        this.opts.onStatus(this.status());
        if ((sinceSave += batch.length) >= 512) {
          sinceSave = 0;
          await vectors.save();
        }
      }
      await vectors.save(new Set([...this.chunks.values()].map((c) => c.hash)));
      this.embedError = undefined;
    })()
      .catch((err) => {
        if (!this.embedAbort.signal.aborted) this.embedError = (err as Error).message;
      })
      .finally(() => {
        this.embedJob = null;
        this.opts.onStatus(this.status());
      });
  }

  /**
   * Chunks for a query: keyword ranking, plus semantic ranking when vectors exist, fused.
   * pathFilter keeps only files whose path contains it.
   */
  async search(query: string, k: number, opts: { pathFilter?: string; signal?: AbortSignal } = {}): Promise<Hit[]> {
    await this.sync();
    const filter = opts.pathFilter ? (c: Chunk) => c.path.toLowerCase().includes(opts.pathFilter!.toLowerCase()) : undefined;
    const pool = Math.max(k * 4, 30);
    const kw = this.bm.search(query, pool, filter);

    let sem: { chunk: Chunk; cosine: number }[] = [];
    if (this.opts.embedder && this.vectors && !this.embedError) {
      try {
        const [qv] = await this.opts.embedder.embed([query], opts.signal);
        for (const c of this.chunks.values()) {
          if (filter && !filter(c)) continue;
          const v = this.vectors.get(c.hash);
          if (v) sem.push({ chunk: c, cosine: cosine(qv, v) });
        }
        sem = sem.sort((a, b) => b.cosine - a.cosine).slice(0, pool);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // Semantic search failed this time (network…): keywords alone still answer.
      }
    }

    const hits = new Map<string, Hit>();
    const RRF = 60;
    kw.forEach((r, i) => hits.set(r.item.key, { chunk: r.item, bm25: r.score, coverage: r.coverage, score: 1 / (RRF + i) }));
    sem.forEach((r, i) => {
      const h = hits.get(r.chunk.key) ?? { chunk: r.chunk, score: 0 };
      h.cosine = r.cosine;
      h.score += 1 / (RRF + i);
      hits.set(r.chunk.key, h);
    });
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  get isTruncated(): boolean {
    return this.truncated;
  }
}

/** A small .gitignore reader: plain patterns, *, **, trailing / and leading /. No negation. */
export async function readGitignore(root: string): Promise<(rel: string, isDir: boolean) => boolean> {
  let text = "";
  try {
    text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    return () => false;
  }
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => {
      const dirOnly = l.endsWith("/");
      let p = l.replace(/\/+$/, "");
      const anchored = p.startsWith("/") || p.includes("/");
      p = p.replace(/^\//, "");
      const body = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\/?/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*");
      const re = new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
      return { re, dirOnly };
    });
  // Folders are checked before the walk goes into them, so "dist/" never reaches the files inside.
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));
}
