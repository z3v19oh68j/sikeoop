import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('freestylefly');
export const read=(dir:string)=>readStructured('freestylefly',dir);
