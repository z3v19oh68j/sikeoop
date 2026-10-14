import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanText,cleanVariants,cleanUrl } from '../../scripts/image-prompts/clean.ts';
import { applyGroupOverrides,duplicateGroups,dedupe,sha,type Entry } from '../../scripts/image-prompts/dedupe.ts';
import { SourceReader } from '../../scripts/image-prompts/io.ts';
import { applyPolicy } from '../../scripts/image-prompts/policy.ts';
import { adapters } from '../../scripts/image-prompts/import.ts';
import { blocks } from '../../scripts/image-prompts/markdown.ts';
import { stripMetadata,imageHeader } from '../../scripts/image-prompts/thumbs.ts';
function entry(source:string,text='a complete prompt longer than twenty characters'):Entry{return {card:{id:sha(source).slice(0,16),title:'Title',excerpt:'text',category:'ui',tags:[source],langs:['en'],models:['gpt-image-2'],needsReference:false,multiStep:false,source,license:'MIT',thirdParty:false,flags:[],featured:false},body:{variants:[{lang:'en',steps:[{text}]}],alsoIn:[],hasVars:false},image:source+'.jpg'};}
test('NFKC, invisible removal, variable substitution, bilingual splitting and length rejection',()=>{assert.equal(cleanText('Ａ\u200b\u00ad\x00B'),'AB');const c=cleanVariants([{lang:'en',steps:[{text:'[中文]这是足够二十个字的中文图像生成提示词正文内容描述。[English]A complete visual prompt with {argument name="color" default="blue"} backdrop.'}]}]);assert.equal(c.variants.length,2);assert.equal(c.hasVars,true);assert.match(c.variants[1].steps[0].text,/\[blue\]/);for(const text of ['short','原文未公开'.repeat(10),'a'.repeat(20001)])assert.equal(cleanVariants([{lang:'zh',steps:[{text}]}]).variants.length,0);assert.equal(cleanUrl('https://example.com/?utm_source=x&ref=x&via=x&ok=yes'),'https://example.com/?ok=yes');assert.equal(cleanUrl('https://u:p@example.com'),undefined);assert.equal(cleanUrl('http://example.com'),undefined);});
test('dedupe priority, normalized body and X status merge; winner thumbnail stays own',()=>{const a=entry('freestylefly'),b=entry('flaqai');const rows=dedupe([a,b]);assert.equal(rows.length,1);assert.equal(rows[0].card.source,'flaqai');assert.deepEqual(rows[0].body.alsoIn,['freestylefly']);assert.equal(rows[0].image,'flaqai.jpg');assert.equal(rows[0].card.tags.length,2);const c=entry('youart','a different complete prompt longer than twenty characters');b.statusId=c.statusId='123';assert.equal(dedupe([b,c]).length,1);});
test('policy constraints and 14 adapters',()=>{assert.equal(adapters.length,14);const policy={sources:{stretchcloud:'text-only'},allowLicenses:['MIT'],excludeThirdParty:true,excludeFlags:['suggestive'],maxPerSource:{stretchcloud:{perCategory:1}},denyIds:[],allowIds:[]};const a=entry('stretchcloud'),b=entry('stretchcloud');b.card.id='f'.repeat(16);const rows=applyPolicy([a,b],policy);assert.equal(rows.length,1);assert.equal(rows[0].image,undefined);assert.equal(applyPolicy([entry('youart')],policy).length,0);});
test('source reader rejects escape, symlink and scripts',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'source-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'a.json'),'{}');await fs.symlink(path.join(dir,'a.json'),path.join(dir,'b.json'));await fs.writeFile(path.join(dir,'evil.ts'),'throw Error()');const io=new SourceReader(dir);assert.equal((await io.read(path.join(dir,'a.json'))).toString(),'{}');await assert.rejects(io.read(path.join(dir,'b.json')));await assert.rejects(io.read(path.join(dir,'evil.ts')));await assert.rejects(io.read(path.join(dir,'../outside.json')));});
test('markdown fences and JPEG metadata stripping',()=>{assert.deepEqual(blocks('~~~text\nfirst\n~~~\n```text\nsecond\n```'),['first','second']);const b=Buffer.from([255,216,255,225,0,4,1,2,255,218,0,2,9]);assert.equal(imageHeader(b),true);assert.deepEqual(stripMetadata(b),Buffer.from([255,216,255,218,0,2,9]));});
test('expanded invisible/control set preserves emoji variation; all tracking and link-only removal',()=>{
 const invisible=[0x2066,0x2067,0x2068,0x2069,0xe0000,0xe007f,0x2028,0x2029,0x061c,0x80,0x9f,0x1160,0x3164].map(c=>String.fromCodePoint(c)).join('');
 assert.equal(cleanText('A'+invisible+'B\uFE0F'),'AB\uFE0F');
 assert.equal(cleanVariants([{lang:'en',steps:[{text:42 as unknown as string}]}]).variants.length,0);
 assert.equal(cleanVariants([{lang:'zh',steps:[{text:'原文链接:https://mp.weixin.qq.com/verylonglinkthatisnotaprompt'}]}]).variants.length,0);
 assert.equal(cleanUrl('https://example.com/?ref_src=x&ref_url=y&s=1&t=2&fbclid=x&gclid=x&aff=x&invite=x&share=x&keep=1'),'https://example.com/?keep=1');
});

test('manual exclusion removes entire duplicate group and manual flags union',()=>{
 const a=entry('flaqai'),b=entry('freestylefly');const result=applyGroupOverrides([a,b],{[a.card.id]:{exclude:true}});assert.equal(result.entries.length,0);assert.deepEqual(result.excluded[0].members,[{id:a.card.id,source:'flaqai'},{id:b.card.id,source:'freestylefly'}]);
 const c=entry('flaqai'),d=entry('freestylefly');d.card.flags=['brand'];const merged=applyGroupOverrides([c,d],{[d.card.id]:{flags:['real-person']}});assert.deepEqual(merged.entries[0].card.flags,['brand','real-person']);
});
test('duplicate grouping joins transitive body and status bridges',()=>{const a=entry('flaqai'),b=entry('callirra','another long enough visual prompt in the studio'),c=entry('youart');a.statusId=b.statusId='123';assert.equal(duplicateGroups([a,b,c]).length,1);});
import { policyViolations } from '../../scripts/image-prompts/policy.ts';
const basePolicy={sources:{flaqai:'include',stretchcloud:'text-only'},allowLicenses:['MIT'],excludeThirdParty:true,excludeFlags:['suggestive'],maxPerSource:{flaqai:0,stretchcloud:{perCategory:0}},denyIds:[],allowIds:[]};
for(const kind of ['source','license','thirdParty','flags','limit','text-only thumbnail','denyIds'])test('release content rejects '+kind,()=>{const e=entry('flaqai'),p:any=structuredClone(basePolicy);p.maxPerSource={};if(kind==='source')e.card.source='davidwu';if(kind==='license')e.card.license='none';if(kind==='thirdParty')e.card.thirdParty=true;if(kind==='flags')e.card.flags=['suggestive'];if(kind==='limit')p.maxPerSource.flaqai=0;if(kind==='denyIds')p.denyIds=[e.card.id];if(kind==='text-only thumbnail'){e.card.source='stretchcloud';e.card.thumb={o:0,n:3,w:1,h:1};}assert.ok(policyViolations([e.card],p).some(s=>s.includes(kind)));});
