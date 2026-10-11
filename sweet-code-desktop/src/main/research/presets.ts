import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ResearchPreset } from '../../shared/types.ts';
import { repositoryRecords } from './repository.ts';

export function presetRepository(source: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('预设名称不正确');
  return path.join(source, 'examples', 'presets', id, 'repository.json');
}
export async function presets(source: string): Promise<ResearchPreset[]> {
  const root = path.join(source, 'examples', 'presets');
  const dirs = await fs.readdir(root, { withFileTypes: true });
  const result: ResearchPreset[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const question = (await fs.readFile(path.join(root, d.name, 'question.txt'), 'utf8')).trim();
      let title = d.name.replace(/_/g, ' ');
      try { title = (await fs.readFile(path.join(root, d.name, 'README.md'), 'utf8')).split(/\r?\n/)[0].replace(/^#+\s*/, '').trim() || title; } catch { /* optional */ }
      let records = 0;
      try { records = repositoryRecords(JSON.parse(await fs.readFile(presetRepository(source, d.name), 'utf8'))).length; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      result.push({ id: d.name, title, question, records, language: /[\u3400-\u9fff]/.test(question) ? 'zh' : 'en' });
    } catch { /* Incomplete bundled examples are not selectable. */ }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
