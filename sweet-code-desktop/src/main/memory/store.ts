import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryItem, MemoryKind } from "@shared/types";
import { Bm25, similarity } from "../search/text";
import { redact } from "./redact";

// Long-term memory: short facts the agent (or the user) chose to keep across conversations.
// Global memories (the user's preferences) live in global.json; each project folder has its
// own file under projects/. Files load on first use and stay cached.

const MAX_TEXT = 500;
/** Active (c3) memories per scope; past it, the lowest-scored are archived rather than lost. */
const MAX_PER_SCOPE = 300;
/** Archived (c4) memories per scope; past it, the lowest-scored are deleted. */
const MAX_ARCHIVED = 1000;
const DAY = 86_400_000;
/** Unused this long, and used fewer than ARCHIVE_USES times: archived. */
const ARCHIVE_AFTER_DAYS = 90;
const ARCHIVE_USES = 2;
const HALF_LIFE_DAYS = 30;
const KIND_WEIGHT: Record<MemoryKind, number> = { decision: 1, preference: 0.8, lesson: 0.6, fact: 0.4, note: 0.4 };

/**
 * How much a memory is worth keeping in front (memory-design/c-tier-memory.md, section 5): recent
 * use (half-life 30 days), how often it was used, how many conversations it came up in, its kind.
 * Orders the index and picks what to archive; whether it is injected also depends on relevance.
 */
export function score(m: MemoryItem, now = Date.now()): number {
  const age = Math.max(0, now - (m.lastUsedAt ?? m.updatedAt)) / DAY;
  const recency = Math.pow(0.5, age / HALF_LIFE_DAYS);
  const uses = m.uses / (m.uses + 5);
  const evidence = Math.min(m.evidence ?? 1, 5) / 5;
  return 0.4 * recency + 0.3 * uses + 0.2 * evidence + 0.1 * (KIND_WEIGHT[m.kind] ?? 0.4);
}

const archived = (m: MemoryItem) => m.tier === "c4";
const byScore = (now: number) => (a: MemoryItem, b: MemoryItem) => score(b, now) - score(a, now);

/** Keep the limits: overflow of the active ones is archived, overflow of the archive deleted. */
function enforceLimits(items: MemoryItem[], now: number): MemoryItem[] {
  const active = items.filter((m) => !archived(m)).sort(byScore(now));
  const demoted = active.splice(MAX_PER_SCOPE).map((m) => ({ ...m, tier: "c4" as const }));
  const archive = [...items.filter(archived), ...demoted].sort(byScore(now)).slice(0, MAX_ARCHIVED);
  return [...active, ...archive];
}

/** A memory brought back from the archive. */
function revive(m: MemoryItem): MemoryItem {
  if (!archived(m)) return m;
  const { tier: _tier, ...rest } = m;
  return rest;
}
/** A new memory this similar to an existing one replaces it instead of piling up duplicates. */
export const DUPLICATE = 0.75;

type Scope = MemoryItem["scope"];

export class MemoryStore {
  private cache = new Map<string, MemoryItem[]>();

  constructor(private readonly dir: string) {}

  private fileFor(scope: Scope, root: string | null): string | null {
    if (scope === "global") return path.join(this.dir, "global.json");
    if (!root) return null;
    return path.join(this.dir, "projects", `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
  }

  private async read(file: string): Promise<MemoryItem[]> {
    const hit = this.cache.get(file);
    if (hit) return hit;
    let items: MemoryItem[] = [];
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (Array.isArray(raw)) items = raw.filter((m) => typeof m?.id === "string" && typeof m?.text === "string");
    } catch {
      // No memories yet.
    }
    this.cache.set(file, items);
    return items;
  }

  private async write(file: string, items: MemoryItem[]): Promise<void> {
    this.cache.set(file, items);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  /** Project memories first, then global ones; most used and most recent first within each. Archived ones included. */
  async list(root: string | null): Promise<MemoryItem[]> {
    const order = (a: MemoryItem, b: MemoryItem) => b.uses - a.uses || b.updatedAt - a.updatedAt;
    const project = root ? [...(await this.read(this.fileFor("project", root)!))].sort(order) : [];
    const global = [...(await this.read(this.fileFor("global", null)!))].sort(order);
    return [...project, ...global];
  }

  async add(
    root: string | null,
    input: {
      text: string;
      scope: Scope;
      kind?: MemoryKind;
      /** Consolidation: conversations this comes from. A new memory starts with it; a similar one adds it. */
      evidence?: number;
      source?: { sessionId: string };
    },
  ): Promise<{ item: MemoryItem; updated: boolean }> {
    // Secrets and contact details never go into memory, whoever asks.
    const text = redact(input.text.trim().replace(/\s+/g, " ")).slice(0, MAX_TEXT);
    if (!text) throw new Error("要记住的内容是空的");
    const scope = input.scope === "project" && root ? "project" : "global";
    const file = this.fileFor(scope, root)!;
    const items = [...(await this.read(file))];
    const now = Date.now();
    // An archived twin counts too: saying it again brings it back.
    const twin = items.find((m) => similarity(m.text, text) >= DUPLICATE);
    if (twin) {
      const item: MemoryItem = {
        ...revive(twin),
        text,
        kind: input.kind ?? twin.kind,
        updatedAt: now,
        ...(input.evidence ? { evidence: (twin.evidence ?? 1) + input.evidence } : {}),
      };
      await this.write(file, items.map((m) => (m.id === twin.id ? item : m)));
      return { item, updated: true };
    }
    const item: MemoryItem = {
      id: randomUUID().slice(0, 8),
      text,
      kind: input.kind ?? "note",
      scope,
      createdAt: now,
      updatedAt: now,
      uses: 0,
      ...(input.evidence && input.evidence > 1 ? { evidence: input.evidence } : {}),
      ...(input.source ? { source: input.source } : {}),
    };
    items.push(item);
    await this.write(file, enforceLimits(items, now));
    return { item, updated: false };
  }

  async remove(root: string | null, id: string): Promise<MemoryItem | null> {
    for (const scope of ["project", "global"] as const) {
      const file = this.fileFor(scope, root);
      if (!file) continue;
      const items = await this.read(file);
      const hit = items.find((m) => m.id === id);
      if (hit) {
        await this.write(file, items.filter((m) => m.id !== id));
        return hit;
      }
    }
    return null;
  }

  /** The active (c3) memories: what new conversations start with and what is recalled automatically. */
  async active(root: string | null): Promise<MemoryItem[]> {
    return (await this.list(root)).filter((m) => !archived(m));
  }

  /** Memories matching a query, best first. The archive only when asked (the recall tool). */
  async search(root: string | null, query: string, k: number, opts: { archived?: boolean } = {}): Promise<MemoryItem[]> {
    const all = opts.archived ? await this.list(root) : await this.active(root);
    const index = new Bm25<MemoryItem>();
    for (const m of all) index.set(m.id, m, m.text);
    return index.search(query, k).map((r) => r.item);
  }

  /** Count that these memories were brought into a conversation (frequently used ones stay on top). */
  async touch(root: string | null, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const wanted = new Set(ids);
    for (const scope of ["project", "global"] as const) {
      const file = this.fileFor(scope, root);
      if (!file) continue;
      const items = await this.read(file);
      if (!items.some((m) => wanted.has(m.id))) continue;
      const now = Date.now();
      // Used again: an archived memory comes back to the front.
      await this.write(file, items.map((m) => (wanted.has(m.id) ? { ...revive(m), uses: m.uses + 1, lastUsedAt: now } : m)));
    }
  }

  /**
   * Archive (c3 → c4) memories unused for 90 days and used fewer than twice. They stay searchable
   * with recall; nothing is deleted. Lessons are kept in front: they guard against repeat mistakes.
   * Returns how many were archived.
   */
  async archiveStale(root: string | null): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const scope of ["project", "global"] as const) {
      const file = this.fileFor(scope, root);
      if (!file) continue;
      const items = await this.read(file);
      const stale = (m: MemoryItem) =>
        !archived(m) && m.kind !== "lesson" && m.uses < ARCHIVE_USES && now - (m.lastUsedAt ?? m.updatedAt) > ARCHIVE_AFTER_DAYS * DAY;
      const n = items.filter(stale).length;
      if (!n) continue;
      count += n;
      await this.write(file, items.map((m) => (stale(m) ? { ...m, tier: "c4" as const } : m)));
    }
    return count;
  }
}
