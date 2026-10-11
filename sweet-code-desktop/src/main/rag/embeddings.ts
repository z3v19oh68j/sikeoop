import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { ResolvedProvider } from "../providers/store";

// Optional semantic search: chunks are turned into vectors by an embeddings model reached
// through the OpenAI-compatible /embeddings endpoint (OpenAI, Qwen, Zhipu, Gemini, Ollama…).
// Vectors are cached on disk by content hash, so unchanged code is never embedded twice.

export { EMBEDDING_MODELS } from "@shared/embeddings";

const BATCH = 32;
/** Most providers cap one input at about 8K tokens. */
const MAX_INPUT_CHARS = 6000;

export interface Embedder {
  /** provider:model, which also names the vector cache. */
  id: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export function makeEmbedder(p: ResolvedProvider): Embedder {
  if (p.preset.kind === "anthropic") throw new Error("Claude 没有提供向量（embeddings）模型，换一个服务商来做语义检索");
  if (p.preset.needsKey && !p.apiKey) throw new Error(`语义检索要用 ${p.preset.name} 的 API Key，先在设置里填好`);
  const client = new OpenAI({ apiKey: p.apiKey || "not-needed", baseURL: p.baseURL, maxRetries: 3 });
  return {
    id: `${p.preset.id}:${p.model}`,
    async embed(texts, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const input = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_INPUT_CHARS) || " ");
        const res = await client.embeddings.create({ model: p.model, input, encoding_format: "float" }, { signal });
        const rows = [...res.data].sort((a, b) => a.index - b.index);
        for (const r of rows) out.push(normalize(Float32Array.from(r.embedding as number[])));
      }
      return out;
    },
  };
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Dot product of two normalized vectors = cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Vectors by chunk content hash, saved as two files: an index of hashes (JSON) and the raw
 * float32 data, which keeps a few thousand 1536-dim vectors at tens of MB instead of hundreds.
 */
export class VectorCache {
  private map = new Map<string, Float32Array>();
  private dim = 0;
  private dirty = false;

  constructor(private readonly base: string) {}

  static async open(dir: string, embedderId: string): Promise<VectorCache> {
    const cache = new VectorCache(path.join(dir, embedderId.replace(/[^a-z0-9._-]+/gi, "_")));
    try {
      const meta = JSON.parse(await fs.readFile(`${cache.base}.json`, "utf8")) as { dim: number; hashes: string[] };
      const buf = await fs.readFile(`${cache.base}.f32`);
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (meta.dim > 0 && all.length === meta.dim * meta.hashes.length) {
        cache.dim = meta.dim;
        meta.hashes.forEach((h, i) => cache.map.set(h, all.slice(i * meta.dim, (i + 1) * meta.dim)));
      }
    } catch {
      // Nothing cached yet.
    }
    return cache;
  }

  get(hash: string): Float32Array | undefined {
    return this.map.get(hash);
  }

  has(hash: string): boolean {
    return this.map.has(hash);
  }

  set(hash: string, v: Float32Array): void {
    if (this.dim && v.length !== this.dim) return;
    this.dim = v.length;
    this.map.set(hash, v);
    this.dirty = true;
  }

  /** Keep only vectors still in use, then write to disk if anything changed. */
  async save(keep?: Set<string>): Promise<void> {
    if (keep) {
      for (const h of this.map.keys()) {
        if (!keep.has(h)) {
          this.map.delete(h);
          this.dirty = true;
        }
      }
    }
    if (!this.dirty) return;
    const hashes = [...this.map.keys()];
    const all = new Float32Array(hashes.length * this.dim);
    hashes.forEach((h, i) => all.set(this.map.get(h)!, i * this.dim));
    await fs.mkdir(path.dirname(this.base), { recursive: true });
    await fs.writeFile(`${this.base}.f32`, Buffer.from(all.buffer));
    await fs.writeFile(`${this.base}.json`, JSON.stringify({ dim: this.dim, hashes }), "utf8");
    this.dirty = false;
  }
}
