import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ResearchEnv, ResearchEvent } from '../../shared/types.ts';
import { buildRunEnv } from './providers.ts';
import { runProcess } from './process.ts';

interface Python { file: string; args: string[]; version: string; via: 'uv' | 'python3' }
function probe(file: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => execFile(file, args, { timeout: 15000, maxBuffer: 16384, windowsHide: true }, (err, out, stderr) => resolve(err ? null : `${out}\n${stderr}`.trim())));
}
export function supportedPython(output: string): string | null {
  const m = output.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
  return m && (Number(m[1]) > 3 || Number(m[1]) === 3 && Number(m[2]) >= 10) ? m[0].replace(/^Python\s+/, '') : null;
}
export class ResearchEnvironment {
  readonly source: string;
  readonly root: string;
  private emit: (event: ResearchEvent) => void;
  private installing: Promise<ResearchEnv> | null = null;
  private controller: AbortController | null = null;
  constructor(source: string, userData: string, emit: (event: ResearchEvent) => void) {
    this.source = source; this.root = path.join(userData, 'deep-research'); this.emit = emit;
  }
  pythonPath(): string { return path.join(this.root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  private async findPython(): Promise<Python | null> {
    const found = await probe('uv', ['python', 'find', '--no-python-downloads', '>=3.10']);
    if (found) {
      const file = found.split(/\r?\n/)[0].trim();
      const version = supportedPython(await probe(file, ['--version']) ?? '');
      if (version) return { file, args: [], version, via: 'uv' };
    }
    const choices = process.platform === 'win32' ? [{ file: 'py', args: ['-3'] }, { file: 'python3', args: [] }, { file: 'python', args: [] }] : [{ file: 'python3', args: [] }, { file: 'python', args: [] }];
    for (const c of choices) {
      const version = supportedPython(await probe(c.file, [...c.args, '--version']) ?? '');
      if (version) return { ...c, version, via: 'python3' };
    }
    return null;
  }
  private async version(): Promise<string> {
    const text = await fs.readFile(path.join(this.source, 'pyproject.toml'), 'utf8');
    return text.match(/^version\s*=\s*["']([^"']+)/m)?.[1] ?? 'unknown';
  }
  async env(): Promise<ResearchEnv> {
    const python = await this.findPython();
    const packageVersion = await this.version();
    let installed = false;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(this.root, 'installed.json'), 'utf8'));
      await fs.access(this.pythonPath()); installed = marker.version === packageVersion;
    } catch { /* Not successfully installed yet. */ }
    return { python: python ? { found: true, version: python.version, via: python.via } : { found: false, hint: '请先安装 Python 3.10 或更新版（python.org），安装时勾选“添加到 PATH”；也可以安装 uv。装好后重启 sikeoop 再试。' }, installed, installing: !!this.installing, packageVersion };
  }
  install(): Promise<ResearchEnv> {
    if (this.installing) return this.installing;
    // Defer execution so env() sees the install promise immediately.
    this.installing = Promise.resolve().then(() => this.performInstall());
    return this.installing;
  }
  private async performInstall(): Promise<ResearchEnv> {
    this.controller = new AbortController();
    try {
      const state = await this.env(); this.emit({ type: 'env', env: { ...state, installing: true } });
      const python = await this.findPython();
      if (!python) throw new Error(state.python.hint);
      await fs.mkdir(this.root, { recursive: true });
      await fs.rm(path.join(this.root, 'installed.json'), { force: true });
      const env = buildRunEnv(process.env, this.root, [], { cc: 'openai', model: '', key: '', candidate: { providerId: '', providerName: '', model: '', cc: 'openai', ready: false } });
      delete env.CHAIN_CENTRIC_AGENTS; delete env.CHAIN_CENTRIC_EVIDENCE_LLM; delete env.OPENAI_API_KEY;
      const commands: [string, string[]][] = python.via === 'uv'
        ? [['uv', ['venv', '--python', python.file, path.join(this.root, 'venv')]], ['uv', ['pip', 'install', '--python', this.pythonPath(), `${this.source}[llm]`]]]
        : [[python.file, [...python.args, '-m', 'venv', path.join(this.root, 'venv')]], [this.pythonPath(), ['-m', 'pip', 'install', `${this.source}[llm]`]]];
      for (const [file, args] of commands) {
        this.emit({ type: 'env', env: { ...state, installed: false, installing: true } });
        const result = await runProcess(file, args, { cwd: this.root, env, signal: this.controller.signal });
        if (this.controller.signal.aborted || result.code !== 0) throw new Error('深度科研环境安装没完成，请检查网络和 Python 后重试');
      }
      await fs.writeFile(path.join(this.root, 'installed.json'), JSON.stringify({ version: state.packageVersion }), { mode: 0o600 });
    } finally {
      this.installing = null; this.controller = null;
      this.emit({ type: 'env', env: await this.env() });
    }
    return this.env();
  }
  close(): void { this.controller?.abort('cancelled'); }
}
