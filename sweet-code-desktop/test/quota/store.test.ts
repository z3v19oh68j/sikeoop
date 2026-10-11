import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quotaStore } from '../../src/main/quota/store.ts';
import { DEFAULT_SETTINGS, QuotaService } from '../../src/main/quota/service.ts';
test('atomic disk settings/plans persist and reload; no temporary files remain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
  try {
    const dir = path.join(root, 'quota');
    const store = quotaStore(dir);
    assert.deepEqual(store.load(), { settings: undefined, plans: undefined });
    const service = new QuotaService({ store, now: () => 1000, state: () => 'idle', execute: () => {}, changed: () => {}, notice: () => {}, setTimer: () => ({}), clearTimer: () => {} });
    service.start(); service.detect({ kind: 'cli', sessionId: 'test', name: 'Codex' }, 'HTTP 429');
    assert.deepEqual(store.load().settings, DEFAULT_SETTINGS);
    assert.deepEqual(store.load().plans, service.list());
    const plans = service.list(); plans[0].status = 'cancelled'; store.savePlans(plans);
    assert.deepEqual(quotaStore(dir).load().plans, plans);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['plans.json', 'settings.json']);
    assert.equal(fs.statSync(path.join(dir, 'plans.json')).mode & 0o777, 0o600);
    service.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disk restart retains quota budget and persisted takeover creates a new task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-budget-'));
  const store = quotaStore(root);
  const target = { kind: 'cli' as const, sessionId: 'disk-cli', name: 'Claude' };
  let ran = 0;
  const create = () => new QuotaService({ store, now: () => 1000, state: () => 'idle', execute: () => { ran++; },
    changed: () => {}, notice: () => {}, setTimer: () => ({}), clearTimer: () => {} });
  try {
    for (let i = 0; i < 3; i++) {
      const service = create(); service.start(); service.detect(target, 'HTTP 429');
      await service.resumeNow(service.list().at(-1)!.id); service.stop();
    }
    assert.equal(ran, 3);
    const stopped = create(); stopped.start(); stopped.detect(target, 'HTTP 429');
    assert.equal(stopped.list().at(-1)!.needsReview, true);
    await stopped.resumeNow(stopped.list().at(-1)!.id);
    assert.equal(ran, 3);
    stopped.takeover(target); stopped.stop();
    const newTask = create(); newTask.start(); newTask.detect(target, 'HTTP 429');
    await newTask.resumeNow(newTask.list().at(-1)!.id);
    assert.equal(ran, 4); assert.equal(newTask.list().at(-1)!.autoResumeCount, 1); newTask.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
