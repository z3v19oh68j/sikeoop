import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CcResult, ResearchEvent, ResearchRequest, ResearchRun } from '../../shared/types.ts';
import type { Dispatcher } from '../dispatch/scheduler.ts';
import { SessionExecutor } from '../dispatch/session.ts';
import { ResearchEnvironment } from './env.ts';
import { buildRunEnv, candidates, selectModels, type ProviderSource } from './providers.ts';
import { presets, presetRepository } from './presets.ts';
import { repositoryRefs } from './repository.ts';
import { initialProgress, parseProgress, redact } from './parse.ts';
import { runProcess } from './process.ts';

interface Entry { run: ResearchRun; project: string; dir: string; writing: Promise<void>; timer?: NodeJS.Timeout }
export function projectHash(root: string): string { return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16); }
export function runArguments(request: ResearchRequest, dir: string, repository?: string): string[] {
  return ['-u', '-m', 'chain_centric.cli', 'run', '-q', request.question, '--max-rounds', String(request.maxRounds), '-o', path.join(dir, 'result.json'), ...(repository ? ['-r', repository] : [])];
}
function live(run: ResearchRun): boolean { return run.status === 'preparing' || run.status === 'running'; }

export class ResearchService {
  readonly environment: ResearchEnvironment;
  private source: string;
  private root: string;
  private dispatcher: Dispatcher;
  private providers: ProviderSource;
  private emit: (event: ResearchEvent) => void;
  private entries = new Map<string, Entry>();
  private initialized: Promise<void> | null = null;
  constructor(source: string, userData: string, dispatcher: Dispatcher, providers: ProviderSource, emit: (event: ResearchEvent) => void) {
    this.source = source; this.root = path.join(userData, 'deep-research'); this.dispatcher = dispatcher; this.providers = providers; this.emit = emit;
    this.environment = new ResearchEnvironment(source, userData, emit);
  }
  init(): Promise<void> { return this.initialized ??= this.restore(); }
  private async restore(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const p of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!p.isDirectory() || !/^[a-f0-9]{16}$/.test(p.name)) continue;
      const projectDir = path.join(this.root, p.name);
      for (const d of await fs.readdir(projectDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !/^[a-f0-9-]{36}$/.test(d.name)) continue;
        const dir = path.join(projectDir, d.name);
        let run: ResearchRun;
        try { run = JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')); } catch { continue; }
        if (run.id !== d.name || !run.request || !Array.isArray(run.agents) || !['preparing', 'running', 'done', 'failed', 'cancelled'].includes(run.status)) continue;
        const e: Entry = { run, project: p.name, dir, writing: Promise.resolve() };
        this.entries.set(run.id, e);
        if (live(run)) { run.status = 'failed'; run.error = '应用关闭时还没跑完'; run.endedAt = Date.now(); await this.save(e); }
      }
    }
  }
  candidates() { return candidates(this.providers); }
  presets() { return presets(this.source); }
  private save(e: Entry): Promise<void> {
    const data = JSON.stringify(e.run, null, 2);
    const write = async () => {
      const temp = path.join(e.dir, `run.${randomUUID()}.tmp`);
      try { await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, path.join(e.dir, 'run.json')); }
      finally { await fs.rm(temp, { force: true }); }
    };
    e.writing = e.writing.catch(() => {}).then(write);
    return e.writing;
  }
  private publish(e: Entry): void { this.emit({ type: 'run', run: structuredClone(e.run) }); }
  private progressSoon(e: Entry): void {
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (!live(e.run)) return;
      this.publish(e);
      void this.save(e).catch(() => { /* Final status write is awaited and reports storage errors. */ });
    }, 250);
  }
  private async finish(e: Entry, status: ResearchRun['status'], error?: string): Promise<void> {
    if (e.timer) { clearTimeout(e.timer); e.timer = undefined; }
    e.run.status = status; e.run.endedAt = Date.now();
    e.run.error = error;
    if (e.run.progress) e.run.progress.calling = [];
    try { await this.save(e); }
    catch { e.run.status = 'failed'; e.run.error = '研究记录保存失败，请检查磁盘空间和文件夹权限'; }
    this.publish(e);
  }
  async start(projectRoot: string, input: ResearchRequest): Promise<ResearchRun> {
    await this.init();
    const request = structuredClone(input);
    const selected = selectModels(this.providers, request);
    const env = await this.environment.env();
    if (!env.installed || env.installing) throw new Error('请先安装好深度科研环境，再开始研究');
    const id = randomUUID(); const project = projectHash(projectRoot); const dir = path.join(this.root, project, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    let repository: string | undefined;
    let refs: string[] = [];
    try {
      if (request.repository) {
        if (request.repository.kind === 'preset') {
          repository = presetRepository(this.source, request.repository.id);
          try { await fs.access(repository); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !(await this.presets()).some(p => p.id === (request.repository as { id: string }).id)) throw error;
            repository = undefined; // Question-only bundled preset.
          }
        }
        else if (request.repository.kind === 'file' && typeof request.repository.path === 'string' && request.repository.path) {
          // Relative paths come from the paper workshop (research/<name>.repository.json): inside this project only.
          const file = path.isAbsolute(request.repository.path) ? request.repository.path : path.resolve(projectRoot, request.repository.path);
          const rel = path.relative(path.resolve(projectRoot), file);
          if (!path.isAbsolute(request.repository.path) && (rel.startsWith('..') || path.isAbsolute(rel))) throw new Error('证据库不在这个项目里');
          repository = path.join(dir, 'repository.json'); await fs.copyFile(file, repository);
        } else throw new Error('证据库选择不正确，请重新选择 JSON 文件');
        if (repository) refs = repositoryRefs(JSON.parse(await fs.readFile(repository, 'utf8')));
      }
    } catch { await fs.rm(dir, { recursive: true, force: true }); throw new Error('证据库读不了或格式不正确，请检查 JSON 文件后重试'); }
    const run: ResearchRun = { id, createdAt: Date.now(), status: 'preparing', request, agents: selected.agents.map((m, i) => ({ agent: `agent_${i}`, providerId: m.candidate.providerId, providerName: m.candidate.providerName, model: m.model })), hasResult: false, repositoryRefs: refs, progress: initialProgress(request.maxRounds) };
    const e: Entry = { run, project, dir, writing: Promise.resolve() };
    this.entries.set(id, e);
    await this.save(e); this.publish(e);
    const submitted = this.dispatcher.submit({ executor: new SessionExecutor(`research:${id}`, `深度科研：${request.question.slice(0, 40)}`, async (_job, signal) => {
      if (signal.aborted) return null;
      try {
        // Settings may have changed while the scheduler queued this run.
        const models = selectModels(this.providers, request);
        const secrets = [...models.agents, models.evidence].map(m => m.key);
        run.status = 'running'; await this.save(e); this.publish(e);
        if (signal.aborted) return null;
        const result = await runProcess(this.environment.pythonPath(), runArguments(request, dir, repository), {
          cwd: dir, env: buildRunEnv(process.env, dir, models.agents, models.evidence), signal, secrets,
          onLine: line => {
            const parsed = parseProgress(line, run.progress!, Date.now(), secrets);
            if (parsed) { run.progress = parsed; this.progressSoon(e); }
          },
        });
        if (signal.aborted) return null;
        const output = await this.readResult(e);
        if (result.code !== 0 || !output) throw new Error(`研究没能完成（${result.code === null ? '进程异常退出' : `退出码 ${result.code}`}）。请检查模型设置或稍后重试。${result.tail.length ? '\n' + result.tail.join('\n') : ''}`);
        run.hasResult = true; run.termination = redact(output.termination_reason, secrets);
        await this.finish(e, 'done');
        return { text: '深度科研已完成，结果已保存' };
      } catch (error) {
        if (signal.aborted) return null;
        const reason = redact(error instanceof Error ? error.message : '研究没有完成');
        await this.finish(e, 'failed', reason);
        throw new Error(reason);
      }
    }), input: '运行独立 Chain-Centric 科研子进程', origin: 'user', from: '深度科研', timeoutMs: 3 * 60 * 60_000 });
    if ('error' in submitted) await this.finish(e, 'failed', submitted.error);
    else {
      run.jobId = submitted.job.id; await this.save(e); this.publish(e);
      void submitted.done.then(async job => {
        if (!live(run)) return;
        await this.finish(e, job.status === 'cancelled' ? 'cancelled' : 'failed', job.status === 'cancelled' ? undefined : job.status === 'timeout' ? '研究超过了等待或运行时限，已停止' : redact(job.error ?? '研究任务没有完成'));
      }).catch(() => { /* finish reports persistence failures. */ });
    }
    return structuredClone(run);
  }
  async list(projectRoot: string): Promise<ResearchRun[]> {
    await this.init(); const project = projectHash(projectRoot);
    return [...this.entries.values()].filter(e => e.project === project).map(e => structuredClone(e.run)).sort((a, b) => b.createdAt - a.createdAt);
  }
  private lookup(projectRoot: string, id: string): Entry {
    const e = this.entries.get(id);
    if (!e || e.project !== projectHash(projectRoot)) throw new Error('这个项目里没有这条研究记录');
    return e;
  }
  async cancel(id: string): Promise<void> {
    await this.init(); const e = this.entries.get(id);
    if (!e || !live(e.run)) return;
    if (e.run.jobId) this.dispatcher.cancel(e.run.jobId);
  }
  private async readResult(e: Entry): Promise<CcResult | null> {
    try {
      const r = JSON.parse(await fs.readFile(path.join(e.dir, 'result.json'), 'utf8'));
      if (!r || typeof r.question !== 'string' || typeof r.termination_reason !== 'string' || !['claims', 'chains', 'attacks', 'chain_details', 'entropy_trajectory'].every(k => Array.isArray(r[k]))) return null;
      return r as CcResult;
    } catch { return null; }
  }
  async result(projectRoot: string, id: string): Promise<CcResult | null> { await this.init(); return this.readResult(this.lookup(projectRoot, id)); }
  async delete(projectRoot: string, id: string): Promise<void> {
    await this.init(); const e = this.lookup(projectRoot, id);
    if (live(e.run)) throw new Error('研究还在运行，请先取消再删除');
    await e.writing; await fs.rm(e.dir, { recursive: true, force: true }); this.entries.delete(id);
  }
  close(): void {
    this.environment.close();
    for (const e of this.entries.values()) if (live(e.run) && e.run.jobId) this.dispatcher.cancel(e.run.jobId);
  }
}
