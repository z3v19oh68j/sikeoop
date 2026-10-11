import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLimit } from '../../src/main/quota/detect.ts';
const now = Date.parse('2026-10-11T08:00:00Z');
test('unix seconds, milliseconds and explicit limit without reset', () => {
  assert.equal(detectLimit('Claude AI usage limit reached|1791748800', now)?.resumeAt, 1791748800000);
  assert.equal(detectLimit('Claude AI usage limit reached|1791748800000', now)?.resumeAt, 1791748800000);
  assert.deepEqual(detectLimit('weekly limit reached', now), { reason: 'weekly limit reached', source: 'default' });
});
test('named timezone, next day, weekly rollover, ISO reset', () => {
  assert.equal(detectLimit("You've hit your limit · resets 7pm (Asia/Shanghai)", now)?.resumeAt, Date.parse('2026-10-11T11:00:00Z'));
  assert.equal(detectLimit('5-hour limit reached ∙ resets 3pm (Asia/Shanghai)', now)?.resumeAt, Date.parse('2026-10-12T07:00:00Z'));
  assert.equal(detectLimit('weekly limit reached … resets Mon 9am (Asia/Shanghai)', now)?.resumeAt, Date.parse('2026-10-12T01:00:00Z'));
  const monday = Date.parse('2026-10-12T02:00:00Z');
  assert.equal(detectLimit('weekly limit reached resets Mon 9am (Asia/Shanghai)', monday)?.resumeAt, Date.parse('2026-10-19T01:00:00Z'));
  assert.equal(detectLimit('usage limit reached reset at 2026-10-12T10:00:00Z', now)?.resumeAt, Date.parse('2026-10-12T10:00:00Z'));
});
test('local timezone clock and Codex durations', () => {
  const localNow = new Date(2026, 9, 11, 16).getTime();
  assert.equal(detectLimit('5-hour limit reached ∙ resets 3pm', localNow)?.resumeAt, new Date(2026, 9, 12, 15).getTime());
  assert.equal(detectLimit("You've hit your usage limit. try again at 3:41 PM", localNow)?.resumeAt, new Date(2026, 9, 12, 15, 41).getTime());
  assert.equal(detectLimit("You've hit your usage limit … try again in 4 hours 12 minutes", now)?.resumeAt, now + 15120000);
  assert.equal(detectLimit("You've hit your usage limit try again in 12 minutes", now)?.resumeAt, now + 720000);
});
test('API statuses, quota error and retry/reset headers', () => {
  assert.equal(detectLimit({ status: 429, message: 'error', headers: { 'Retry-After': '60' } }, now)?.resumeAt, now + 60000);
  assert.equal(detectLimit({ status: 402, headers: new Headers({ 'retry-after': 'Sun, 11 Oct 2026 10:00:00 GMT' }) }, now)?.source, 'retry_after');
  assert.equal(detectLimit({ status: 429, headers: { 'anthropic-ratelimit-tokens-reset': '2026-10-11T12:00:00Z' } }, now)?.resumeAt, Date.parse('2026-10-11T12:00:00Z'));
  for (const text of ['HTTP 429', '402 Payment Required', 'insufficient balance', 'quota exceeded', 'rate limit exceeded', '额度用完了']) assert.ok(detectLimit(text, now), text);
  assert.equal(detectLimit({ status: 429, headers: { 'retry-after': 'invalid' } }, now)?.source, 'default');
});
test('negative examples: ordinary code discussion does not trigger', () => {
  for (const text of ['Set limit = 5 in this code', 'SQL LIMIT 10', 'We should add a rate limiter', 'Discuss the usage limit configuration', 'quotaSettings() returns settings', 'balance is sufficient', 'The HTTP status is 200', 'try again at 3pm', 'array limit reached', 'The API supports rate limit headers']) assert.equal(detectLimit(text, now), null, text);
  assert.equal(detectLimit('usage limit reached resets 99pm (Invalid/Zone)', now)?.resumeAt, undefined);
});
test('weekly full weekday and usage-reset variants; generic SDK quota error', () => {
  assert.equal(detectLimit('weekly limit reached resets Wednesday 9am (Asia/Shanghai)', now)?.resumeAt, Date.parse('2026-10-14T01:00:00Z'));
  assert.equal(detectLimit('usage limit … reset at 7pm (Asia/Shanghai)', now)?.resumeAt, Date.parse('2026-10-11T11:00:00Z'));
  assert.ok(detectLimit({ message: 'quota unavailable' }, now));
});
test('named timezone with daylight saving uses the reset date offset', () => {
  const before = Date.parse('2026-11-01T04:00:00Z');
  assert.equal(detectLimit("You've hit your limit resets 3am (America/New_York)", before)?.resumeAt, Date.parse('2026-11-01T08:00:00Z'));
});
