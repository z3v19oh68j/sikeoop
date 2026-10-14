import { sourceFor } from '../adapter.ts';
import { readMarkdown } from '../read-markdown.ts';
export const source=sourceFor('youmind');
export const read=(dir:string)=>readMarkdown('youmind',dir);
