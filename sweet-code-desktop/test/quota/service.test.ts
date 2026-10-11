import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResumePlan } from '../../src/shared/types.ts';
import { QuotaService, validateSettings } from '../../src/main/quota/service.ts';
const cli: ResumePlan['target'] = { kind: 'cli', sessionId: 'terminal1', name: 'Claude' };
const chat: ResumePlan['target'] = { kind: 'chat', sessionId: 'chat1', title: 'Chat' };
function harness(initial: { settings?: unknown; plans?: unknown } = {}) {
  let now = Date.parse('2026-10-11T08:00:00Z');
  let state: 'idle' | 'busy' | 'gone' = 'idle';
  let persisted: ResumePlan[] = [];
  let savedSettings: unknown;
  let fail = false;
  const timers: { fn: () => void; delay: number }[] = [];
  const executed: ResumePlan[] = [], notices: string[] = [], pushes: ResumePlan[][] = [];
  const service = new QuotaService({
    store: { load: () => initial, saveSettings: s => { savedSettings = structuredClone(s); }, savePlans: p => { persisted = structuredClone(p); } },
    now: () => now,
    state: () => state,
    execute: p => { if (fail) throw new Error('dispatch rejected'); executed.push(p); },
    changed: p => pushes.push(p), notice: s => notices.push(s),
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimer: () => {},
  });
  service.start();
  return { service, executed, notices, pushes, timers, advance: (ms: number) => { now += ms; }, state: (s: typeof state) => { state = s; }, fail: () => { fail = true; }, persisted: () => persisted, settings: () => savedSettings };
}
test('deduplication updates same waiting plan, fallback and reset padding, cloned views', () => {
  const h = harness(); h.service.detect(cli, 'weekly limit reached');
  const first = h.service.list()[0];
  assert.equal(first.resumeAt - first.detectedAt, 5 * 3600000);
  h.advance(1000); h.service.detect(cli, "You've hit your usage limit try again in 1 hour");
  assert.equal(h.service.list().length, 1);
  assert.equal(h.service.list()[0].id, first.id);
  assert.equal(h.service.list()[0].resumeAt - h.service.list()[0].detectedAt, 3660000);
  first.target.sessionId = 'corrupted'; assert.equal(h.service.list()[0].target.sessionId, 'terminal1');
  assert.equal(h.persisted().length, 1); assert.ok(h.notices[0].includes('已安排')); assert.ok(h.pushes.length >= 3);
});
test('takeover is target-specific and prevents both timed and manual execution', async () => {
  const h = harness(); h.service.detect(cli, 'weekly limit reached'); h.service.detect(chat, 'HTTP 429');
  h.service.takeover(cli);
  assert.equal(h.service.list()[0].note, '你已经接手了');
  assert.equal(h.service.list()[1].status, 'waiting');
  await h.service.resumeNow(h.service.list()[0].id); assert.equal(h.executed.length, 0);
  h.advance(5 * 3600000); await h.service.tick();
  assert.equal(h.executed.length, 1); assert.equal(h.executed[0].target.kind, 'chat');
});
test('due idle cli and chat execute once; completed targets may get a new plan', async () => {
  for (const target of [cli, chat]) {
    const h = harness(); h.service.detect(target, 'HTTP 429');
    h.advance(5 * 3600000 - 1); await h.service.tick(); assert.equal(h.executed.length, 0);
    h.advance(1); await h.service.tick(); await h.service.tick();
    assert.equal(h.executed.length, 1); assert.equal(h.service.list()[0].status, 'done');
    assert.equal(h.executed[0].message, '继续');
    h.service.detect(target, 'HTTP 429'); assert.equal(h.service.list().length, 2);
  }
});
test('gone targets, busy chat, execution rejection, cancellation and manual resume', async () => {
  for (const target of [cli, chat]) {
    const h = harness(); h.service.detect(target, 'HTTP 429'); h.state('gone');
    await h.service.resumeNow(h.service.list()[0].id); assert.equal(h.service.list()[0].note, '会话已关闭');
  }
  const busy = harness(); busy.service.detect(chat, 'HTTP 429'); busy.state('busy'); await busy.service.resumeNow(busy.service.list()[0].id); assert.equal(busy.service.list()[0].status, 'skipped');
  const bad = harness(); bad.service.detect(cli, 'HTTP 429'); bad.fail(); await bad.service.resumeNow(bad.service.list()[0].id); assert.match(bad.service.list()[0].note!, /dispatch rejected/);
  const cancel = harness(); cancel.service.detect(cli, 'HTTP 429'); cancel.service.cancel(cancel.service.list()[0].id); cancel.advance(6 * 3600000); await cancel.service.tick(); assert.equal(cancel.executed.length, 0);
  const immediate = harness(); immediate.service.detect(cli, 'HTTP 429'); await immediate.service.resumeNow(immediate.service.list()[0].id); assert.equal(immediate.executed.length, 1);
});
test('busy CLI retries every five minutes for one hour, can execute after becoming idle', async () => {
  const h = harness(); h.service.detect(cli, 'HTTP 429'); h.state('busy'); h.advance(5 * 3600000); await h.service.tick();
  for (let i = 0; i < 12; i++) {
    assert.equal(h.service.list()[0].status, 'waiting');
    assert.equal(h.timers.at(-1)?.delay, 300000);
    h.advance(300000); await h.service.tick();
  }
  assert.equal(h.service.list()[0].status, 'skipped'); assert.equal(h.executed.length, 0);
  const ready = harness(); ready.service.detect(cli, 'HTTP 429'); ready.state('busy'); ready.advance(5 * 3600000); await ready.service.tick(); ready.state('idle'); ready.advance(300000); await ready.service.tick(); assert.equal(ready.executed.length, 1);
});
test('restores expired plans within a minute, persists busy retry horizon, shutdown prevents sends', async () => {
  const h = harness(); h.service.detect(cli, 'HTTP 429');
  const plan = h.persisted()[0]; plan.resumeAt = plan.detectedAt - 1000;
  const restored = harness({ plans: [plan, {}, null] });
  assert.ok(restored.timers.at(-1)!.delay <= 60000);
  await restored.service.tick(); assert.equal(restored.executed.length, 1);
  const stopped = harness({ plans: [plan] }); stopped.service.stop(); await stopped.service.tick(); assert.equal(stopped.executed.length, 0);
  const busy = harness({ plans: [{ ...plan, busySince: plan.detectedAt - 3600000 }] }); busy.state('busy'); await busy.service.tick(); assert.equal(busy.service.list()[0].status, 'skipped');
});
test('settings validate and disabling automation cancels waiting plans', () => {
  const h = harness();
  for (const value of [null, {}, { autoResume: true, defaultDelayHours: 0, message: '继续' }, { autoResume: true, defaultDelayHours: 25, message: '继续' }, { autoResume: true, defaultDelayHours: 5, message: ' ' }, { autoResume: true, defaultDelayHours: 5, message: 'a'.repeat(201) }]) assert.throws(() => validateSettings(value));
  h.service.detect(cli, 'HTTP 429'); h.service.setSettings({ autoResume: false, defaultDelayHours: 2, message: 'continue' });
  assert.equal(h.service.list()[0].status, 'cancelled'); h.service.detect(chat, 'HTTP 429'); assert.equal(h.service.list().length, 1);
  assert.deepEqual(h.settings(), { autoResume: false, defaultDelayHours: 2, message: 'continue' });
});
test('settings message changes apply to outstanding plans and concurrent ticks do not duplicate', async () => {
  const h = harness(); h.service.detect(cli, 'HTTP 429');
  h.service.setSettings({ autoResume: true, defaultDelayHours: 5, message: '接着写' });
  h.advance(5 * 3600000); await Promise.all([h.service.tick(), h.service.tick()]);
  assert.equal(h.executed.length, 1); assert.equal(h.executed[0].message, '接着写');
});
test('takeover cancels a submitted job still waiting for dispatch/preflight', async () => {
  let queued: string | undefined;
  const service = new QuotaService({
    store: { load: () => ({}), saveSettings: () => {}, savePlans: () => {} },
    now: () => 1000, state: () => 'idle', execute: p => { queued = p.id; },
    cancelPending: () => { const ids = queued ? [queued] : []; queued = undefined; return ids; },
    changed: () => {}, notice: () => {}, setTimer: () => ({}), clearTimer: () => {},
  });
  service.start(); service.detect(cli, 'HTTP 429');
  const id = service.list()[0].id;
  await service.resumeNow(id); assert.equal(service.list()[0].status, 'done');
  service.takeover(cli);
  assert.equal(queued, undefined); assert.equal(service.list()[0].status, 'skipped');
  assert.equal(service.list()[0].note, '你已经接手了');
  service.stop();
});

test('quota continuation stops after three claims, survives restart, human takeover starts a new task', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.service.detect(cli, 'HTTP 429');
    await h.service.resumeNow(h.service.list().at(-1)!.id);
  }
  assert.equal(h.executed.length, 3);
  assert.equal(h.service.list().at(-1)!.autoResumeCount, 3);
  const restored = harness({ plans: h.persisted() });
  restored.service.detect(cli, 'HTTP 429');
  const refused = restored.service.list().at(-1)!;
  assert.equal(refused.status, 'skipped');
  assert.equal(refused.needsReview, true);
  assert.match(refused.note!, /需人工查看/);
  await restored.service.resumeNow(refused.id);
  assert.equal(restored.executed.length, 0);
  restored.service.detect(cli, 'HTTP 429');
  assert.equal(restored.service.list().length, 4, 'repeated quota output does not duplicate review plans');
  restored.service.takeover(cli);
  const afterTakeover = harness({ plans: restored.persisted() });
  afterTakeover.service.detect(cli, 'HTTP 429');
  const next = afterTakeover.service.list().at(-1)!;
  assert.notEqual(next.taskId, refused.taskId);
  await afterTakeover.service.resumeNow(next.id);
  assert.equal(afterTakeover.executed.length, 1);
  assert.equal(afterTakeover.executed[0].autoResumeCount, 1);
});

test('quota and AgentSession spend one shared continuation budget, including between detection and dispatch', async () => {
  const state = { taskId: 'main-task', count: 2, needsReview: false };
  const executions: ResumePlan[] = [], reviews: ResumePlan[] = [];
  const service = new QuotaService({
    store: { load: () => ({}), saveSettings: () => {}, savePlans: () => {} },
    now: () => 1000, state: () => 'idle', execute: p => { executions.push(p); },
    resumeState: () => ({ ...state }),
    claimResume: () => { if (state.count >= 3) { state.needsReview = true; return false; } state.count++; return true; },
    review: p => { reviews.push(p); }, changed: () => {}, notice: () => {},
    setTimer: () => ({}), clearTimer: () => {},
  });
  service.start(); service.detect(chat, 'HTTP 429');
  await service.resumeNow(service.list()[0].id);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].autoResumeCount, 3);
  service.detect(chat, 'HTTP 429');
  assert.equal(reviews.length, 1);
  assert.equal(service.list().at(-1)!.needsReview, true);
  assert.equal(executions.length, 1);
  service.stop();

  const raced = { taskId: 'raced', count: 2 };
  let ran = false, reviewed = false;
  const pending = new QuotaService({
    store: { load: () => ({}), saveSettings: () => {}, savePlans: () => {} },
    now: () => 1000, state: () => 'idle', execute: () => { ran = true; },
    resumeState: () => ({ ...raced }), claimResume: () => false,
    review: () => { reviewed = true; }, changed: () => {}, notice: () => {},
    setTimer: () => ({}), clearTimer: () => {},
  });
  pending.start(); pending.detect(chat, 'HTTP 429'); raced.count = 3;
  await pending.resumeNow(pending.list()[0].id);
  assert.equal(ran, false); assert.equal(reviewed, true); pending.stop();
});

test('legacy completed claims count towards the cap and stale tasks cannot resume', async () => {
  const h = harness();
  h.service.detect(cli, 'HTTP 429');
  const legacy = h.service.list()[0];
  delete legacy.taskId; delete legacy.autoResumeCount;
  const restored = harness({ plans: [0, 1, 2].map(i => ({ ...legacy, id: `legacy-${i}`, status: 'done' })) });
  restored.service.detect(cli, 'HTTP 429');
  assert.equal(restored.service.list().at(-1)!.needsReview, true);
  assert.equal(restored.executed.length, 0);
});

test('async shared claim is saved before execution and human takeover during save cancels send', async () => {
  const state = { taskId: 'async-task', count: 0 };
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const saved = new Promise<void>(resolve => { release = resolve; });
  let executed = false;
  const service = new QuotaService({
    store: { load: () => ({}), saveSettings: () => {}, savePlans: () => {} },
    now: () => 1000, state: () => 'idle', execute: () => { executed = true; },
    resumeState: () => ({ ...state }),
    claimResume: async () => { state.count++; started(); await saved; return true; },
    changed: () => {}, notice: () => {}, setTimer: () => ({}), clearTimer: () => {},
  });
  service.start(); service.detect(chat, 'HTTP 429');
  const run = service.resumeNow(service.list()[0].id);
  await entered;
  assert.equal(executed, false);
  service.takeover(chat);
  release(); await run;
  assert.equal(executed, false);
  assert.equal(service.list()[0].status, 'skipped');
  service.stop();
});

test('failed shared budget persistence stops instead of a tight automatic retry loop', async () => {
  let executed = false, review = false;
  const service = new QuotaService({
    store: { load: () => ({}), saveSettings: () => {}, savePlans: () => {} },
    now: () => 1000, state: () => 'idle', execute: () => { executed = true; },
    resumeState: () => ({ taskId: 'save-failed', count: 1 }),
    claimResume: async () => { throw new Error('disk full'); },
    review: () => { review = true; }, changed: () => {}, notice: () => {}, setTimer: () => ({}), clearTimer: () => {},
  });
  service.start(); service.detect(chat, 'HTTP 429');
  await service.resumeNow(service.list()[0].id);
  await service.tick();
  assert.equal(executed, false); assert.equal(review, true);
  assert.equal(service.list()[0].status, 'skipped');
  assert.match(service.list()[0].note!, /预算保存失败.*需人工查看.*disk full/);
  service.stop();
});
