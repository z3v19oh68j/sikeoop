import { randomUUID } from 'node:crypto';
import type { ResumePlan, QuotaSettings } from '../../shared/types.ts';
import { detectLimit } from './detect.ts';
import { AUTO_RESUME_REVIEW_REASON, MAX_AUTO_RESUMES, claimAutoResume, type AutoResumeState } from '../agent/auto-resume.ts';

export const DEFAULT_SETTINGS: QuotaSettings = { autoResume: true, defaultDelayHours: 5, message: '继续' };
type StoredPlan = ResumePlan & { busySince?: number; taskEnded?: boolean };
export interface QuotaStore {
  load(): { settings?: unknown; plans?: unknown };
  saveSettings(settings: QuotaSettings): void;
  savePlans(plans: ResumePlan[]): void;
}
export interface QuotaDeps {
  store: QuotaStore;
  now?: () => number;
  setTimer?: (fn: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  state(target: ResumePlan['target']): 'idle' | 'busy' | 'gone';
  execute(plan: ResumePlan): Promise<void> | void;
  /** Main chat shares the AgentSession budget; CLI sessions use the persisted plans. */
  resumeState?(target: ResumePlan['target']): AutoResumeState | undefined;
  claimResume?(target: ResumePlan['target']): boolean | undefined | Promise<boolean | undefined>;
  /** Marks the corresponding dispatch-console job for human review. */
  review?(plan: ResumePlan): void;
  cancelPending?(target: ResumePlan['target']): string[];
  changed(plans: ResumePlan[]): void;
  notice(text: string): void;
  error?(err: unknown): void;
}
export function validateSettings(value: unknown): QuotaSettings {
  const s = value as QuotaSettings | null;
  if (!s || typeof s.autoResume !== 'boolean' || !Number.isFinite(s.defaultDelayHours) || s.defaultDelayHours < 1 || s.defaultDelayHours > 24 || typeof s.message !== 'string' || !s.message.trim() || Array.from(s.message).length > 200) throw new Error('自动续写设置无效：延迟 1–24 小时，消息非空且不超过 200 字');
  return { autoResume: s.autoResume, defaultDelayHours: s.defaultDelayHours, message: s.message.trim() };
}
export class QuotaService {
  private deps: QuotaDeps;
  private settingsValue = { ...DEFAULT_SETTINGS };
  private plans: StoredPlan[] = [];
  private timer: unknown;
  private stopped = false;
  private running = false;
  constructor(deps: QuotaDeps) { this.deps = deps; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  start(): void {
    const stored = this.deps.store.load();
    try { if (stored.settings) this.settingsValue = validateSettings(stored.settings); } catch (e) { this.deps.error?.(e); }
    if (Array.isArray(stored.plans)) this.plans = stored.plans.filter(validPlan).map(p => ({ ...p, target: { ...p.target } }));
    // Migrate old plans conservatively: completed claims in a target's current task count too.
    for (const target of this.plans.map(p => p.target)) {
      const history = this.plans.filter(p => same(p.target, target));
      const taskId = history.at(-1)?.taskId ?? randomUUID();
      let count = 0;
      for (const p of history) {
        p.taskId ??= taskId;
        if (p.status === 'done') count++;
        p.autoResumeCount ??= Math.min(count, MAX_AUTO_RESUMES);
      }
    }
    this.deps.store.saveSettings(this.settingsValue);
    this.stopped = false;
    this.publish();
    this.arm(true);
  }
  stop(): void { this.stopped = true; this.clear(); }
  settings(): QuotaSettings { return { ...this.settingsValue }; }
  setSettings(value: unknown): QuotaSettings {
    const s = validateSettings(value);
    this.deps.store.saveSettings(s);
    this.settingsValue = s;
    for (const p of this.plans) if (p.status === 'waiting') p.message = s.message;
    // Disabling auto-resume also disables previously scheduled automatic sends.
    if (!s.autoResume) for (const p of this.plans) if (p.status === 'waiting') { p.status = 'cancelled'; p.note = '自动续写已关闭'; }
    this.commit();
    return this.settings();
  }
  list(): ResumePlan[] { return this.plans.map(({ busySince: _busy, taskEnded: _ended, ...p }) => ({ ...p, target: { ...p.target } })); }
  detect(target: ResumePlan['target'], input: unknown): void {
    const now = this.now();
    const hit = detectLimit(input, now);
    if (!hit || !this.settingsValue.autoResume || this.stopped) return;
    const state = this.resumeState(target);
    const old = this.plans.find(p => p.status === 'waiting' && same(p.target, target) && p.taskId === state.taskId);
    if (this.plans.some(p => p.taskId === state.taskId && p.needsReview)) return;
    const plan: StoredPlan = {
      id: old?.id ?? randomUUID(), target: { ...target }, reason: hit.reason, detectedAt: now,
      taskId: state.taskId, autoResumeCount: state.count,
      resumeAt: hit.resumeAt === undefined ? now + this.settingsValue.defaultDelayHours * 3600000 : Math.max(now, hit.resumeAt) + 60000,
      source: hit.source, status: 'waiting', message: this.settingsValue.message,
    };
    if (old) Object.assign(old, plan, { busySince: undefined, note: undefined }); else this.plans.push(plan);
    if (state.needsReview || state.count >= MAX_AUTO_RESUMES) { this.requireReview(old ?? plan); this.commit(); return; }
    this.commit();
    this.deps.notice(`${target.kind === 'cli' ? target.name : target.title || '当前对话'} 额度用完了，已安排 ${new Date(plan.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} 自动继续`);
  }
  takeover(target: ResumePlan['target']): void {
    let changed = false;
    const pending = new Set(this.deps.cancelPending?.(target) ?? []);
    for (const p of this.plans) if ((p.status === 'waiting' || (p.status === 'done' && pending.has(p.id))) && same(p.target, target)) { p.status = 'skipped'; p.note = '你已经接手了'; changed = true; }
    // A human message starts a new task; retain a boundary in the persisted history.
    for (const p of this.plans) if (same(p.target, target) && !p.taskEnded) { p.taskEnded = true; changed = true; }
    if (changed) this.commit();
  }
  cancel(id: string): ResumePlan[] {
    const p = this.plans.find(p => p.id === id);
    if (p?.status === 'waiting') { p.status = 'cancelled'; this.commit(); }
    return this.list();
  }
  async resumeNow(id: string): Promise<ResumePlan[]> {
    const p = this.plans.find(p => p.id === id);
    if (p?.status === 'waiting') { p.resumeAt = this.now(); this.commit(); await this.tick(); }
    return this.list();
  }
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const p of this.plans.filter(p => p.status === 'waiting' && p.resumeAt <= this.now())) {
        if (p.status !== 'waiting' || this.stopped) continue;
        const state = this.deps.state(p.target);
        if (state === 'gone') { p.status = 'skipped'; p.note = '会话已关闭'; }
        else if (state === 'busy') {
          if (p.target.kind === 'chat') { p.status = 'skipped'; p.note = '对话正在忙'; }
          else {
            p.busySince ??= this.now();
            if (this.now() - p.busySince >= 3600000) { p.status = 'skipped'; p.note = '会话持续忙碌超过 1 小时'; }
            else p.resumeAt = this.now() + 300000;
          }
        } else {
          const state = this.resumeState(p.target);
          if (state.taskId !== p.taskId) { p.status = 'skipped'; p.note = '任务已被替换'; this.commit(); continue; }
          let claimed: boolean;
          try { claimed = (await this.deps.claimResume?.(p.target)) ?? claimAutoResume(state); }
          catch (e) {
            p.status = 'skipped'; p.needsReview = true;
            p.note = `自动续跑预算保存失败，已停止，需人工查看：${e instanceof Error ? e.message : String(e)}`;
            this.deps.review?.({ ...p, target: { ...p.target } });
            this.deps.error?.(e); this.commit(); continue;
          }
          // A user may take over while the shared chat claim is being saved.
          if (p.status !== 'waiting' || p.taskEnded || this.stopped) continue;
          p.autoResumeCount = Math.max(state.count, this.deps.resumeState?.(p.target)?.count ?? 0);
          if (!claimed) { this.requireReview(p); this.commit(); continue; }
          // Persist the claim before dispatch, so callbacks/restarts cannot send it twice.
          p.status = 'done'; p.note = '已提交自动继续'; this.commit();
          try { await this.deps.execute(this.list().find(x => x.id === p.id)!); this.deps.notice(`${p.target.kind === 'cli' ? p.target.name : p.target.title || '当前对话'} 正在自动继续`); }
          catch (e) { p.status = 'skipped'; p.note = `执行失败：${e instanceof Error ? e.message : String(e)}`; this.deps.error?.(e); }
        }
        this.commit();
      }
    } finally { this.running = false; this.arm(); }
  }
  private resumeState(target: ResumePlan['target']): AutoResumeState {
    const shared = this.deps.resumeState?.(target);
    if (shared) return shared;
    const last = this.plans.filter(p => same(p.target, target)).at(-1);
    if (!last || last.taskEnded) return { taskId: randomUUID(), count: 0 };
    const task = this.plans.filter(p => same(p.target, target) && p.taskId === last.taskId);
    return { taskId: last.taskId!, count: Math.max(0, ...task.map(p => p.autoResumeCount ?? 0)),
      ...(task.some(p => p.needsReview) ? { needsReview: true } : {}) };
  }
  private requireReview(p: StoredPlan): void {
    p.status = 'skipped'; p.needsReview = true; p.note = AUTO_RESUME_REVIEW_REASON;
    this.deps.review?.({ ...p, target: { ...p.target } });
    this.deps.notice(`${p.target.kind === 'cli' ? p.target.name : p.target.title || '当前对话'}：${AUTO_RESUME_REVIEW_REASON}`);
  }
  private publish(): void { this.deps.changed(this.list()); }
  private commit(): void { this.deps.store.savePlans(this.plans); this.publish(); this.arm(); }
  private clear(): void {
    if (this.timer !== undefined) { if (this.deps.clearTimer) this.deps.clearTimer(this.timer); else clearTimeout(this.timer as ReturnType<typeof setTimeout>); this.timer = undefined; }
  }
  private arm(startup = false): void {
    this.clear();
    if (this.stopped) return;
    const times = this.plans.filter(p => p.status === 'waiting').map(p => p.resumeAt);
    if (!times.length) return;
    const delay = Math.min(2147483647, Math.max(startup ? 1000 : 1, Math.min(...times) - this.now()));
    const fn = () => { this.timer = undefined; void this.tick().catch(e => this.deps.error?.(e)); };
    if (this.deps.setTimer) this.timer = this.deps.setTimer(fn, delay);
    else { const timer = setTimeout(fn, delay); timer.unref(); this.timer = timer; }
  }
}
function same(a: ResumePlan['target'], b: ResumePlan['target']): boolean { return a.kind === b.kind && a.sessionId === b.sessionId; }
function validPlan(p: unknown): p is StoredPlan {
  if (!p || typeof p !== 'object') return false;
  const x = p as StoredPlan;
  return typeof x.id === 'string' && !!x.target && ['cli','chat'].includes(x.target.kind) && typeof x.target.sessionId === 'string' && (x.target.kind === 'cli' ? typeof x.target.name === 'string' : typeof x.target.title === 'string') && Number.isFinite(x.resumeAt) && Number.isFinite(x.detectedAt) && typeof x.reason === 'string' && typeof x.message === 'string' && !!x.message.trim() && ['waiting','done','skipped','cancelled'].includes(x.status) && ['reset_time','retry_after','default'].includes(x.source) && (x.busySince === undefined || Number.isFinite(x.busySince)) && (x.taskId === undefined || typeof x.taskId === 'string') && (x.autoResumeCount === undefined || Number.isSafeInteger(x.autoResumeCount) && x.autoResumeCount >= 0) && (x.needsReview === undefined || typeof x.needsReview === 'boolean') && (x.taskEnded === undefined || typeof x.taskEnded === 'boolean');
}
