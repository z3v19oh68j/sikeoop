import type { ArxivEntry } from '../../shared/types.ts';
export function arxivId(input: string): string {
  let id = input.trim().replace(/^arxiv:\s*/i, '');
  if (/^https?:\/\//i.test(id)) {
    let u: URL; try { u = new URL(id); } catch { throw new Error('arXiv 链接不正确'); }
    if (!/^(?:www\.|export\.)?arxiv\.org$/i.test(u.hostname)) throw new Error('请使用 arXiv 官方链接');
    id = decodeURIComponent(u.pathname.replace(/^\/(?:abs|pdf)\//, '')).replace(/\.pdf$/i, '');
  }
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v[1-9]\d*)?$/i.test(id)) throw new Error('arXiv 编号不正确，例如 2401.12345v2');
  return id;
}
function decode(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : +n; return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : ''; }).replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[k]!);
}
function tag(xml: string, name: string): string {
  return decode(xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i'))?.[1] ?? '').trim();
}
function attrs(s: string): Record<string,string> {
  return Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1], decode(m[3])]));
}
export function parseAtom(xml: string): { entries: ArxivEntry[]; total: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:[\w-]+:)?feed[\s>]/i.test(xml)) throw new Error('arXiv 返回的数据不是有效的论文列表');
  const entries = [...xml.matchAll(/<(?:[\w-]+:)?entry(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?entry>/gi)].map(m => {
    const x = m[1]; const id = arxivId(tag(x,'id'));
    return { id, title: tag(x,'title').replace(/\s+/g,' '), summary: tag(x,'summary'), authors: [...x.matchAll(/<(?:[\w-]+:)?author>([\s\S]*?)<\/(?:[\w-]+:)?author>/gi)].map(a => tag(a[1],'name')), categories: [...x.matchAll(/<(?:[\w-]+:)?category\s+([^>]+)\/?\s*>/gi)].map(c => attrs(c[1]).term).filter(Boolean), published: tag(x,'published'), updated: tag(x,'updated'), absUrl: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}` };
  });
  const n = Number(tag(xml,'totalResults'));
  return { entries, total: Number.isFinite(n) && n >= entries.length ? n : entries.length };
}
export class ArxivClient {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private fetcher: typeof fetch;
  private consent: () => Promise<boolean>;
  constructor(fetcher: typeof fetch, consent: () => Promise<boolean>) { this.fetcher = fetcher; this.consent = consent; }
  request(url: string): Promise<Response> {
    const run = this.queue.then(async () => {
      if (!await this.consent()) throw new Error('请先阅读并同意 arXiv 首次联网说明');
      await new Promise(r => setTimeout(r, Math.max(0, this.last + 3000 - Date.now())));
      this.last = Date.now();
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
      if (!response.ok) throw new Error(`arXiv 暂时无法访问（${response.status}），请稍后再试`);
      return response;
    });
    this.queue = run.catch(() => {}); return run;
  }
  async lookup(input: string): Promise<ArxivEntry> {
    const id = arxivId(input); const result = parseAtom(await (await this.request(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`)).text());
    const entry = result.entries.find(e => e.id.replace(/v\d+$/, '') === id.replace(/v\d+$/, ''));
    if (!entry) throw new Error('没有找到这篇 arXiv 论文'); return entry;
  }
  async search(query: string, start = 0): Promise<{ entries: ArxivEntry[]; total: number }> {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000 || !Number.isInteger(start) || start < 0 || start > 100000) throw new Error('检索词或起始位置不正确');
    return parseAtom(await (await this.request(`http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query.trim())}&start=${start}&max_results=20`)).text());
  }
}
