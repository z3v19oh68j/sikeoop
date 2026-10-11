import type { PaperDoc, PaperTranslation } from '../../shared/types.ts';
import { isReferences, translationChunks } from './text.ts';

/** Reuse only completed results for the same language and exact source/section. */
export function resumeTranslation(
  paper: PaperDoc,
  lang: PaperTranslation['lang'],
  previous?: PaperTranslation,
): PaperTranslation {
  const completed = new Map<string, PaperTranslation['chunks']>();
  if (previous?.lang === lang) {
    for (const chunk of previous.chunks) {
      if (chunk.status !== 'done' || typeof chunk.text !== 'string' || !chunk.text.trim()) continue;
      const key = JSON.stringify([chunk.sectionId, chunk.source]);
      const matches = completed.get(key) ?? [];
      matches.push(chunk);
      completed.set(key, matches);
    }
  }
  return {
    lang,
    chunks: paper.sections.filter(section => !isReferences(section.title)).flatMap(section =>
      translationChunks(section.text).map(source => {
        const old = completed.get(JSON.stringify([section.id, source]))?.shift();
        return old
          ? { sectionId: section.id, source, text: old.text, status: 'done' as const }
          : { sectionId: section.id, source, status: 'queued' as const };
      }),
    ),
  };
}
