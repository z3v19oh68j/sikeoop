import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('vulcaneon');
export const read=(dir:string)=>readStructured('vulcaneon',dir);
