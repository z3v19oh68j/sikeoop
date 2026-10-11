import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { redact } from './parse.ts';

/** Bounded UTF-8 line framing; oversized untrusted lines are discarded in full. */
export function lineSink(onLine: (line: string) => void, limit = 16384): { write(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = ''; let dropped = false;
  const consume = (text: string) => {
    for (const part of text.split(/(?<=\n)/)) {
      const complete = part.endsWith('\n');
      if (!dropped) {
        if (pending.length + part.length > limit) { pending = ''; dropped = true; }
        else pending += part;
      }
      if (complete) { if (!dropped) onLine(pending.replace(/\r?\n$/, '')); pending = ''; dropped = false; }
    }
  };
  return { write: chunk => consume(decoder.write(chunk)), end: () => { consume(decoder.end()); if (pending && !dropped) onLine(pending); pending = ''; } };
}

export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve()); killer.once('close', () => resolve());
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}
export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  secrets?: readonly string[];
  onLine?: (line: string) => void;
}
export async function runProcess(file: string, args: string[], options: ProcessOptions): Promise<{ code: number | null; tail: string[] }> {
  if (options.signal?.aborted) return { code: null, tail: [] };
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const stdout = lineSink(line => options.onLine?.(line));
    const stderr = lineSink(line => { if (line.trim()) { tail.push(redact(line, options.secrets)); if (tail.length > 6) tail.shift(); } });
    let killing: Promise<void> | undefined;
    const abort = () => { if (child.pid) killing ??= killTree(child.pid); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
    child.once('error', () => { options.signal?.removeEventListener('abort', abort); reject(new Error('没能启动 Python 进程，请检查深度科研环境是否已安装')); });
    child.once('close', (code) => {
      stdout.end(); stderr.end(); options.signal?.removeEventListener('abort', abort);
      void Promise.resolve(killing).then(() => resolve({ code, tail }));
    });
  });
}
