import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initialProgress, parseProgress, redact } from '../../src/main/research/parse.ts';
import { repositoryRecords, repositoryRefs } from '../../src/main/research/repository.ts';
import { buildRunEnv, candidate, candidates, selectModels, KEY_ENV, PROVIDER_MAP } from '../../src/main/research/providers.ts';
import type { ProviderSource } from '../../src/main/research/providers.ts';
import { PRESETS } from '../../src/main/providers/presets.ts';
import { supportedPython } from '../../src/main/research/env.ts';
import { lineSink } from '../../src/main/research/process.ts';
import { presetRepository, presets } from '../../src/main/research/presets.ts';
import { projectHash, runArguments, ResearchService } from '../../src/main/research/runner.ts';
import { Dispatcher } from '../../src/main/dispatch/scheduler.ts';
import type { ResearchRequest } from '../../src/shared/types.ts';

function source(overrides: Record<string, Record<string, string>> = {}, absent: string[] = []): ProviderSource {
  return { exists: id => PRESETS.some(p => p.id === id) && !absent.includes(id), resolve: id => {
    const preset = PRESETS.find(p => p.id === id)!;
    return { preset, baseURL: preset.baseURL, model: preset.defaultModel || 'selected-model', apiKey: 'fixture-key', authMode: 'api_key', ...overrides[id] };
  } };
}
const request: ResearchRequest = { question: '研究问题', agents: [{ providerId: 'moonshot', model: 'model-a' }, { providerId: 'openai', model: 'model-b' }], evidence: { providerId: 'qwen', model: 'model-e' }, maxRounds: 12 };

test('stdout round is zero-based; parsing never mutates previous progress', () => {
  const p = initialProgress(12); const next = parseProgress('-- Round 0 --', p)!;
  assert.equal(next.round, 1); assert.equal(next.maxRounds, 12); assert.equal(p.round, 0);
  assert.equal(parseProgress('-- Round 11 --', next)!.round, 12);
});
test('calling/return/failure maintain a unique calling set without exposing model output', () => {
  let p = initialProgress(12);
  p = parseProgress('  [agent_0] calling openai/model...', p)!;
  p = parseProgress('[agent_0] calling again', p)!;
  p = parseProgress('[agent_1] calling provider/model...', p)!;
  assert.deepEqual(p.calling, ['agent_0', 'agent_1']);
  p = parseProgress('[agent_0] → attack sk-secret claim text', p)!;
  assert.deepEqual(p.calling, ['agent_1']); assert.ok(!JSON.stringify(p).includes('claim text'));
  p = parseProgress('[agent_1] call failed: Bearer short-secret sk-masked... abcdef012345678901234567890', p, 42)!;
  assert.deepEqual(p.calling, []); assert.equal(p.failures[0].at, 42);
  assert.ok(!p.failures[0].message.includes('short-secret')); assert.ok(!p.failures[0].message.includes('sk-masked'));
  assert.ok(!p.failures[0].message.includes('abcdef012345678901234567890'));
});
test('counts and termination recognized; arbitrary stdout discarded', () => {
  const p = parseProgress('  Claims:2 Chains:3 Attacks:4', initialProgress(3))!;
  assert.deepEqual([p.claims, p.chains, p.attacks], [2, 3, 4]);
  assert.equal(parseProgress('TERMINATED: SECRET RAW TEXT', p)!.activity, '研究已达到终止条件');
  for (const line of ['Q: question', '[Evidence] model answer', 'Saved: file', '-- Round nope --', 'Claims:x Chains:1 Attacks:2']) assert.equal(parseProgress(line, p), null);
});
test('redacts actual short keys, key labels, partial keys, tokens, control characters', () => {
  const r = redact('abc-short token=secret api_key="hidden" sk-ab***cd Bearer abc\x00', ['abc-short']);
  for (const secret of ['abc-short', 'secret', 'hidden', 'sk-ab', '\x00']) assert.ok(!r.includes(secret));
  assert.ok(r.includes('[已隐藏]')); assert.ok(redact('x'.repeat(10000)).length <= 1000);
});
test('failure history is bounded', () => {
  let p = initialProgress(1);
  for (let i = 0; i < 110; i++) p = parseProgress('[agent_0] call failed: failure', p, i)!;
  assert.equal(p.failures.length, 100); assert.equal(p.failures[0].at, 10);
});
test('repository wrapper precedence matches CLI; empty first array wins', () => {
  for (const k of ['items', 'evidence', 'ccma_repository_items', 'repository_items', 'claims']) assert.deepEqual(repositoryRefs({ [k]: [{ ref: k }] }), [k]);
  assert.deepEqual(repositoryRecords({ items: [], evidence: [{ ref: 'not-selected' }] }), []);
  assert.deepEqual(repositoryRefs({ ref: 'one', title: 'single' }), ['one']);
  assert.deepEqual(repositoryRefs({ title: 'no ref' }), ['']);
});
test('claim refs are 1-based, preserve record order and duplicates; empty claims are ordinary', () => {
  assert.deepEqual(repositoryRefs([{ ref: 'paper', claims: [{}, {}] }, { ref: 'second', claims: [] }, { ref: 'paper', claims: [{}] }]), ['paper/claim_1', 'paper/claim_2', 'second', 'paper/claim_1']);
  // Random Python-generated refs cannot be inferred and must not be fabricated.
  assert.deepEqual(repositoryRefs([{ claims: [{}] }]), []);
});
test('invalid repositories and claim records fail before spawning', () => {
  for (const data of [null, 'bad', {}, { nope: [] }, [null], ['record'], [{ claims: ['bad'] }]]) assert.throws(() => repositoryRefs(data));
});
test('all nine official provider mappings use current selected model', () => {
  const list = candidates(source()); assert.equal(list.length, 9);
  for (const [id, cc] of Object.entries(PROVIDER_MAP)) { assert.equal(candidate(source(), id)?.cc, cc); assert.equal(candidate(source(), id)?.model, source().resolve(id).model); }
  assert.equal(candidate(source(), 'custom'), null); assert.equal(candidate(source(), 'gemini'), null);
});
test('login, deleted providers and relays are excluded; keyless providers not ready', () => {
  assert.equal(candidate(source({ anthropic: { authMode: 'login' } }), 'anthropic'), null);
  assert.equal(candidate(source({ openai: { baseURL: 'https://relay.example/v1' } }), 'openai'), null);
  assert.equal(candidate(source({}, ['deepseek']), 'deepseek'), null);
  assert.equal(candidate(source({ qwen: { apiKey: '' } }), 'qwen')?.ready, false);
});
test('preflight validates every agent and evidence key, mapping and model syntax', () => {
  assert.equal(selectModels(source(), request).agents[0].cc, 'kimi');
  assert.throws(() => selectModels(source({ qwen: { apiKey: '' } }), request), /API Key/);
  assert.throws(() => selectModels(source({ moonshot: { apiKey: '' } }), request), /API Key/);
  assert.throws(() => selectModels(source(), { ...request, evidence: { providerId: 'custom', model: 'm' } }));
  assert.throws(() => selectModels(source(), { ...request, agents: [{ providerId: 'openai', model: 'a,qwen:b' }] }));
  assert.throws(() => selectModels(source(), { ...request, maxRounds: 0 }));
});
test('run env includes only selected CC keys, preserves order and isolates home/UTF8', () => {
  const selected = selectModels(source(), request);
  const env = buildRunEnv({ PATH: '/bin', Path: 'windows-path', SystemRoot: 'C:\\Windows', USERPROFILE: 'old', HOME: 'old', UNUSED_API_KEY: 'secret', OPENAI_API_KEY: 'old', OPENAI_BASE_URL: 'relay', ANTHROPIC_BASE_URL: 'relay', PYTHONPATH: 'inject', NODE_OPTIONS: 'inject', CHAIN_CENTRIC_SCENARIO: 'deep' }, '/run', selected.agents, selected.evidence);
  assert.equal(env.CHAIN_CENTRIC_AGENTS, 'kimi:model-a,openai:model-b'); assert.equal(env.CHAIN_CENTRIC_EVIDENCE_LLM, 'qwen:model-e');
  assert.equal(env.HOME, '/run'); assert.equal(env.USERPROFILE, '/run');
  assert.equal(env.PYTHONUTF8, '1'); assert.equal(env.PYTHONUNBUFFERED, '1'); assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PATH, '/bin'); assert.equal(env.SystemRoot, 'C:\\Windows');
  for (const k of ['UNUSED_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'PYTHONPATH', 'NODE_OPTIONS', 'CHAIN_CENTRIC_SCENARIO', 'ANTHROPIC_API_KEY', 'DASHSCOPE_API_KEY']) assert.equal(env[k], undefined);
  assert.deepEqual(Object.keys(env).filter(k => k.endsWith('_API_KEY')).sort(), ['KIMI_API_KEY', 'OPENAI_API_KEY', 'QWEN_API_KEY']);
});
test('all CC key names agree with config.py', async () => {
  const config = await fs.readFile('resources/chain-centric/chain_centric/config.py', 'utf8');
  for (const [cc, name] of Object.entries(KEY_ENV)) assert.ok(config.includes(`"${cc}":"${name}"`));
});
test('python versions require >=3.10', () => {
  assert.equal(supportedPython('Python 3.9.9'), null); assert.equal(supportedPython('Python 3.10.0'), '3.10.0'); assert.equal(supportedPython('Python 3.14.1'), '3.14.1'); assert.equal(supportedPython('not Python'), null);
});
test('line framing handles split UTF8 and CRLF and discards oversized output', () => {
  const lines: string[] = []; const sink = lineSink(l => lines.push(l), 50);
  const data = Buffer.from('[agent_0] → pass\r\n中文\nlast');
  for (const byte of data) sink.write(Buffer.from([byte])); sink.end();
  assert.deepEqual(lines, ['[agent_0] → pass', '中文', 'last']);
  const bounded: string[] = []; const s = lineSink(l => bounded.push(l), 5);
  s.write(Buffer.from('123456')); s.write(Buffer.from('789\nok\nend')); s.end(); assert.deepEqual(bounded, ['ok', 'end']);
});
test('command has unbuffered module entry, explicit rounds/output and no checkpoint', () => {
  const args = runArguments(request, '/run', '/evidence file.json');
  assert.deepEqual(args, ['-u', '-m', 'chain_centric.cli', 'run', '-q', '研究问题', '--max-rounds', '12', '-o', path.join('/run', 'result.json'), '-r', '/evidence file.json']);
  assert.ok(!runArguments(request, '/run').includes('-r')); assert.ok(!args.includes('--checkpoint'));
  assert.equal(projectHash('/a').length, 16); assert.equal(projectHash('/a/../a'), projectHash('/a')); assert.notEqual(projectHash('/a'), projectHash('/b'));
});
test('bundled presets are readable and records count is top-level, not expanded claims', async () => {
  const sourcePath = path.resolve('resources/chain-centric'); const list = await presets(sourcePath); assert.ok(list.length > 0);
  for (const p of list) {
    assert.ok(p.title && p.question); assert.equal(p.language, /[\u3400-\u9fff]/.test(p.question) ? 'zh' : 'en');
    try { const data = JSON.parse(await fs.readFile(presetRepository(sourcePath, p.id), 'utf8')); assert.equal(p.records, repositoryRecords(data).length); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; assert.equal(p.records, 0); }
  }
  assert.throws(() => presetRepository(sourcePath, '../../escape'));
});
test('restart recovers interrupted runs; list/result/delete stay project scoped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-')); const dispatcher = new Dispatcher({ emit: () => {} });
  try {
    const project = '/project'; const id = '00000000-0000-4000-8000-000000000001'; const runDir = path.join(dir, 'deep-research', projectHash(project), id);
    await fs.mkdir(runDir, { recursive: true }); await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ id, createdAt: 1, status: 'running', request, agents: [], hasResult: false }));
    const service = new ResearchService(path.resolve('resources/chain-centric'), dir, dispatcher, source(), () => {});
    await service.init(); const runs = await service.list(project); assert.equal(runs[0].status, 'failed'); assert.equal(runs[0].error, '应用关闭时还没跑完');
    assert.deepEqual(await service.list('/other'), []); assert.equal(await service.result(project, id), null);
    await fs.writeFile(path.join(runDir, 'result.json'), '{broken'); assert.equal(await service.result(project, id), null);
    await assert.rejects(service.delete('/other', id)); await service.delete(project, id); assert.deepEqual(await service.list(project), []);
  } finally { dispatcher.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('queued research cancellation goes through dispatcher; running deletion refused; project switch does not retarget records', async () => {
  const { SessionExecutor } = await import('../../src/main/dispatch/session.ts');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-queue-'));
  const dispatcher = new Dispatcher({ emit: () => {}, maxRunning: 1 });
  const blocker = dispatcher.submit({ executor: new SessionExecutor('blocker', 'blocker', async (_job, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return null;
  }), input: 'block', origin: 'user', from: 'test' });
  try {
    const service = new ResearchService(path.resolve('resources/chain-centric'), dir, dispatcher, source(), () => {});
    service.environment.env = async () => ({ python: { found: true }, installed: true, installing: false, packageVersion: 'test' });
    const run = await service.start('/first', request); assert.equal(run.status, 'preparing'); assert.ok(run.jobId);
    await assert.rejects(service.delete('/first', run.id), /先取消/);
    assert.deepEqual(await service.list('/second'), []);
    await service.cancel(run.id);
    for (let i = 0; i < 50 && (await service.list('/first'))[0].status !== 'cancelled'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((await service.list('/first'))[0].status, 'cancelled');
    await service.delete('/first', run.id);
  } finally { dispatcher.close(); if (!('error' in blocker)) await blocker.done; await fs.rm(dir, { recursive: true, force: true }); }
});

test('process helper invokes Node only, parses bounded lines and aborts detached process', async () => {
  const { runProcess } = await import('../../src/main/research/process.ts');
  const lines: string[] = [];
  const completed = await runProcess(process.execPath, ['-e', 'console.log("-- Round 0 --"); console.error("Bearer fixture-secret");'], { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, onLine: l => lines.push(l) });
  assert.equal(completed.code, 0); assert.deepEqual(lines, ['-- Round 0 --']); assert.ok(!completed.tail.join('').includes('fixture-secret'));
  const controller = new AbortController();
  const stopped = runProcess(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, signal: controller.signal, onLine: () => controller.abort('cancelled') });
  assert.notEqual((await stopped).code, 0);
  await assert.rejects(runProcess('/nonexistent-research-python', [], { cwd: os.tmpdir(), env: {} }), /没能启动/);
});
