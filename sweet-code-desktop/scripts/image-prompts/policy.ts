import { z } from 'zod';
import { idSchema,licenseSchema,flagSchema } from '../../src/main/image-prompts/schema.ts';
import type { Entry } from './dedupe.ts';
export const policySchema=z.object({sources:z.record(z.string(),z.enum(['include','exclude','text-only'])),allowLicenses:z.array(licenseSchema),excludeThirdParty:z.boolean(),excludeFlags:z.array(flagSchema),maxPerSource:z.record(z.string(),z.union([z.number().int().nonnegative(),z.object({perCategory:z.number().int().nonnegative()}).strict()])),denyIds:z.array(idSchema),allowIds:z.array(idSchema)}).strict();
export function applyPolicy(rows:Entry[],input:unknown):Entry[]{const p=policySchema.parse(input),counts=new Map<string,number>();return rows.filter(e=>{const c=e.card;if(p.denyIds.includes(c.id))return false;const allow=p.allowIds.includes(c.id);if(!allow&&(p.sources[c.source]===undefined||p.sources[c.source]==='exclude'||!p.allowLicenses.includes(c.license)||(p.excludeThirdParty&&c.thirdParty)||c.flags.some(f=>p.excludeFlags.includes(f))))return false;const max=p.maxPerSource[c.source],key=typeof max==='object'?c.source+':'+c.category:c.source,n=counts.get(key)??0;if(!allow&&max!==undefined&&n>=(typeof max==='number'?max:max.perCategory))return false;counts.set(key,n+1);if(p.sources[c.source]==='text-only')e.image=undefined;return true;});}

export function policyViolations(cards:Entry['card'][],input:unknown):string[]{
 const p=policySchema.parse(input),counts=new Map<string,number>(),errors:string[]=[];
 for(const c of cards){const reasons:string[]=[],allow=p.allowIds.includes(c.id);
 if(p.denyIds.includes(c.id))reasons.push('denyIds');
 if(!allow){if(!p.sources[c.source]||p.sources[c.source]==='exclude')reasons.push('source');if(!p.allowLicenses.includes(c.license))reasons.push('license');if(p.excludeThirdParty&&c.thirdParty)reasons.push('thirdParty');if(c.flags.some(f=>p.excludeFlags.includes(f)))reasons.push('flags');}
 const max=p.maxPerSource[c.source],key=typeof max==='object'?c.source+':'+c.category:c.source,n=(counts.get(key)??0)+1;counts.set(key,n);if(!allow&&max!==undefined&&n>(typeof max==='number'?max:max.perCategory))reasons.push('limit');
 if(p.sources[c.source]==='text-only'&&c.thumb)reasons.push('text-only thumbnail');
 if(reasons.length)errors.push(c.id+' ('+c.source+'): '+reasons.join(', '));
 }return errors;
}
export { policyHash } from './policy-hash.ts';
