import { randomUUID } from 'node:crypto';
import type { ResidentAccount, ResidentRound, ResidentSettings, ResidentView } from '../../shared/types.ts';
import { detectLimit } from '../quota/detect.ts';

// Super-resident mode: once switched on, an endless loop of learning rounds on the subscription
// accounts. One round at a time, each a background conversation (runRound). When an account runs
// out of quota the next one takes over; when all are out, a timer waits for the earliest reset.
// Everything the loop needs to pick up again after a restart is in the store. No electron here:
// time, timers, the store and the round itself are injected, so this runs under node --test.

export const ACCOUNTS: ResidentAccount[] = ['claude', 'codex'];
/** The pause between two rounds. */
export const COOLDOWN_MS = 60_000;
/** A round taking longer is stopped and counts as failed. */
export const ROUND_TIMEOUT_MS = 60 * 60_000;
/** How soon to look again when the chat is busy, no project is open or nobody is logged in. */
export const RETRY_MS = 30_000;
export const KEEP_ROUNDS = 200;
/** This many rounds in a row that failed or left nothing behind pause the loop. */
export const MAX_BAD_ROUNDS = 3;
export const MAX_TOPICS = 50;
export const MAX_TOPIC_CHARS = 200;
/** What a round is called when the agent picks the topic and reports no title. */
export const SELF_TOPIC = '自主选题';
const MAX_TIMER = 2147483647;
const MAX_SUMMARY = 2000;
const MAX_OUTPUTS = 30;

export const DEFAULT_SETTINGS: ResidentSettings = {
  topics: [],
  selfDirected: true,
  targets: { knowledge: true, project: false, self: false },
  accounts: ['claude', 'codex'],
  dailyRounds: 0,
  defaultDelayHours: 5,
};

/** What is kept on disk. */
export interface ResidentState {
  on: boolean;
  startedAt?: number;
  settings: ResidentSettings;
  /** Finished rounds, newest first. */
  rounds: ResidentRound[];
  /** The round in progress; one found here at startup was cut off by the app closing. */
  current?: ResidentRound;
  limitedUntil: Partial<Record<ResidentAccount, number>>;
  /** How many topics of the list have been finished. */
  topicCursor: number;
  /** The local day roundsToday counts for, YYYY-MM-DD. */
  day: string;
  roundsToday: number;
  /** Rounds in a row that failed or left nothing behind. */
  badStreak: number;
  /** The loop paused itself until the user says go on; this is why. */
  paused?: string;
}

export interface ResidentStore {
  load(): unknown;
  save(state: ResidentState): void;
}

export interface RoundRequest {
  id: string;
  account: ResidentAccount;
  /** null: the agent picks the topic itself. */
  topic: string | null;
  settings: ResidentSettings;
  /** The latest rounds, newest first, so the same thing isn't learned twice. */
  recent: { topic: string; summary: string }[];
  /** Aborted when the round is stopped or runs out of time. */
  signal: AbortSignal;
}

export interface RoundResult {
  /** The round ran to its end (the agent reported, or finished its reply). */
  ok: boolean;
  /** The title the agent gave a topic it picked itself. */
  topic?: string;
  summary: string;
  outputs: string[];
  /** The turn's raw error, if it ended on one: checked for a usage limit and its reset time. */
  error?: unknown;
}

export interface ResidentDeps {
  store: ResidentStore;
  now?: () => number;
  setTimer?: (fn: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Runs one round on exactly this account. Must settle once its signal is aborted. */
  runRound(req: RoundRequest): Promise<RoundResult>;
  /** The account is logged in right now. */
  accountReady(account: ResidentAccount): boolean | Promise<boolean>;
  /** The main chat is working: the next round waits for it. */
  chatBusy(): boolean;
  hasProject(): boolean;
  notify(title: string, body: string): void;
  changed(view: ResidentView): void;
  error?(err: unknown): void;
}

interface Running {
  round: ResidentRound;
  controller: AbortController;
  /** The topic came from the list (not picked by the agent). */
  listed: boolean;
  timedOut: boolean;
  /** Already recorded (stopped by hand): whatever runRound returns later is dropped. */
  closed: boolean;
  timer?: unknown;
}

/** Checks settings from the window; throws a message for the user. */
export function validateSettings(value: unknown): ResidentSettings {
  const s = value as Partial<ResidentSettings> | null;
  if (!s || typeof s !== 'object') throw new Error('超级常驻设置无效');
  if (!Array.isArray(s.topics) || s.topics.some((t) => typeof t !== 'string')) throw new Error('学习主题格式不对');
  const topics = s.topics.map((t) => t.trim()).filter(Boolean);
  if (topics.length > MAX_TOPICS) throw new Error(`学习主题最多 ${MAX_TOPICS} 条`);
  if (topics.some((t) => Array.from(t).length > MAX_TOPIC_CHARS)) throw new Error(`每条学习主题不能超过 ${MAX_TOPIC_CHARS} 字`);
  if (typeof s.selfDirected !== 'boolean') throw new Error('「自主选题」开关无效');
  const t = s.targets;
  if (!t || typeof t.knowledge !== 'boolean' || typeof t.project !== 'boolean' || typeof t.self !== 'boolean') throw new Error('沉淀目标设置无效');
  if (!t.knowledge && !t.project && !t.self) throw new Error('沉淀目标至少要开一个');
  if (!Array.isArray(s.accounts) || !s.accounts.length) throw new Error('至少要选一个订阅账号');
  if (s.accounts.some((a) => !ACCOUNTS.includes(a))) throw new Error('订阅账号只能是 Claude 或 ChatGPT（Codex）');
  const accounts = [...new Set(s.accounts)];
  if (typeof s.dailyRounds !== 'number' || !Number.isInteger(s.dailyRounds) || s.dailyRounds < 0) throw new Error('每天轮数要填 0 或正整数（0 表示不限）');
  if (typeof s.defaultDelayHours !== 'number' || !Number.isFinite(s.defaultDelayHours) || s.defaultDelayHours < 1 || s.defaultDelayHours > 24) throw new Error('默认等待时间要在 1–24 小时之间');
  return {
    topics,
    selfDirected: s.selfDirected,
    targets: { knowledge: t.knowledge, project: t.project, self: t.self },
    accounts,
    dailyRounds: s.dailyRounds,
    defaultDelayHours: s.defaultDelayHours,
  };
}

export class ResidentService {
  private readonly deps: ResidentDeps;
  private state: ResidentState = fresh();
  private phase: ResidentView['phase'] = 'off';
  private note: string | undefined;
  private resumeAt: number | undefined;
  private timer: unknown;
  private current: Running | null = null;
  /** A stopped round's conversation is still winding down: no new round until it has. */
  private winding = false;
  private stepping = false;
  private again = false;
  /** Before start() and after stop(). */
  private halted = true;
  private cooldownUntil = 0;
  /** "Run now" asked for one round past today's cap. */
  private extraRound = false;
  private ready: Record<ResidentAccount, boolean> = { claude: false, codex: false };

  constructor(deps: ResidentDeps) {
    this.deps = deps;
  }

  /** App start: loads the saved state and, if the switch is still on, goes on. */
  start(): void {
    this.state = restore(this.safely(() => this.deps.store.load()));
    this.halted = false;
    this.current = null;
    this.winding = false;
    const left = this.state.current;
    if (left) {
      // Cut off by the app closing: it can't be picked up, its topic is tried again.
      left.status = 'stopped';
      left.endedAt ??= this.now();
      left.summary ||= 'sikeoop 关掉了，这一轮没跑完';
      this.record(left);
    }
    this.save();
    this.phase = 'off';
    this.publish();
    if (this.state.on) this.kick();
  }

  /** App quit: stops the round in progress and the timers; the switch stays as it is. */
  stop(): void {
    this.abortCurrent('sikeoop 关掉了，这一轮没跑完');
    this.halted = true;
    this.clearTimer();
  }

  async view(): Promise<ResidentView> {
    await this.refreshReady();
    return this.snapshot();
  }

  async setSettings(value: unknown): Promise<ResidentView> {
    this.state.settings = validateSettings(value);
    this.save();
    if (this.state.on && !this.current) await this.step();
    else this.publish();
    return this.view();
  }

  async turnOn(): Promise<ResidentView> {
    if (!this.deps.hasProject()) throw new Error('先打开一个项目，超级常驻模式要在项目里学习和沉淀');
    await this.refreshReady();
    if (!this.state.settings.accounts.some((a) => this.ready[a])) throw new Error('还没有已登录的订阅账号：先在设置里用账号登录 Claude 或 ChatGPT 订阅');
    if (!this.state.on) {
      this.state.on = true;
      this.state.startedAt = this.now();
      this.state.paused = undefined;
      this.state.badStreak = 0;
      this.cooldownUntil = 0;
      this.save();
    }
    await this.step();
    // The round stopped a moment ago is still winding down; the next one starts when it has.
    if (this.phase === 'off') this.set('cooldown');
    return this.snapshot();
  }

  async turnOff(): Promise<ResidentView> {
    this.state.on = false;
    this.clearTimer();
    this.cooldownUntil = 0;
    this.extraRound = false;
    this.abortCurrent('手动停下了');
    this.save();
    this.set('off');
    return this.view();
  }

  /** Lifts a pause and skips the waiting (quota, cooldown, today's cap for one round). */
  async runNow(): Promise<ResidentView> {
    if (!this.state.on) throw new Error('超级常驻模式还没有打开');
    if (!this.current) {
      this.state.paused = undefined;
      this.state.badStreak = 0;
      this.state.limitedUntil = {};
      this.cooldownUntil = 0;
      this.extraRound = true;
      this.save();
      await this.step();
    }
    return this.view();
  }

  /** The open project is about to change: a round's tools would otherwise work on the new folder. */
  projectChanged(): void {
    if (this.halted || !this.state.on) return;
    const running = !!this.current;
    this.abortCurrent('切换了项目，这一轮停下了');
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + RETRY_MS);
    if (running) this.set('cooldown', '切换了项目，稍后继续', this.cooldownUntil);
    this.kick();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private kick(): void {
    void this.step().catch((e) => this.deps.error?.(e));
  }

  /** Decide what happens next. Safe to call at any time; calls while it runs are folded into one more pass. */
  private async step(): Promise<void> {
    if (this.stepping) {
      this.again = true;
      return;
    }
    this.stepping = true;
    try {
      do {
        this.again = false;
        await this.advance();
      } while (this.again);
    } finally {
      this.stepping = false;
    }
  }

  private async advance(): Promise<void> {
    if (this.halted || !this.state.on || this.current || this.winding) return;
    this.clearTimer();
    let now = this.now();
    this.rollDay(now);
    const s = this.state;
    if (s.paused) return this.set('paused', s.paused);
    const cap = s.settings.dailyRounds;
    if (cap > 0 && s.roundsToday >= cap && !this.extraRound) return this.set('paused', `今天已经跑满 ${cap} 轮，明天 0 点自动继续`, nextMidnight(now));
    if (this.cooldownUntil > now) return this.set('cooldown', undefined, this.cooldownUntil);
    if (!this.deps.hasProject()) return this.set('paused', '没有打开项目，打开项目后自动继续', now + RETRY_MS, true);
    if (this.deps.chatBusy()) return this.set('cooldown', '对话正在忙，等它停下再开始下一轮', now + RETRY_MS, true);
    await this.refreshReady();
    // Things may have changed while the logins were checked.
    if (this.halted || !s.on || this.state !== s || this.current || this.winding) return;
    now = this.now();
    const usable = s.settings.accounts.filter((a) => this.ready[a]);
    if (!usable.length) return this.set('paused', '没有已登录的订阅账号，登录后自动继续', now + RETRY_MS, true);
    const account = usable.find((a) => (s.limitedUntil[a] ?? 0) <= now);
    if (!account) {
      const at = Math.min(...usable.map((a) => s.limitedUntil[a] ?? now));
      return this.set('waiting_quota', '订阅账号的额度都用完了，到点自动继续', at);
    }
    void this.run(account).catch((e) => this.deps.error?.(e));
  }

  /** The next topic: the list in order; past its end the agent picks (or the list starts over when it may not). */
  private pickTopic(): string | null {
    const { topics, selfDirected } = this.state.settings;
    if (!topics.length) return null;
    const i = this.state.topicCursor;
    if (i < topics.length) return topics[i];
    return selfDirected ? null : topics[i % topics.length];
  }

  private async run(account: ResidentAccount): Promise<void> {
    const topic = this.pickTopic();
    const round: ResidentRound = { id: randomUUID(), startedAt: this.now(), account, topic: topic ?? SELF_TOPIC, status: 'running', summary: '', outputs: [] };
    const cur: Running = { round, controller: new AbortController(), listed: topic !== null, timedOut: false, closed: false };
    this.current = cur;
    this.extraRound = false;
    this.state.current = round;
    this.save();
    this.set('running');
    cur.timer = this.arm(() => {
      cur.timedOut = true;
      cur.controller.abort();
    }, ROUND_TIMEOUT_MS);
    let res: RoundResult;
    try {
      res = await this.deps.runRound({
        id: round.id,
        account,
        topic,
        settings: structuredClone(this.state.settings),
        recent: this.state.rounds.filter((r) => r.summary && r.status !== 'quota').slice(0, 8).map((r) => ({ topic: r.topic, summary: r.summary })),
        signal: cur.controller.signal,
      });
    } catch (e) {
      res = { ok: false, summary: e instanceof Error ? e.message : String(e), outputs: [], error: e };
    }
    this.disarm(cur.timer);
    if (cur.closed) {
      // Stopped by hand and recorded then; its conversation has now really ended.
      this.winding = false;
    } else {
      this.finish(cur, res);
    }
    await this.step();
  }

  private finish(cur: Running, res: RoundResult): void {
    const now = this.now();
    const s = this.state;
    const round = cur.round;
    cur.closed = true;
    round.endedAt = now;
    round.summary = String(res.summary ?? '').trim().slice(0, MAX_SUMMARY);
    round.outputs = (Array.isArray(res.outputs) ? res.outputs : []).map((o) => String(o).trim().slice(0, 300)).filter(Boolean).slice(0, MAX_OUTPUTS);
    if (!cur.listed && res.topic?.trim()) round.topic = res.topic.trim().slice(0, MAX_TOPIC_CHARS);
    const hit = cur.timedOut || res.error === undefined ? null : detectLimit(res.error, now);
    if (hit) {
      // Out of quota: the account rests until its reset, the topic goes to the next account right away.
      round.status = 'quota';
      s.limitedUntil[round.account] = hit.resumeAt === undefined ? now + s.settings.defaultDelayHours * 3_600_000 : Math.max(now, hit.resumeAt) + 60_000;
      round.summary ||= `额度用完了：${hit.reason.slice(0, 200)}`;
    } else {
      round.status = cur.timedOut || !res.ok ? 'failed' : 'ok';
      if (cur.timedOut) round.summary = `超过 ${ROUND_TIMEOUT_MS / 60_000} 分钟还没做完，停下了${round.summary ? `\n${round.summary}` : ''}`;
      this.rollDay(now);
      s.roundsToday++;
      if (cur.listed) s.topicCursor++;
      s.badStreak = round.status === 'failed' || !round.outputs.length ? s.badStreak + 1 : 0;
      if (s.badStreak >= MAX_BAD_ROUNDS) {
        s.badStreak = 0;
        s.paused = `连续 ${MAX_BAD_ROUNDS} 轮失败或没有留下任何产出，先停下了。看看最近几轮的记录，没问题就点「立即运行」继续`;
        this.safely(() => this.deps.notify('超级常驻模式暂停了', s.paused!.slice(0, 120)));
      } else {
        this.cooldownUntil = now + COOLDOWN_MS;
      }
    }
    this.current = null;
    this.record(round);
    this.save();
  }

  /** Stops the round in progress and records it as stopped at once; its conversation ends on its own time. */
  private abortCurrent(why: string): void {
    const cur = this.current;
    if (!cur) return;
    cur.closed = true;
    this.disarm(cur.timer);
    cur.round.status = 'stopped';
    cur.round.endedAt = this.now();
    cur.round.summary = why;
    this.current = null;
    this.winding = true;
    this.record(cur.round);
    this.save();
    cur.controller.abort();
  }

  private record(round: ResidentRound): void {
    this.state.current = undefined;
    this.state.rounds.unshift(round);
    this.state.rounds.length = Math.min(this.state.rounds.length, KEEP_ROUNDS);
  }

  private rollDay(now: number): void {
    const key = dayKey(now);
    if (this.state.day === key) return;
    this.state.day = key;
    this.state.roundsToday = 0;
  }

  private async refreshReady(): Promise<void> {
    for (const a of ACCOUNTS) {
      try {
        this.ready[a] = (await this.deps.accountReady(a)) === true;
      } catch (e) {
        this.ready[a] = false;
        this.deps.error?.(e);
      }
    }
  }

  /** Sets what the view shows and, with a time, the timer that looks again then. */
  private set(phase: ResidentView['phase'], note?: string, at?: number, quiet = false): void {
    this.phase = phase;
    this.note = note;
    // quiet: a short look-again, not a time worth showing.
    this.resumeAt = quiet ? undefined : at;
    this.clearTimer();
    if (at !== undefined && !this.halted && this.state.on) this.timer = this.arm(() => {
      this.timer = undefined;
      this.kick();
    }, at - this.now());
    this.publish();
  }

  private snapshot(): ResidentView {
    const s = this.state;
    const now = this.now();
    const order = [...s.settings.accounts, ...ACCOUNTS.filter((a) => !s.settings.accounts.includes(a))];
    return structuredClone({
      on: s.on,
      phase: s.on ? this.phase : 'off',
      ...(s.on && this.note ? { note: this.note } : {}),
      ...(s.on && this.resumeAt !== undefined ? { resumeAt: this.resumeAt } : {}),
      ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      roundsToday: s.day === dayKey(now) ? s.roundsToday : 0,
      ...(this.current ? { current: this.current.round } : {}),
      rounds: s.rounds,
      settings: s.settings,
      accounts: order.map((id) => ({ id, ready: this.ready[id], ...((s.limitedUntil[id] ?? 0) > now ? { limitedUntil: s.limitedUntil[id] } : {}) })),
    });
  }

  private publish(): void {
    this.safely(() => this.deps.changed(this.snapshot()));
  }

  private save(): void {
    this.safely(() => this.deps.store.save(this.state));
  }

  private safely<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.deps.error?.(e);
      return undefined;
    }
  }

  private arm(fn: () => void, delay: number): unknown {
    const ms = Math.min(MAX_TIMER, Math.max(1, delay));
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  }

  private disarm(timer: unknown): void {
    if (timer === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private clearTimer(): void {
    this.disarm(this.timer);
    this.timer = undefined;
  }
}

function fresh(): ResidentState {
  return { on: false, settings: structuredClone(DEFAULT_SETTINGS), rounds: [], limitedUntil: {}, topicCursor: 0, day: '', roundsToday: 0, badStreak: 0 };
}

/** The saved state, with anything unreadable replaced by its default. */
function restore(raw: unknown): ResidentState {
  const out = fresh();
  if (!raw || typeof raw !== 'object') return out;
  const x = raw as Partial<ResidentState>;
  try {
    out.settings = validateSettings(x.settings);
  } catch {
    // Keep the defaults.
  }
  out.on = x.on === true;
  if (Number.isFinite(x.startedAt)) out.startedAt = x.startedAt;
  if (Array.isArray(x.rounds)) out.rounds = x.rounds.filter(validRound).slice(0, KEEP_ROUNDS);
  if (validRound(x.current)) out.current = x.current;
  for (const a of ACCOUNTS) {
    const t = x.limitedUntil?.[a];
    if (typeof t === 'number' && Number.isFinite(t)) out.limitedUntil[a] = t;
  }
  const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  out.topicCursor = int(x.topicCursor);
  out.roundsToday = int(x.roundsToday);
  out.badStreak = int(x.badStreak);
  if (typeof x.day === 'string') out.day = x.day;
  if (typeof x.paused === 'string' && x.paused) out.paused = x.paused;
  return out;
}

function validRound(r: unknown): r is ResidentRound {
  if (!r || typeof r !== 'object') return false;
  const x = r as ResidentRound;
  return typeof x.id === 'string' && Number.isFinite(x.startedAt) && ACCOUNTS.includes(x.account) && typeof x.topic === 'string'
    && ['running', 'ok', 'failed', 'quota', 'stopped'].includes(x.status) && typeof x.summary === 'string'
    && Array.isArray(x.outputs) && x.outputs.every((o) => typeof o === 'string');
}

/** The local day of a time, YYYY-MM-DD. */
function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
