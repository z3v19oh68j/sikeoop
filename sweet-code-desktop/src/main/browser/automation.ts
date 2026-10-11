import { runBrowserBatch } from './batch.ts';
import type { BrowserAutomationState } from '../../shared/types.ts';

/** A paused step stays pending. No replay of already dispatched events. */
export class BrowserAutomation {
  private value: BrowserAutomationState = { status: 'done', step: 0, total: 0, description: '', reason: null };
  private active = false;
  private stopped = false;
  private signal?: AbortSignal;
  private cancellation = new AbortController();
  actionSignal(): AbortSignal | undefined { return this.active ? this.cancellation.signal : undefined; }
  private waiters = new Set<() => void>();
  private notify: (state: BrowserAutomationState) => void;
  constructor(notify: (state: BrowserAutomationState) => void) { this.notify = notify; }
  state(): BrowserAutomationState { return { ...this.value }; }
  private publish(change: Partial<BrowserAutomationState>): void { Object.assign(this.value, change); this.notify(this.state()); }
  private wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  userInput(): void { if (this.active && (this.value.status === 'running' || this.value.pauseReason === 'approval')) this.pause('user', '你接手了页面'); }
  pause(pauseReason: NonNullable<BrowserAutomationState['pauseReason']> = 'manual', reason = '用户暂停了浏览器自动化'): BrowserAutomationState {
    if (this.active && (this.value.status === 'running' || this.value.status === 'paused' && this.value.pauseReason === 'approval' && pauseReason !== 'approval')) this.publish({ status: 'paused', reason, pauseReason });
    return this.state();
  }
  async approval<T>(request: () => Promise<T>): Promise<T> {
    await this.checkpoint();
    this.pause('approval', '等待用户审批');
    try { return await request(); }
    finally { if (this.value.pauseReason === 'approval') this.resume(); }
  }
  resume(): BrowserAutomationState { if (this.active && !this.stopped && this.value.status === 'paused') { this.publish({ status: 'running', reason: null, pauseReason: undefined }); this.wake(); } return this.state(); }
  stop(): BrowserAutomationState { if (this.active) { this.stopped = true; this.cancellation.abort(); this.publish({ status: 'error', reason: 'Browser automation stopped.' }); this.wake(); } return this.state(); }
  async checkpoint(): Promise<void> {
    if (!this.active) return;
    while (this.value.status === 'paused' && !this.stopped && !this.signal?.aborted) await new Promise<void>(resolve => this.waiters.add(resolve));
    if (this.stopped || this.signal?.aborted) throw new Error(this.signal?.aborted ? 'Browser action cancelled.' : 'Browser automation stopped.');
  }
  async run<T>(actions: readonly T[], describe: (action: T) => string, execute: (action: T, index: number) => Promise<void>, signal?: AbortSignal) {
    if (this.active) throw new Error('Browser automation is already running or paused.');
    this.active = true; this.stopped = false; this.signal = signal; this.cancellation = new AbortController();
    const abort = () => { this.stopped = true; this.cancellation.abort(); this.publish({ status: 'error', reason: 'Browser action cancelled.' }); this.wake(); };
    signal?.addEventListener('abort', abort, { once: true });
    this.publish({ status: 'running', step: 0, total: actions.length, description: '', reason: null, pauseReason: undefined });
    try {
      const result = await runBrowserBatch(actions, async (action, index) => {
        await this.checkpoint();
        this.publish({ step: index + 1, description: describe(action) });
        await execute(action, index);
        await this.checkpoint();
      }, signal);
      if (this.stopped && result.failedStep !== null) result.reason = this.signal?.aborted ? 'Browser action cancelled.' : 'Browser automation stopped.';
      this.publish({ status: result.failedStep === null ? 'done' : 'error', reason: result.reason, pauseReason: result.failedStep === null ? undefined : 'error' });
      return result;
    } finally { signal?.removeEventListener('abort', abort); this.active = false; this.signal = undefined; this.wake(); }
  }
}
