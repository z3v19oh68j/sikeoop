import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('xianyu110');
export const read=(dir:string)=>readStructured('xianyu110',dir);
