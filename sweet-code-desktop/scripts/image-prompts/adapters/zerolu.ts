import { sourceFor } from '../adapter.ts';
import { readMarkdown } from '../read-markdown.ts';
export const source=sourceFor('zerolu');
export const read=(dir:string)=>readMarkdown('zerolu',dir);
