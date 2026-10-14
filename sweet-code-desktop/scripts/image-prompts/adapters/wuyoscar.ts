import { sourceFor } from '../adapter.ts';
import { readMarkdown } from '../read-markdown.ts';
export const source=sourceFor('wuyoscar');
export const read=(dir:string)=>readMarkdown('wuyoscar',dir);
