import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserFlow, BrowserFlowStep, BrowserFlowSelector, BrowserFlowRunResult } from '../../shared/types.ts';

/** Frame identity excludes URL credentials, query and hash (which can contain form secrets). */
export function normalizeFrameUrl(value:string):string {
  const u=new URL(value);u.username='';u.password='';u.search='';u.hash='';return u.href;
}
export function recordingUrl(value:string, step:number):string {
  const u=new URL(value);u.username='';u.password='';
  const entries=[...u.searchParams.keys()];const query=entries.map((key,i)=>`${encodeURIComponent(key)}={url${step}_query${i+1}}`).join('&');
  const hash=u.hash?`#{url${step}_hash}`:'';u.search='';u.hash='';
  return u.href+(query?'?'+query:'')+hash;
}
export function flowName(name: string): string {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_ -]{1,80}$/u.test(name) || name.trim() !== name
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) || Buffer.byteLength(`${name}.json`) > 255) throw new Error('浏览器脚本名称非法或路径越界');
  return name;
}
export function cleanSelector(raw: unknown): BrowserFlowSelector {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('无效选择器');
  const r = raw as Record<string, unknown>, out: BrowserFlowSelector = {};
  for (const k of ['role','name','css','text','frameUrl'] as const) {
    if (r[k] !== undefined) { if (typeof r[k] !== 'string' || r[k].length > 2000) throw new Error('无效选择器'); out[k] = r[k]; }
  }
  if (!(out.role && out.name) && !out.css && !out.text) throw new Error('选择器需要 role + name、CSS 或文本');
  if(out.frameUrl)out.frameUrl=normalizeFrameUrl(out.frameUrl);
  return out;
}
/** Explicit allowlist: never serialize unknown event payloads or password values. */
export function cleanStep(raw: unknown): BrowserFlowStep {
  if (!raw || typeof raw !== 'object') throw new Error('无效脚本步骤');
  const r = raw as BrowserFlowStep;
  if (!['click','fill','select','check','press','navigate','upload'].includes(r.action)) throw new Error('无效脚本动作');
  const out: BrowserFlowStep = { action: r.action };
  if (r.selector) out.selector = cleanSelector(r.selector);
  if (r.password === true) return { action: 'fill', ...(out.selector ? {selector: out.selector} : {}), password: true, description: '填写密码字段' };
  for (const k of ['text','url','key'] as const) if (r[k] !== undefined) { if (typeof r[k] !== 'string' || r[k].length > 5000) throw new Error('步骤值无效'); out[k] = r[k]; }
  if (r.checked !== undefined) { if (typeof r.checked !== 'boolean') throw new Error('步骤勾选值无效'); out.checked = r.checked; }
  if (r.files !== undefined) { if (!Array.isArray(r.files) || r.files.length > 20 || r.files.some(f => typeof f !== 'string' || f.length > 5000)) throw new Error('步骤文件无效'); out.files = [...r.files]; }
  if (out.action === 'navigate' && !out.url) throw new Error('导航缺少 URL');
  if (out.action !== 'navigate' && !out.selector) throw new Error('步骤缺少选择器');
  return out;
}
export function substitute(value: string, vars: Record<string, string>): string {
  return value.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(vars, name) || typeof vars[name] !== 'string') throw new Error(`缺少脚本变量 {${name}}`);
    return vars[name];
  });
}
export function expandStep(step: BrowserFlowStep, vars: Record<string, string>): BrowserFlowStep {
  const out = cleanStep(step);
  if (out.password) return out;
  for (const k of ['text','url','key'] as const) if (out[k] !== undefined) out[k] = substitute(out[k], vars);
  if (out.files) out.files = out.files.map(f => substitute(f, vars));
  if (out.selector) for (const k of ['role','name','css','text','frameUrl'] as const) if (out.selector[k]) out.selector[k] = substitute(out.selector[k]!, vars);
  return out;
}
export class BrowserFlowStore {
  private root: () => string;
  constructor(root: () => string) { this.root = root; }
  private async directory(): Promise<string> {
    const root = await fs.realpath(this.root());
    let dir = root;
    for (const part of ['.sikeoop','browser-flows']) {
      dir = path.join(dir, part);
      try { const stat = await fs.lstat(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('脚本目录不能是符号链接或普通文件'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await fs.mkdir(dir, { mode: 0o700 }); }
      if (await fs.realpath(dir) !== dir) throw new Error('脚本目录路径越界');
    }
    if (await fs.realpath(this.root()) !== root) throw new Error('当前项目已切换');
    return dir;
  }
  private async target(name: string): Promise<string> {
    flowName(name);
    const file = path.join(await this.directory(), `${name}.json`);
    try { const st = await fs.lstat(file); if (st.isSymbolicLink() || !st.isFile()) throw new Error('脚本文件不能是符号链接或非普通文件'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return file;
  }
  async load(name: string): Promise<BrowserFlow> {
    const file = await this.target(name), handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (stat.size > 2_000_000) throw new Error('脚本文件过大');
      const raw = JSON.parse(await handle.readFile('utf8')) as BrowserFlow;
      if (raw.version !== 1 || raw.name !== name || !Array.isArray(raw.steps) || raw.steps.length > 1000 || !Array.isArray(raw.history) || raw.history.length > 1000) throw new Error('脚本版本或结构无效');
      return { version: 1, name, createdAt: Number(raw.createdAt), updatedAt: Number(raw.updatedAt), steps: raw.steps.map(cleanStep), history: raw.history.map(h => ({step: h.step, at: h.at, before: cleanSelector(h.before), after: cleanSelector(h.after)})) };
    } finally { await handle.close(); }
  }
  async save(flow: BrowserFlow, exclusive = false): Promise<void> {
    const file = await this.target(flow.name);
    const data = JSON.stringify({ version: 1, name: flowName(flow.name), createdAt: flow.createdAt, updatedAt: Date.now(), steps: flow.steps.map(cleanStep), history: flow.history.map(h=>({step:h.step,at:h.at,before:cleanSelector(h.before),after:cleanSelector(h.after)})) }, null, 2);
    if (Buffer.byteLength(data) > 2_000_000) throw new Error('脚本文件过大');
    const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      // Revalidate the directory and final entry immediately before installation.
      if (await this.target(flow.name) !== file) throw new Error('当前项目已切换');
      if (exclusive) {
        try { await fs.link(temp, file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            // Preserve the original error code/message for existing callers.
            const conflict = error as NodeJS.ErrnoException;
            conflict.message = `脚本已存在，请换一个名称：${conflict.message}`;
          }
          throw error;
        }
      } else await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async list(): Promise<BrowserFlow[]> {
    const project=this.root();
    const names = await fs.readdir(await this.directory());
    const result: BrowserFlow[] = [];
    for (const entry of names.sort()) if (entry.endsWith('.json')) { if(this.root()!==project)throw new Error('当前项目已切换');result.push(await this.load(entry.slice(0,-5))); }
    if(this.root()!==project)throw new Error('当前项目已切换');
    return result;
  }
  async delete(name: string): Promise<void> { await fs.unlink(await this.target(name)); }
  async rename(oldName: string, newName: string): Promise<void> {
    flowName(oldName);flowName(newName);
    const project = this.root();
    // Pin all three operations to the same project, including save's final revalidation.
    const store = new BrowserFlowStore(() => {
      if (this.root() !== project) throw new Error('当前项目已切换');
      return project;
    });
    const flow = await store.load(oldName);
    if (oldName === newName) return;
    await store.save({ ...flow, name: newName, updatedAt: Date.now() }, true);
    await store.delete(oldName);
  }
}
export class SelectorFailure extends Error {}
export interface FlowRunner {
  runActions<T>(steps: readonly T[], describe: (step: T) => string, execute: (step: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<{completed:number;failedStep:number|null;reason:string|null}>;
  resolve(selector: BrowserFlowSelector): Promise<number>;
  execute(step: BrowserFlowStep, ref?: number): Promise<void>;
  snapshot(): Promise<string>;
  heal?: (selector: BrowserFlowSelector, snapshot: string, signal?: AbortSignal) => Promise<BrowserFlowSelector>;
  checkProject(): void;
}
export async function replayFlow(flow: BrowserFlow, store: BrowserFlowStore, runner: FlowRunner, vars: Record<string,string> = {}, selfHeal = false, signal?: AbortSignal): Promise<BrowserFlowRunResult> {
  const result = await runner.runActions(flow.steps, s => s.password ? '填写密码字段' : s.action, async (original, index) => {
    runner.checkProject();
    const step = expandStep(original, vars);
    if (step.password) throw new Error('填写密码字段：请用户手动填写；脚本不会读取或回放密码');
    let ref: number | undefined;
    if (step.selector) {
      try { ref = await runner.resolve(step.selector); }
      catch (error) {
        if (!(error instanceof SelectorFailure) || !selfHeal || !runner.heal || signal?.aborted) throw error;
        const selector = cleanSelector(await runner.heal(step.selector, await runner.snapshot(), signal));
        runner.checkProject();
        if (signal?.aborted) throw new Error('Browser action cancelled.');
        ref = await runner.resolve(selector);
        // Save only after resolution and successful action, never after an approval denial.
        await runner.execute({...step, selector}, ref);
        runner.checkProject();
        flow.history.push({step:index+1, at:Date.now(), before:original.selector!, after:selector});
        flow.steps[index] = {...original, selector}; flow.updatedAt = Date.now();
        await store.save(flow);
        return;
      }
    }
    await runner.execute(step, ref);
  }, signal);
  let snapshot: string | null = null;
  if (result.failedStep !== null) { try { runner.checkProject(); snapshot = await runner.snapshot(); } catch { snapshot = '(当前快照不可用)'; } }
  return {...result, total:flow.steps.length, snapshot};
}
