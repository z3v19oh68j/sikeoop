import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('youart');
export const read=(dir:string)=>readStructured('youart',dir);
