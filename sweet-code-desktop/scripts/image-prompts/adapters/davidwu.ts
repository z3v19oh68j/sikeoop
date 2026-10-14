import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('davidwu');
export const read=(dir:string)=>readStructured('davidwu',dir);
