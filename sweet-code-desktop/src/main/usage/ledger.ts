import { mkdirSync, renameSync, writeFileSync, promises as fs } from "node:fs";
import path from "node:path";
import type { UsageDay, UsageSummary } from "@shared/types";

// The token ledger: every model request adds its usage to today's row for its provider × model,
// across the main chat, the wiki, the reviewer, the compressor, group chats and image reading.
// Kept in one small JSON file (a row per day per model); written a moment after changes.

export interface UsageSource {
  providerId: string;
  providerName: string;
  model: string;
}

export interface TokenUsage {
  /** Input not read from the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface LedgerFile {
  version: 1;
  /** Local date (YYYY-MM-DD) of the first recorded request. */
  firstDay?: string;
  days: Record<string, UsageDay["models"]>;
}

/** Where usage reports go; set once at startup. */
let sink: ((src: UsageSource, u: TokenUsage) => void) | null = null;
export function setUsageSink(fn: (src: UsageSource, u: TokenUsage) => void): void {
  sink = fn;
}
/** Called by every place that talks to a model. Never throws. */
export function reportUsage(src: UsageSource, u: TokenUsage | null | undefined): void {
  if (!u || !sink) return;
  try {
    sink(src, u);
  } catch {
    // Accounting must never break a request.
  }
}

/** Anthropic Messages usage → ours. */
export function fromAnthropic(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined): TokenUsage | null {
  if (!u) return null;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

/** OpenAI-compatible usage → ours. prompt_tokens includes the cached part. */
export function fromOpenAI(u: Record<string, unknown> | null | undefined): TokenUsage | null {
  if (!u) return null;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, number | undefined>;
  const cacheRead = details.cached_tokens ?? details.prompt_cache_hit_tokens ?? (u.prompt_cache_hit_tokens as number | undefined) ?? 0;
  const prompt = (u.prompt_tokens as number | undefined) ?? 0;
  return { input: Math.max(0, prompt - cacheRead), output: (u.completion_tokens as number | undefined) ?? 0, cacheRead, cacheWrite: 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export class UsageLedger {
  private data: LedgerFile = { version: 1, days: {} };
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8")) as LedgerFile;
      if (d.version === 1 && d.days) this.data = d;
    } catch {
      // First run.
    }
    this.loaded = true;
  }

  record(src: UsageSource, u: TokenUsage): void {
    if (!this.loaded) return;
    const total = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (!(total > 0)) return;
    const day = dayKey();
    this.data.firstDay ??= day;
    const models = (this.data.days[day] ??= {});
    const key = `${src.providerId}::${src.model}`;
    const row = (models[key] ??= { providerId: src.providerId, providerName: src.providerName, model: src.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
    row.providerName = src.providerName;
    row.input += u.input;
    row.output += u.output;
    row.cacheRead += u.cacheRead;
    row.cacheWrite += u.cacheWrite;
    row.requests += 1;
    this.scheduleSave();
  }

  summary(): UsageSummary {
    const days = Object.keys(this.data.days)
      .sort()
      .map((date) => ({ date, models: this.data.days[date] }));
    return { firstDay: this.data.firstDay ?? null, today: dayKey(), days };
  }

  /** Writes now (on quit). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data), "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Writes synchronously: for quitting, when an async write might not finish. */
  flushSync(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.file);
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, 2000);
  }
}
