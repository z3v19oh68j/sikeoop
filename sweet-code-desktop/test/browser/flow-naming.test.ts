import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { BrowserFlowStore } from '../../src/main/browser/flows.ts';
import { BrowserFlowRecording } from '../../src/main/browser/recording.ts';
import { CdpSession } from '../../src/main/browser/cdp/session.ts';
import { setRoot } from '../../src/main/workspace.ts';
import type { SweetApi } from '../../src/shared/types.ts';

// Replace only Electron's host boundary. Node strips the actual service/preload TypeScript;
// real stores, recorder lifecycle and filesystem are exercised without launching an app.
const electronUrl = `data:text/javascript,${encodeURIComponent(`
  export const safeStorage = {};
  export const session = {};
  export const calls = [];
  export let api;
  export const ipcRenderer = { invoke: async (...args) => { calls.push(args); } };
  export const contextBridge = { exposeInMainWorld: (_name, value) => { api = value; } };
`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron' ? { url: electronUrl, shortCircuit: true } : nextResolve(specifier, context);
  },
});
const { BrowserService } = await import('../../src/main/browser/service.ts');
await import('../../src/preload/index.ts');
const electron = await import(electronUrl) as { api: SweetApi; calls: unknown[][] };
hook.deregister();

class FakeDebugger extends EventEmitter {
  attached = false;
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; this.emit('detach'); }
  async sendCommand(method: string) {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'recording-script' };
    return {};
  }
}
async function project(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flow-naming-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new BrowserFlowStore(() => root), dir: path.join(root, '.sikeoop', 'browser-flows') };
}
async function service(t: { after: (fn: () => Promise<void>) => void }) {
  const p = await project(t);
  await setRoot(p.root);
  const browser = new BrowserService(p.root, () => {});
  const cdp = new CdpSession(new FakeDebugger());
  // Skip only the real webview acquisition; flow methods still run the real CdpRecorder.
  Object.assign(browser, { cdp, page: async () => {}, current: () => ({ url: 'http://localhost/form' }) });
  t.after(async () => {
    (browser as any).cancelRecording();
    cdp.dispose();
  });
  return { ...p, browser };
}
const illegalNames = ['', ' ', '../escape', '..', '/tmp/escape', 'a/b', 'a\\b', 'a.json', ' a', 'a ', 'a\0b', 'a:b', 'CON', 'nul', 'COM1', 'Lpt9', 'a'.repeat(81), null, 42];

test('omitted start name creates a safe unique temporary name; old no-argument stop still saves it', async t => {
  const { browser, store, dir } = await service(t);
  const a = new BrowserFlowRecording(), b = new BrowserFlowRecording();
  assert.match(a.flow.name, /^未命名-\d+-[a-f0-9]{8}$/);
  assert.notEqual(a.flow.name, b.flow.name);
  await browser.flowStartRecording();
  assert.deepEqual(await fs.readdir(dir), []);
  const flow = await browser.flowStopRecording();
  assert.match(flow.name, /^未命名-/);
  assert.equal((await store.load(flow.name)).name, flow.name);
});

test('stop final name wins over optional or explicit start name, with no intermediate script', async t => {
  const { browser, store, dir } = await service(t);
  await browser.flowStartRecording(undefined, { values: 'record' });
  const saved = await browser.flowStopRecording('最终脚本');
  assert.equal(saved.name, '最终脚本');
  assert.equal(saved.steps[0].url, 'http://localhost/form');
  await browser.flowStartRecording('起始名字');
  const second = await browser.flowStopRecording('停止名字');
  assert.equal(second.name, '停止名字');
  assert.equal((await store.load('停止名字')).name, '停止名字');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['停止名字.json', '最终脚本.json']);
});

test('explicit start name and omitted stop name preserve the original call contract', async t => {
  const { browser, store } = await service(t);
  await browser.flowStartRecording('旧调用', { values: 'parameterize' });
  assert.equal((await browser.flowStopRecording()).name, '旧调用');
  assert.equal((await store.load('旧调用')).name, '旧调用');
  await assert.rejects(browser.flowStartRecording('旧调用'), /已存在/);
});

test('duplicate final name is rejected without overwrite and recording can be saved with another name', async t => {
  const { browser, store, dir } = await service(t);
  await store.save(new BrowserFlowRecording('已有脚本').flow, true);
  const before = await fs.readFile(path.join(dir, '已有脚本.json'), 'utf8');
  await browser.flowStartRecording();
  await assert.rejects(browser.flowStopRecording('已有脚本'), /已存在/);
  assert.equal(await fs.readFile(path.join(dir, '已有脚本.json'), 'utf8'), before);
  assert.equal((await browser.flowStopRecording('另存脚本')).name, '另存脚本');
  assert.deepEqual((await store.list()).map(f => f.name).sort(), ['另存脚本', '已有脚本']);
});

test('invalid start and stop names are rejected; invalid stop does not lose the buffer', async t => {
  const { browser, dir } = await service(t);
  for (const name of illegalNames) await assert.rejects(browser.flowStartRecording(name as string), /非法|越界/);
  await browser.flowStartRecording();
  for (const name of illegalNames) await assert.rejects(browser.flowStopRecording(name as string), /非法|越界/);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal((await browser.flowStopRecording('安全名字')).name, '安全名字');
});

test('stop rejects a name created after recording started, including legacy stop without name', async t => {
  const { browser, store } = await service(t);
  await browser.flowStartRecording('竞态名字');
  await store.save(new BrowserFlowRecording('竞态名字').flow, true);
  await assert.rejects(browser.flowStopRecording(), /已存在/);
  assert.equal((await browser.flowStopRecording('竞态另存')).name, '竞态另存');
});

test('parallel stop is rejected while the first stop is pending', async t => {
  const { browser, store } = await service(t);
  await browser.flowStartRecording();
  const first = browser.flowStopRecording('第一次');
  await assert.rejects(browser.flowStopRecording('第二次'), /正在停止或保存/);
  await first;
  assert.deepEqual((await store.list()).map(f => f.name), ['第一次']);
});

test('rename moves script, rewrites JSON name and preserves steps/history/creation time', async t => {
  const { browser, store, dir } = await service(t);
  const flow = new BrowserFlowRecording('原名字').flow;
  flow.steps.push({ action: 'click', selector: { css: '#submit' } });
  flow.history.push({ step: 1, at: 3, before: { css: '#old' }, after: { css: '#submit' } });
  await store.save(flow, true);
  await browser.flowRename('原名字', '新名字');
  const loaded = await store.load('新名字');
  assert.equal(loaded.name, '新名字');
  assert.equal(loaded.createdAt, flow.createdAt);
  assert.deepEqual(loaded.steps, flow.steps);
  assert.deepEqual(loaded.history, flow.history);
  assert.deepEqual(await fs.readdir(dir), ['新名字.json']);
  await assert.rejects(store.load('原名字'), /ENOENT/);
  await browser.flowRename('新名字', '新名字');
  await assert.rejects(browser.flowRename('缺失', '缺失'), /ENOENT/);
});

test('rename rejects duplicate and invalid old/new names without changing either script', async t => {
  const { browser, store, dir } = await service(t);
  await store.save(new BrowserFlowRecording('原名').flow, true);
  await store.save(new BrowserFlowRecording('已有').flow, true);
  const before = await Promise.all(['原名', '已有'].map(n => fs.readFile(path.join(dir, `${n}.json`), 'utf8')));
  await assert.rejects(browser.flowRename('原名', '已有'), /已存在/);
  for (const name of illegalNames) {
    await assert.rejects(browser.flowRename('原名', name as string), /非法|越界/);
    await assert.rejects(browser.flowRename(name as string, '新名'), /非法|越界/);
  }
  assert.deepEqual(await Promise.all(['原名', '已有'].map(n => fs.readFile(path.join(dir, `${n}.json`), 'utf8'))), before);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['原名.json', '已有.json']);
});

test('rename is blocked during recording', async t => {
  const { browser, store } = await service(t);
  await store.save(new BrowserFlowRecording('原名').flow, true);
  await browser.flowStartRecording();
  await assert.rejects(browser.flowRename('原名', '新名'), /期间不能改名/);
  await browser.flowStopRecording('录制完成');
});

test('stop fails after a project switch and does not create scripts in the new project', async t => {
  const { browser, store } = await service(t), other = await project(t);
  await browser.flowStartRecording();
  await setRoot(other.root);
  await assert.rejects(browser.flowStopRecording('不能保存'), /项目已切换/);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await other.store.list(), []);
});

test('stop detects a project switch during save and leaves neither project with a script', async t => {
  const { browser, store } = await service(t), other = await project(t);
  await browser.flowStartRecording();
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    await write(...args);
    await setRoot(other.root);
  });
  await assert.rejects(browser.flowStopRecording('不能跨项目'), /项目已切换/);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await other.store.list(), []);
});

test('rename pins project across load and exclusive save', async t => {
  const first = await project(t), other = await project(t);
  let current = first.root;
  const store = new BrowserFlowStore(() => current);
  await store.save(new BrowserFlowRecording('原名').flow, true);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    current = other.root;
    return handle;
  });
  await assert.rejects(store.rename('原名', '新名'), /项目已切换/);
  assert.deepEqual((await first.store.list()).map(f => f.name), ['原名']);
  assert.deepEqual(await other.store.list(), []);
});

test('rename and stop reject symlinked directories and script entries', async t => {
  const { browser, store, dir, root } = await service(t), outside = await project(t);
  await store.save(new BrowserFlowRecording('原名').flow, true);
  await fs.writeFile(path.join(outside.root, 'secret.json'), 'untouched');
  await fs.symlink(path.join(outside.root, 'secret.json'), path.join(dir, '链接.json'));
  await assert.rejects(browser.flowRename('链接', '新名'), /符号链接/);
  await assert.rejects(browser.flowRename('原名', '链接'), /符号链接/);
  await fs.unlink(path.join(dir, '链接.json'));
  await browser.flowStartRecording();
  await fs.symlink(path.join(outside.root, 'secret.json'), path.join(dir, '链接.json'));
  await assert.rejects(browser.flowStopRecording('链接'), /符号链接/);
  await fs.unlink(path.join(dir, '链接.json'));
  await fs.rename(path.join(root, '.sikeoop'), path.join(root, '.sikeoop-original'));
  await fs.symlink(outside.root, path.join(root, '.sikeoop'));
  await assert.rejects(browser.flowStopRecording('新名'), /符号链接/);
  await assert.rejects(new BrowserFlowStore(() => root).rename('原名', '新名'), /符号链接/);
  assert.equal(await fs.readFile(path.join(outside.root, 'secret.json'), 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(outside.root), ['secret.json']);
});

test('preload forwards optional names and rename arguments; main registers matching channels', async () => {
  electron.calls.length = 0;
  await electron.api.browserFlowStartRecording();
  await electron.api.browserFlowStartRecording(undefined, { values: 'record' });
  await electron.api.browserFlowStopRecording();
  await electron.api.browserFlowStopRecording('停止名字');
  await electron.api.browserFlowRename('旧名', '新名');
  assert.deepEqual(electron.calls, [
    ['browser:flowStartRecording', undefined, undefined],
    ['browser:flowStartRecording', undefined, { values: 'record' }],
    ['browser:flowStopRecording', undefined],
    ['browser:flowStopRecording', '停止名字'],
    ['browser:flowRename', '旧名', '新名'],
  ]);
  const main = await fs.readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\("browser:flowStopRecording", \(_e, name\) => browser\.flowStopRecording\(name\)\)/);
  assert.match(main, /ipcMain\.handle\("browser:flowRename", \(_e, oldName, newName\) => browser\.flowRename\(oldName, newName\)\)/);
});
