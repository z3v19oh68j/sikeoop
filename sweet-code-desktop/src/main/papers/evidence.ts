import type { EvidenceRecord } from '../../shared/types.ts';
const cut = (s: string, n: number) => Array.from(s).slice(0,n).join('');
export function normalizeEvidence(input: unknown): EvidenceRecord[] {
  if (!Array.isArray(input) || input.length > 1000) throw new Error('证据库应是数组，最多 1000 条');
  const str = (v: unknown) => { if (typeof v !== 'string') throw new Error('证据的文字字段不正确'); return v; };
  return input.map(r => {
    if (!r || typeof r !== 'object' || !Array.isArray(r.claims) || r.claims.length > 1000) throw new Error('证据需要 ref、title、detail、source 和 claims');
    return { ref: str(r.ref), title: cut(str(r.title),200), detail: cut(str(r.detail),500), source: str(r.source), claims: r.claims.map((c: EvidenceRecord['claims'][number]) => {
      if (!c || typeof c !== 'object') throw new Error('论点格式不正确');
      let quote: EvidenceRecord['claims'][number]['quote'];
      if (c.quote !== undefined) { const q = c.quote; if (!q || !Number.isInteger(q.page) || q.page < 1) throw new Error('引文页码不正确'); quote = { paperId: str(q.paperId), sectionId: str(q.sectionId), page: q.page, excerpt: str(q.excerpt) }; }
      return { title: cut(str(c.title),200), detail: cut(str(c.detail),500), ...(quote ? {quote} : {}) };
    }) };
  });
}
export function serializeEvidence(input: unknown) {
  const records = normalizeEvidence(input);
  return { repository: records.map(r => ({ ...r, claims: r.claims.map(({title,detail}) => ({title,detail})) })), quotes: records.map(r => r.claims.map(c => c.quote ?? null)) };
}
export function mergeEvidence(repository: unknown, quotes: unknown): EvidenceRecord[] {
  const records = normalizeEvidence(repository);
  if (Array.isArray(quotes)) records.forEach((r,i) => r.claims.forEach((c,j) => { if (quotes[i]?.[j]) c.quote = quotes[i][j]; }));
  return normalizeEvidence(records);
}
export function safeName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('请填写简短的文件名');
  const cleaned = name.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0,100);
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) throw new Error('这个文件名不能使用');
  return cleaned;
}
