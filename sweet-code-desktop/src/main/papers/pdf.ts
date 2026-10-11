import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { splitSections } from './text.ts';
export async function readPdf(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 100*1024*1024) throw new Error('PDF 应为文件且小于 100 MB');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts:false });
  try {
    const doc = await task.promise; const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) { const content = await (await doc.getPage(i)).getTextContent(); pages.push(content.items.map(it => 'str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '').join('')); }
    if (!pages.some(p => p.trim())) throw new Error('没有可读取的文字，扫描件需要先做 OCR');
    return { pages:doc.numPages, sections:splitSections(pages) };
  } catch(e) { throw new Error(`PDF 读取失败：${e instanceof Error ? e.message : '文件可能损坏或有密码'}`); }
  finally { await task.destroy(); }
}
