import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('flaqai');
export const read=(dir:string)=>readStructured('flaqai',dir);
