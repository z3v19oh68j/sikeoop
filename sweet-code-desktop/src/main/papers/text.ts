import type { PaperDoc, PaperSummary } from '../../shared/types.ts';
export function cleanText(text: string): string {
  return text.replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}
export function isReferences(title: string): boolean {
  return /^(?:\d+(?:\.\d+)*[.\s]+)?(?:references|bibliography|参考文献)\s*$/i.test(title.trim());
}
export function splitSections(pages: string[]): PaperDoc['sections'] {
  const sections: PaperDoc['sections'] = [];
  let current: PaperDoc['sections'][number] | undefined;
  pages.forEach((page, i) => {
    for (const line of cleanText(page).split('\n')) {
      const s = line.trim();
      const heading = s.length <= 120 && (/^\d+(?:\.\d+)*\.?\s+[A-Za-z\u4e00-\u9fff]/.test(s) || /^(abstract|introduction|background|related work|methods?|methodology|experiments?|results?|discussion|conclusions?|limitations|acknowledg(?:e)?ments?|references|bibliography|摘要|引言|结论|参考文献)$/i.test(s));
      if (!current || heading) {
        current = { id: `s${sections.length + 1}`, title: heading ? s : '正文', page: i + 1, text: '' };
        sections.push(current);
        if (heading) continue;
      }
      current.text += (current.text ? '\n' : '') + line;
    }
  });
  return sections.filter(s => s.text.trim());
}
/** Exact reconstruction; prefer paragraph boundaries, never split a formula/citation when it fits. */
export function translationChunks(text: string, limit = 2500): string[] {
  if (!Number.isInteger(limit) || limit < 32) throw new Error('翻译块长度不合法');
  const protectedRe = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\\begin\{([^}]+)\}[\s\S]*?\\end\{\1\}|\\(?:cite\w*|ref|eqref)\{[^}]*\}/g;
  const spans = [...text.matchAll(protectedRe)].map(m => [m.index!, m.index! + m[0].length]);
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const inside = spans.find(([a,b]) => a < end && b > end);
      if (inside) end = inside[0] > start ? inside[0] : inside[1];
      else {
        const boundary = text.lastIndexOf('\n', end - 1);
        if (boundary > start + limit / 2) end = boundary + 1;
        if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
    }
    out.push(text.slice(start, end)); start = end;
  }
  return out;
}
export function parseObject(text: string): Record<string, unknown> | null {
  try { const value = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); return value && !Array.isArray(value) && typeof value === 'object' ? value : null; } catch { return null; }
}
export function parseSummary(text: string): PaperSummary {
  const obj = parseObject(text);
  const result: PaperSummary = { oneLine: '', problem: '', method: '', results: '', experiments: '', limitations: '', related: '' };
  for (const key of Object.keys(result) as (keyof PaperSummary)[]) result[key] = typeof obj?.[key] === 'string' ? obj[key] as string : '';
  if (!obj || !Object.values(result).some(Boolean)) result.oneLine = text.trim();
  return result;
}
