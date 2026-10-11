import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

// Downloading for the workshop's tools: only from the hosts a caller names, redirects included;
// a file that stopped half-way is continued, not started over; and the result is checked.

/**
 * One request that does NOT follow redirects: a 3xx comes back as it is, with its `location`.
 * (In the app this is Electron's network stack; in tests a fake.)
 */
export type HttpRequest = (url: string, init: { method?: "GET" | "HEAD"; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Thrown when the user stopped it. */
export class Cancelled extends Error {
  constructor() {
    super("已取消");
  }
}

/** The address, when it is plain https to one of the allowed hosts. */
export function allowedUrl(url: string, hosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("下载地址不对");
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw new Error(`只从 https 地址下载，没有访问 ${u.host}`);
  if (!hosts.includes(u.hostname)) throw new Error(`${u.hostname} 不在允许访问的地址里，没有访问`);
  return u;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;

/** Makes the request, following redirects by hand: every address on the way must be an allowed one. */
export async function requestAllowed(request: HttpRequest, url: string, hosts: readonly string[], init: Parameters<HttpRequest>[1] = {}): Promise<{ res: Response; url: string }> {
  let at = allowedUrl(url, hosts).href;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await request(at, init);
    const to = REDIRECT.has(res.status) ? res.headers.get("location") : null;
    if (!to) return { res, url: at };
    void res.body?.cancel().catch(() => undefined);
    at = allowedUrl(new URL(to, at).href, hosts).href;
  }
  throw new Error("下载地址转了太多次，没有继续");
}

const TEXT_LIMIT = 4 * 1024 * 1024;

/** A small text answer (release information, a checksums file). */
export async function getText(request: HttpRequest, url: string, hosts: readonly string[], signal?: AbortSignal, headers: Record<string, string> = {}): Promise<string> {
  const { res } = await requestAllowed(request, url, hosts, { headers, signal });
  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    const limited = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(limited ? "GitHub 暂时限制了查询次数（没登录的电脑每小时 60 次），过一会儿再试" : `没有查到（${new URL(url).hostname} 返回 ${res.status}）`);
  }
  const text = await res.text();
  if (text.length > TEXT_LIMIT) throw new Error("返回的内容太大，不像是正常的回答");
  return text;
}

export async function getJson(request: HttpRequest, url: string, hosts: readonly string[], signal?: AbortSignal): Promise<unknown> {
  const text = await getText(request, url, hosts, signal, { Accept: "application/vnd.github+json" });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("返回的内容不是预期的格式");
  }
}

/** What the final address says about the file, without downloading it. */
export async function headOf(request: HttpRequest, url: string, hosts: readonly string[], signal?: AbortSignal): Promise<{ url: string; size: number }> {
  const got = await requestAllowed(request, url, hosts, { method: "HEAD", signal });
  void got.res.body?.cancel().catch(() => undefined);
  if (!got.res.ok) throw new Error(`没有查到（${new URL(got.url).hostname} 返回 ${got.res.status}）`);
  const size = Number(got.res.headers.get("content-length"));
  return { url: got.url, size: Number.isSafeInteger(size) && size > 0 ? size : 0 };
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const sizeOf = (file: string): Promise<number> => fs.stat(file).then((s) => (s.isFile() ? s.size : 0), () => 0);

/** "bytes 100-199/200" → 100. */
function rangeStart(res: Response): number {
  const m = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(res.headers.get("content-range") ?? "");
  return m ? Number(m[1]) : -1;
}

export interface DownloadRequest {
  request: HttpRequest;
  url: string;
  hosts: readonly string[];
  /** The unfinished file. What is already in it is kept and continued from. */
  part: string;
  /** The file's size as published; 0 when not known. */
  total: number;
  signal: AbortSignal;
  progress?(received: number, total: number): void;
  /** With no data for this long the download is given up (it can be continued later). */
  stallMs?: number;
}

/**
 * Downloads into `part`, continuing from what is already there when the server allows it.
 * Resolves with the size once the whole file is there. A failure leaves `part` for the next try;
 * a wrong size at the end removes it.
 */
export async function downloadTo(o: DownloadRequest): Promise<number> {
  let have = await sizeOf(o.part);
  if (o.total && have > o.total) {
    await fs.rm(o.part, { force: true });
    have = 0;
  }
  if (o.total && have === o.total) return have;
  if (o.signal.aborted) throw new Cancelled();

  // A second request only when the first asked for a part the server would not give.
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    o.signal.addEventListener("abort", stop, { once: true });
    try {
      const { res } = await requestAllowed(o.request, o.url, o.hosts, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal });
      if (have && res.status === 206 && rangeStart(res) === have) {
        // Continuing.
      } else if (res.status === 200) {
        have = 0;
      } else if (have && (res.status === 416 || res.status === 206) && attempt === 0) {
        void res.body?.cancel().catch(() => undefined);
        await fs.rm(o.part, { force: true });
        have = 0;
        continue;
      } else {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(`下载失败（服务器返回 ${res.status}）`);
      }
      if (!res.body) throw new Error("下载失败（服务器没有给内容）");
      const received = await pump(res.body, o, have, ctl);
      if (o.total && received !== o.total) {
        if (received > o.total) await fs.rm(o.part, { force: true });
        throw new Error(received > o.total ? "下载到的文件比公布的大，已删除" : `下载中断了（收到 ${received} / ${o.total} 字节），再试一次会接着下`);
      }
      return received;
    } catch (err) {
      if (o.signal.aborted) throw new Cancelled();
      throw err;
    } finally {
      o.signal.removeEventListener("abort", stop);
      ctl.abort();
    }
  }
}

async function pump(body: ReadableStream<Uint8Array>, o: DownloadRequest, start: number, ctl: AbortController): Promise<number> {
  const file = await fs.open(o.part, start ? "a" : "w");
  const reader = body.getReader();
  const stallMs = o.stallMs ?? 60_000;
  let received = start;
  // A read that gives up when stopped or when nothing arrives for too long, whatever the stream does.
  const read = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("网络太久没有数据，下载停下了；再试一次会接着下")), stallMs);
      const aborted = () => reject(new Cancelled());
      ctl.signal.addEventListener("abort", aborted, { once: true });
      reader.read().then(resolve, reject).finally(() => {
        clearTimeout(timer);
        ctl.signal.removeEventListener("abort", aborted);
      });
    });
  try {
    o.progress?.(received, o.total);
    for (;;) {
      if (ctl.signal.aborted) throw new Cancelled();
      const { done, value } = await read();
      if (done) break;
      await file.write(value);
      received += value.byteLength;
      o.progress?.(received, o.total);
    }
    return received;
  } finally {
    void reader.cancel().catch(() => undefined);
    await file.close();
  }
}
