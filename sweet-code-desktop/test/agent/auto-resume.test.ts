import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAutoResume, createAutoResumeState, normalizeAutoResumeState } from '../../src/main/agent/auto-resume.ts';

test('a task permits exactly three claims and marks the fourth for review', () => {
  const state = createAutoResumeState('task');
  for (let i = 1; i <= 3; i++) { assert.equal(claimAutoResume(state), true); assert.equal(state.count, i); }
  assert.equal(claimAutoResume(state), false);
  assert.equal(state.count, 3);
  assert.equal(state.needsReview, true);
  assert.equal(claimAutoResume(state), false);
  assert.equal(claimAutoResume(createAutoResumeState('new-task')), true);
});

test('persisted counters retain the limit and invalid records start cleanly', () => {
  const state = normalizeAutoResumeState(JSON.parse('{"taskId":"saved","count":3}'), 'fallback');
  assert.equal(state.taskId, 'saved');
  assert.equal(claimAutoResume(state), false);
  assert.deepEqual(normalizeAutoResumeState({ taskId: 'saved', count: 99 }, 'fallback'), { taskId: 'saved', count: 3 });
  for (const bad of [null, {}, { count: -1 }, { taskId: 't', count: 1.5 }]) {
    assert.deepEqual(normalizeAutoResumeState(bad, 'fallback'), { taskId: 'fallback', count: 0 });
  }
});
