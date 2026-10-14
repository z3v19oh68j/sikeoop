import { createHash } from 'node:crypto';
import type { DiskCard, DiskBody } from '../../src/main/image-prompts/schema.ts';
export const priority=['flaqai','callirra','toreal','vulcaneon','wuyoscar','freestylefly','stretchcloud','wangrunlin','youmind','atlascloud','zerolu','youart','xianyu110','davidwu'];
export interface Entry {card:DiskCard;body:DiskBody;image?:string;statusId?:string}
export function sha(s:string|Buffer):string{return createHash('sha256').update(s).digest('hex');}
export function duplicateGroups(input:Entry[]):Entry[][] {
 const parent=input.map((_,i)=>i),seen=new Map<string,number>();
 const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]));
 input.forEach((e,i)=>{const text=e.body.variants.map(v=>v.steps.map(s=>s.text.normalize('NFKC').replace(/\s+/g,' ').trim()).join('\n')).sort().join('\n');const keys=['body:'+sha(text)],status=e.statusId??e.body.sourceUrl?.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/)?.[1];if(status)keys.push('status:'+status);for(const k of keys){const prior=seen.get(k);if(prior!==undefined)parent[find(i)]=find(prior);seen.set(k,i);}});
 const groups=new Map<number,Entry[]>();input.forEach((e,i)=>{const key=find(i);groups.set(key,[...(groups.get(key)??[]),e]);});
 return [...groups.values()].map(g=>g.sort((a,b)=>priority.indexOf(a.card.source)-priority.indexOf(b.card.source)||a.card.id.localeCompare(b.card.id)));
}
export function dedupe(input:Entry[]):Entry[]{return duplicateGroups(input).map(group=>{const e=group[0];e.body.alsoIn=[...new Set(group.flatMap(r=>[r.card.source,...r.body.alsoIn]))].filter(s=>s!==e.card.source).sort();e.card.tags=[...new Set(group.flatMap(r=>r.card.tags))].sort();e.card.flags=[...new Set(group.flatMap(r=>r.card.flags))].sort();return e;}).sort((a,b)=>a.card.id.localeCompare(b.card.id));}
export function applyGroupOverrides(input:Entry[],overrides:Record<string,{exclude?:boolean;flags?:DiskCard['flags']}>):{entries:Entry[];excluded:{members:{id:string;source:string}[]}[]}{
 const entries:Entry[]=[],excluded:{members:{id:string;source:string}[]}[]=[];
 for(const group of duplicateGroups(input)){
 if(group.some(e=>overrides[e.card.id]?.exclude)){excluded.push({members:group.map(e=>({id:e.card.id,source:e.card.source}))});continue;}
 for(const e of group)e.card.flags=[...new Set([...e.card.flags,...(overrides[e.card.id]?.flags??[])])];entries.push(...group);
 }return {entries:dedupe(entries),excluded};
}
