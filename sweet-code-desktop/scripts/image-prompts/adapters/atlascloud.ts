import { sourceFor, readStructured } from '../adapter.ts';
export const source=sourceFor('atlascloud');
export const read=(dir:string)=>readStructured('atlascloud',dir);
