import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('wangrunlin');
export const read=(dir:string)=>readStructured('wangrunlin',dir);
