import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('stretchcloud');
export const read=(dir:string)=>readStructured('stretchcloud',dir);
