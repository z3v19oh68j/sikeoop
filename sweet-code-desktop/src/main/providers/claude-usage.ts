import { DefaultUserAgent } from "./claude-mimic.ts";
import { createHash } from "node:crypto";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_TIMEOUT = 30_000;
export const USAGE_CACHE_TTL = 3 * 60_000;
export const USAGE_ERROR_CACHE_TTL = 60_000;

export interface ClaudeUsageWindow {
  utilization: number;
  resets_at: string;
}

export interface ClaudeUsage {
  five_hour: ClaudeUsageWindow;
  seven_day: ClaudeUsageWindow;
  seven_day_sonnet: ClaudeUsageWindow;
  seven_day_overage_included: ClaudeUsageWindow;
}

const EMPTY: ClaudeUsageWindow = { utilization: 0, resets_at: "" };

function parseWindow(raw: unknown): ClaudeUsageWindow {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const u = (raw as { utilization?: unknown }).utilization;
  const r = (raw as { resets_at?: unknown }).resets_at;
  return {
    utilization: typeof u === "number" && Number.isFinite(u) ? u : 0,
    resets_at: typeof r === "string" ? r : "",
  };
}

export function parseClaudeUsage(payload: unknown): ClaudeUsage {
  const o = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    five_hour: parseWindow(o.five_hour),
    seven_day: parseWindow(o.seven_day),
    seven_day_sonnet: parseWindow(o.seven_day_sonnet),
    seven_day_overage_included: parseWindow(o.seven_day_overage_included),
  };
}

/** Query the subscription usage endpoint with an already-validated OAuth bearer. Caller handles fallback. */
export async function fetchClaudeUsage(
  accessToken: string,
  options: { fetch?: typeof fetch; timeout?: number } = {},
): Promise<ClaudeUsage> {
  if (typeof accessToken !== "string" || !accessToken.trim()) throw new Error("Claude OAuth 未登录");
  const request = options.fetch ?? fetch;
  const response = await request(USAGE_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(options.timeout ?? USAGE_TIMEOUT),
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": DefaultUserAgent(),
    },
  });
  if (!response.ok) throw new Error(`Claude 用量请求失败 (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Claude 用量返回无效 JSON"); }
  return parseClaudeUsage(payload);
}

type UsageCacheEntry = { expires: number } & ({ value: ClaudeUsage; error?: never } | { error: string; value?: never });
interface UsageCacheSlot {
  fingerprint: string;
  entry?: UsageCacheEntry;
  pending?: Promise<ClaudeUsage>;
}

/** A bounded, in-memory single-user cache. Credentials and raw transport errors are never stored. */
export class ClaudeUsageCache {
  private slot?: UsageCacheSlot;
  private readonly now: () => number;
  private readonly requestOptions: { fetch?: typeof fetch; timeout?: number };

  constructor(options: { fetch?: typeof fetch; timeout?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.requestOptions = { fetch: options.fetch, timeout: options.timeout };
  }

  async get(accessToken: string): Promise<ClaudeUsage> {
    // Invalid credentials never hit an old cache entry or start a request.
    if (typeof accessToken !== "string" || !accessToken.trim()) throw new Error("Claude OAuth 未登录");
    const fingerprint = createHash("sha256").update(accessToken).digest("hex");
    if (this.slot?.fingerprint !== fingerprint) this.slot = { fingerprint };
    const slot = this.slot;
    if (slot.entry && this.now() < slot.entry.expires) {
      if (slot.entry.error !== undefined) throw new Error(slot.entry.error);
      return structuredClone(slot.entry.value);
    }
    slot.pending ??= fetchClaudeUsage(accessToken, this.requestOptions).then(value => {
      slot.entry = { value: structuredClone(value), expires: this.now() + USAGE_CACHE_TTL };
      return value;
    }, error => {
      // Only the transport's allowlisted public errors are safe to retain/replay.
      const message = error instanceof Error && /^Claude 用量(?:请求失败 \(HTTP \d{3}\)|返回无效 JSON)$/.test(error.message)
        ? error.message : "Claude 用量查询失败";
      slot.entry = { error: message, expires: this.now() + USAGE_ERROR_CACHE_TTL };
      throw new Error(message);
    }).finally(() => { slot.pending = undefined; });
    // Each caller owns its result. An old credential's pending request can only fill its detached slot.
    return structuredClone(await slot.pending);
  }
}

const usageCache = new ClaudeUsageCache();
export const cachedClaudeUsage = (accessToken: string): Promise<ClaudeUsage> => usageCache.get(accessToken);

const PASSIVE_WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included"] as const;
type PassiveWindowName = typeof PASSIVE_WINDOWS[number];
export interface ClaudeUsageSampleWindow { utilization?: number; reset?: number }
/** Percentages and Unix seconds only; no account IDs, credentials, headers or response bodies. */
export type ClaudeUsageSnapshot = { sampled_at: string } & Partial<Record<PassiveWindowName, ClaudeUsageSampleWindow>>;
export interface ClaudePassiveUsage extends ClaudeUsage { source: "passive"; sampled_at: string }

export function parseClaudeUsageSnapshot(raw: unknown): ClaudeUsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.sampled_at !== "string" || !Number.isFinite(Date.parse(record.sampled_at))) return undefined;
  const result: ClaudeUsageSnapshot = { sampled_at: record.sampled_at };
  for (const name of PASSIVE_WINDOWS) {
    const value = record[name];
    if (!value || typeof value !== "object") continue;
    const window = value as Record<string, unknown>, clean: ClaudeUsageSampleWindow = {};
    if (typeof window.utilization === "number" && Number.isFinite(window.utilization)) clean.utilization = window.utilization;
    if (typeof window.reset === "number" && Number.isSafeInteger(window.reset) && window.reset > 0 && window.reset * 1000 <= 8.64e15) clean.reset = window.reset;
    if (Object.keys(clean).length) result[name] = clean;
  }
  return PASSIVE_WINDOWS.some(name => result[name]) ? result : undefined;
}

/** Header utilization is a fraction; persisted utilization is percent, reset is Unix seconds. */
export function parsePassiveUsageHeaders(headers: Headers, now = Date.now()): ClaudeUsageSnapshot | undefined {
  const snapshot: ClaudeUsageSnapshot = { sampled_at: new Date(now).toISOString() };
  for (const [headerName, name] of [["5h", "five_hour"], ["7d", "seven_day"], ["7d_oi", "seven_day_overage_included"]] as const) {
    const value: ClaudeUsageSampleWindow = {};
    const utilization = headers.get(`anthropic-ratelimit-unified-${headerName}-utilization`);
    if (utilization && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(utilization)) {
      const percent = Number(utilization) * 100;
      if (Number.isFinite(percent)) value.utilization = percent;
    }
    const reset = headers.get(`anthropic-ratelimit-unified-${headerName}-reset`);
    if (reset && /^[+-]?\d+$/.test(reset)) {
      let seconds = Number(reset);
      if (seconds > 1e11) seconds = Math.trunc(seconds / 1000);
      if (Number.isSafeInteger(seconds) && seconds > 0 && seconds * 1000 <= 8.64e15) value.reset = seconds;
    }
    if (Object.keys(value).length) snapshot[name] = value;
  }
  return PASSIVE_WINDOWS.some(name => snapshot[name]) ? snapshot : undefined;
}

export function projectPassiveClaudeUsage(raw: unknown, now = Date.now()): ClaudePassiveUsage | undefined {
  const snapshot = parseClaudeUsageSnapshot(raw);
  if (!snapshot) return undefined;
  const window = (name: PassiveWindowName): ClaudeUsageWindow => {
    const value = snapshot[name];
    return { utilization: value?.reset && value.reset * 1000 <= now ? 0 : value?.utilization ?? 0,
      resets_at: value?.reset ? new Date(value.reset * 1000).toISOString() : "" };
  };
  return { five_hour: window("five_hour"), seven_day: window("seven_day"), seven_day_sonnet: { ...EMPTY },
    seven_day_overage_included: window("seven_day_overage_included"), source: "passive", sampled_at: snapshot.sampled_at };
}

export class ClaudePassiveUsageStore {
  private memory?: ClaudeUsageSnapshot;
  private read: () => unknown;
  private write: (snapshot: ClaudeUsageSnapshot | undefined) => Promise<void>;
  private readonly now: () => number;
  private pending: Promise<void> = Promise.resolve();
  private epoch = 0;

  constructor(options: { read?: () => unknown; write?: (snapshot: ClaudeUsageSnapshot | undefined) => Promise<void>; now?: () => number } = {}) {
    this.read = options.read ?? (() => this.memory);
    this.write = options.write ?? (async snapshot => { this.memory = snapshot; });
    this.now = options.now ?? Date.now;
  }
  configure(read: () => unknown, write: (snapshot: ClaudeUsageSnapshot | undefined) => Promise<void>): void {
    this.epoch++;
    this.read = read;
    this.write = write;
  }
  generation(): number { return this.epoch; }
  private enqueue(update: (previous: ClaudeUsageSnapshot | undefined) => ClaudeUsageSnapshot | undefined, epoch: number): Promise<void> {
    const read = this.read, write = this.write;
    this.pending = this.pending.then(async () => {
      if (epoch !== this.epoch) return;
      await write(update(parseClaudeUsageSnapshot(read())));
    }).catch(() => {}); // Best effort only: persistence/parse failures must never break inference.
    return this.pending;
  }
  sample(headers: Headers, epoch = this.epoch): Promise<void> {
    try {
      const update = parsePassiveUsageHeaders(headers, this.now());
      if (!update || epoch !== this.epoch) return Promise.resolve();
      return this.enqueue(previous => {
        const merged: ClaudeUsageSnapshot = { ...previous, sampled_at: update.sampled_at };
        for (const name of PASSIVE_WINDOWS) {
          const incoming = update[name];
          if (!incoming) continue;
          const old = merged[name];
          // A new reset boundary without a fresh utilization must not carry the old window's percentage.
          merged[name] = incoming.reset !== undefined && old?.reset !== incoming.reset
            ? { utilization: 0, ...incoming } : { ...old, ...incoming };
        }
        return merged;
      }, epoch);
    } catch { return Promise.resolve(); }
  }
  clear(): Promise<void> { return this.enqueue(() => undefined, ++this.epoch); }
  async passive(): Promise<ClaudePassiveUsage | undefined> {
    try { await this.pending; return projectPassiveClaudeUsage(this.read(), this.now()); }
    catch { return undefined; }
  }
}

const passiveUsageStore = new ClaudePassiveUsageStore();
export const configureClaudeUsageSnapshotStorage = (read: () => unknown, write: (snapshot: ClaudeUsageSnapshot | undefined) => Promise<void>): void => passiveUsageStore.configure(read, write);
export const captureClaudeUsageSampleEpoch = (): number => passiveUsageStore.generation();
export const samplePassiveUsageFromHeaders = (headers: Headers, epoch?: number): Promise<void> => passiveUsageStore.sample(headers, epoch);
export const clearClaudeUsageSnapshot = (): Promise<void> => passiveUsageStore.clear();

/** Preserve the active query's negative cache; project the latest passive sample on every failed read. */
export async function claudeUsageWithPassiveFallback(accessToken: string, active: (token: string) => Promise<ClaudeUsage> = cachedClaudeUsage,
  passive: () => Promise<ClaudePassiveUsage | undefined> = () => passiveUsageStore.passive()): Promise<ClaudeUsage | ClaudePassiveUsage> {
  if (typeof accessToken !== "string" || !accessToken.trim()) throw new Error("Claude OAuth 未登录");
  const epoch = passiveUsageStore.generation();
  try { return await active(accessToken); }
  catch (error) {
    if (epoch !== passiveUsageStore.generation()) throw error;
    let sampled: ClaudePassiveUsage | undefined;
    try { sampled = await passive(); } catch {}
    if (epoch !== passiveUsageStore.generation()) throw error;
    if (sampled) return sampled;
    throw error;
  }
}

export const RESET_CREDITS_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
export const RESET_CREDITS_TIMEOUT = 25_000;
export interface ClaudeResetCredit {
  label: string; resets_left: number; starts_at?: string; expires_at?: string;
  clears: string[]; percent_used: Record<string, number>; blocking: string[] | null;
  use_requires_limit: boolean; redeemable: boolean;
}
export interface ClaudeResetCredits {
  eligible: boolean; available_count: number; credits: ClaudeResetCredit[];
  cooldown_until?: string; weekly_resets_at?: string; fetched_at: string;
}
export type ClaudeResetCreditsResult = ClaudeResetCredits | { error: string };
const invalidReset = (): never => { throw new Error("Claude reset 返回无效状态"); };
const resetObject = (raw: unknown): Record<string, unknown> => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : invalidReset();
function resetString(raw: unknown): string { return raw == null ? "" : typeof raw === "string" ? raw : invalidReset(); }
function resetBoolean(raw: unknown): boolean { return raw == null ? false : typeof raw === "boolean" ? raw : invalidReset(); }
function resetStrings(raw: unknown): string[] | null {
  if (raw == null) return null;
  return Array.isArray(raw) && raw.every(value => typeof value === "string") ? [...raw] : invalidReset();
}
function resetDate(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return invalidReset();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match || !Number.isFinite(Date.parse(raw))) return invalidReset();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes February 30 and 24:00; Go's time.Time JSON decoder rejects them.
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(hourText) > 23 ||
      Number(minuteText) > 59 || Number(secondText) > 59 || Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59) return invalidReset();
  return raw;
}

/** Query projection only: raw grant IDs, next_grant_id and organization fields never leave this module. */
export function projectClaudeResetCredits(raw: unknown, now = Date.now()): ClaudeResetCredits {
  const result: ClaudeResetCredits = { eligible: false, available_count: 0, credits: [], fetched_at: new Date(now).toISOString() };
  if (raw == null) return result;
  const block = resetObject(raw);
  result.eligible = resetBoolean(block.eligible);
  const atLimit = resetBoolean(block.at_limit), nextGrant = resetString(block.next_grant_id);
  const cooldown = resetDate(block.cooldown_until), weekly = resetDate(block.weekly_resets_at);
  if (cooldown && now < Date.parse(cooldown)) result.cooldown_until = cooldown;
  if (weekly) result.weekly_resets_at = weekly;
  if (!Array.isArray(block.grants)) return invalidReset();
  for (const rawGrant of block.grants) {
    const grant = resetObject(rawGrant), id = resetString(grant.id), label = resetString(grant.label);
    const resets = grant.resets_left == null ? 0 : grant.resets_left;
    if (typeof resets !== "number" || !Number.isSafeInteger(resets)) return invalidReset();
    const starts = resetDate(grant.starts_at), ends = resetDate(grant.ends_at);
    const clears = resetStrings(grant.clears) ?? [], blocking = resetStrings(grant.blocking);
    const paused = resetBoolean(grant.paused), usable = resetBoolean(grant.usable_now);
    const requires = grant.use_requires_limit == null ? true : resetBoolean(grant.use_requires_limit);
    const percentUsed: Record<string, number> = {};
    if (grant.percent_used != null) {
      for (const [key, value] of Object.entries(resetObject(grant.percent_used))) {
        if (typeof value !== "number" || !Number.isFinite(value)) return invalidReset();
        if (value >= 0 && value <= 100) Object.defineProperty(percentUsed, key, { value, enumerable: true, configurable: true, writable: true });
      }
    }
    if (!/^[a-z0-9_-]{1,40}$/.test(id) || !clears.length || resets <= 0 || paused ||
        (starts && now < Date.parse(starts)) || (ends && now >= Date.parse(ends))) continue;
    const redeemable = result.eligible && usable && id === nextGrant && (!requires || atLimit) && !blocking?.length &&
      (!cooldown || now >= Date.parse(cooldown));
    result.credits.push({ label, resets_left: resets, ...(starts ? { starts_at: starts } : {}), ...(ends ? { expires_at: ends } : {}),
      clears, percent_used: percentUsed, blocking, use_requires_limit: requires, redeemable });
    if (redeemable) result.available_count += resets;
  }
  return result;
}

async function readResetEnvelope(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return invalidReset();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (1 << 20)) { await reader.cancel(); return invalidReset(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const envelope = resetObject(JSON.parse(text));
    if (Object.hasOwn(envelope, "error")) return invalidReset();
    return envelope;
  } catch { return invalidReset(); }
  finally { reader.releaseLock(); }
}

/** Read-only cedar_ember query. No redemption URL, POST, grant IDs or raw upstream errors are exposed. */
export async function queryClaudeResetCredits(accessToken: string, options: { fetch?: typeof fetch; now?: () => number; timeout?: number } = {}): Promise<ClaudeResetCreditsResult> {
  if (typeof accessToken !== "string" || !accessToken.trim()) return { error: "Claude OAuth 未登录" };
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(RESET_CREDITS_URL, { method: "GET", redirect: "error",
        signal: AbortSignal.timeout(options.timeout ?? RESET_CREDITS_TIMEOUT), headers: {
          Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20", "x-app": "cli", "User-Agent": DefaultUserAgent(),
        } });
    } catch { return { error: "Claude reset 查询失败" }; }
    if (response.status !== 200) return { error: `Claude reset 上游 HTTP ${response.status}` };
    const envelope = await readResetEnvelope(response);
    return projectClaudeResetCredits(envelope.cedar_ember, (options.now ?? Date.now)());
  } catch { return { error: "Claude reset 返回无效状态" }; }
}
