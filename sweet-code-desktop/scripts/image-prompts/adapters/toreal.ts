import { sourceFor } from '../adapter.ts';
import { readMarkdown } from '../read-markdown.ts';
export const source=sourceFor('toreal');
export const read=(dir:string)=>readMarkdown('toreal',dir);
