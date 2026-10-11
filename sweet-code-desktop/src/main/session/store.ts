import { appendFileSync, mkdirSync, renameSync, writeFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CrossSession, TimelineEvent, TimelineEventKind } from "@shared/types";

const kinds: TimelineEventKind[] = ["user", "agent", "system", "outOfScope", "lockDenied", "hopLimit", "agentJoined", "agentExited"];
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export class SessionStore {
  private readonly records = new Map<string, { meta: CrossSession; events: TimelineEvent[] }>();
  private readonly base: string;
  // No parameter properties: the tests run this file under Node's type stripping.
  constructor(base: string) {
    this.base = base;
  }
  dir(id: string): string {
    if (!validId(id)) throw new Error("session ID 无效");
    return path.join(this.base, id);
  }
  timelinePath(id: string): string { return path.join(this.dir(id), "timeline.jsonl"); }
  async load(): Promise<void> {
    await fs.mkdir(this.base, { recursive: true });
    for (const dir of await fs.readdir(this.base, { withFileTypes: true })) {
      if (!dir.isDirectory() || !validId(dir.name)) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(this.dir(dir.name), "meta.json"), "utf8")) as CrossSession;
        if (!meta || meta.id !== dir.name || typeof meta.title !== "string" || !Array.isArray(meta.roots) || meta.roots.length < 2 || !meta.roots.every((r) => typeof r === "string" && path.isAbsolute(r)) || !["active", "ended"].includes(meta.state) || !Number.isFinite(meta.createdAt)) continue;
        const agents = JSON.parse(await fs.readFile(path.join(this.dir(dir.name), "agents.json"), "utf8"));
        if (!Array.isArray(agents) || agents.length > 4 || !agents.every((a) => a && validId(a.id) && ["claude", "codex"].includes(a.cli) && typeof a.name === "string" && a.tab === `s:${meta.id}:${a.id}`) || new Set(agents.map((a) => a.id)).size !== agents.length) continue;
        meta.agents = agents.map((a) => ({ ...a, status: "exited" }));
        const lines = (await fs.readFile(this.timelinePath(meta.id), "utf8")).split("\n").filter(Boolean);
        const events: TimelineEvent[] = [];
        for (const line of lines) {
          const e = JSON.parse(line) as TimelineEvent;
          if (!e || e.seq !== events.length + 1 || !Number.isFinite(e.at) || !kinds.includes(e.kind) || (e.text !== undefined && typeof e.text !== "string")) throw new Error("损坏时间线");
          events.push(e);
        }
        this.records.set(meta.id, { meta, events });
        this.save(meta);
      } catch { /* One corrupt session must never prevent the other sessions from loading. */ }
    }
  }
  list(): CrossSession[] { return [...this.records.values()].map((r) => structuredClone(r.meta)).sort((a, b) => b.createdAt - a.createdAt); }
  get(id: string): { meta: CrossSession; events: TimelineEvent[] } {
    this.dir(id);
    const r = this.records.get(id);
    if (!r) throw new Error("没有找到这个 session");
    return structuredClone(r);
  }
  /** The session without its timeline (which can be long). */
  meta(id: string): CrossSession {
    const r = this.records.get(id);
    if (!r) throw new Error("没有找到这个 session");
    return structuredClone(r.meta);
  }
  /** The newest `limit` events, oldest first; with `before`, only those with a smaller seq. */
  events(id: string, before: number | undefined, limit: number): TimelineEvent[] {
    const r = this.records.get(id);
    if (!r) throw new Error("没有找到这个 session");
    const upTo = before === undefined ? r.events : r.events.filter((e) => e.seq < before);
    return structuredClone(upTo.slice(-limit));
  }
  save(meta: CrossSession): void {
    const dir = this.dir(meta.id);
    mkdirSync(dir, { recursive: true });
    this.atomic(path.join(dir, "agents.json"), meta.agents);
    this.atomic(path.join(dir, "meta.json"), meta);
    const old = this.records.get(meta.id);
    if (!old) writeFileSync(this.timelinePath(meta.id), "", { flag: "a" });
    this.records.set(meta.id, { meta: structuredClone(meta), events: old?.events ?? [] });
  }
  append(id: string, input: Omit<TimelineEvent, "seq" | "at">): TimelineEvent {
    const r = this.records.get(id);
    if (!r) throw new Error("没有找到这个 session");
    const event = { ...input, seq: r.events.length + 1, at: Date.now() };
    appendFileSync(this.timelinePath(id), JSON.stringify(event) + "\n", "utf8");
    r.events.push(event);
    return structuredClone(event);
  }
  private atomic(file: string, data: unknown): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }
}
