import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runImport } from '../../scripts/image-prompts/import.ts';
import { repos } from '../../scripts/image-prompts/adapter.ts';
import { sha } from '../../scripts/image-prompts/dedupe.ts';
import { writeDataset } from '../../scripts/image-prompts/output.ts';
import { policyHash } from '../../scripts/image-prompts/policy.ts';
import { checkRelease } from '../../scripts/image-prompts/check-release.ts';
async function temp(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-closing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function sourceFixture(t:any,rows:any[]){
 const dir=await temp(t);
 for(const repo of Object.values(repos)){
  const base=path.join(dir,repo);
  for(const sub of ['data','assets','prompts','skills/gpt-image/references'])await fs.mkdir(path.join(base,sub),{recursive:true});
  for(const file of ['data/cases.json','data/prompts.json','data/refinements.json','data/catalog.json','data/case-library.json','prompts.json'])await fs.writeFile(path.join(base,file),'[]');
  await fs.writeFile(path.join(base,'assets/manifest.json'),'{"assets":[]}');
  await fs.writeFile(path.join(base,'README.md'),'');
 }
 const target=path.join(dir,repos.wangrunlin,'data');await fs.mkdir(target,{recursive:true});
 await fs.writeFile(path.join(target,'catalog.json'),JSON.stringify({entries:rows}));
 return dir;
}
const row=(id:string,prompt:any)=>({id,title:'Fixture picture',category:'other',prompt});
test('malformed structured steps are discarded and counted without interrupting import',async t=>{
 const sources=await sourceFixture(t,[row('bad-array',{steps:'wrong'}),row('bad-element',{steps:[null]}),row('bad-text',{steps:[{en:42}]}),row('good',{steps:[{en:'A detailed studio composition with colorful paper sculpture.'}]})]);
 const report=await runImport(sources,'dev',path.join(await temp(t),'data'));
 assert.equal(report.sources.wangrunlin.read,4);assert.equal(report.sources.wangrunlin.discarded,3);assert.equal(report.total,1);
});
test('duplicate native keys fail before writing output',async t=>{
 const sources=await sourceFixture(t,[row('same','A detailed studio composition with colorful paper sculpture.'),row('same','Another detailed composition with warm soft studio lighting.')]);
 const out=path.join(await temp(t),'data');await fs.mkdir(out);await fs.writeFile(path.join(out,'sentinel'),'original');
 await assert.rejects(runImport(sources,'dev',out),/Duplicate native key: wangrunlin\/same/);
 assert.equal(await fs.readFile(path.join(out,'sentinel'),'utf8'),'original');
});
for(const phase of ['write','install'])test('output '+phase+' failure cleans staging and preserves original',async t=>{
 const dir=await temp(t),out=path.join(dir,'data');await fs.mkdir(out);await fs.writeFile(path.join(out,'sentinel'),'original');
 await assert.rejects(writeDataset(out,{'index.json':Buffer.from('new')},{
  writeFile:async(...args:Parameters<typeof fs.writeFile>)=>{if(phase==='write')throw Error('injected');return fs.writeFile(...args);},
  rename:async(a,b)=>{if(phase==='install'&&String(a).includes('.tmp-'))throw Error('injected');return fs.rename(a,b);}
 }),/injected/);
 assert.equal(await fs.readFile(path.join(out,'sentinel'),'utf8'),'original');
 assert.deepEqual(await fs.readdir(dir),['data']);
});
async function releaseFixture(t:any){
 const dir=await temp(t),files:any={};
 for(const [name,b] of Object.entries({'index.json':Buffer.from('[]'),'bodies.json':Buffer.from('{}'),'thumbs.pack':Buffer.from([255,216,255,217])})){await fs.writeFile(path.join(dir,name),b);files[name]={bytes:b.length,sha256:sha(b)};}
 const manifest={schema:1,profile:'release',generatedAt:1,policyHash:await policyHash(),dataset:files['index.json'].sha256.slice(0,12),files,sources:[]};
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));return {dir,manifest};
}
for(const kind of ['valid','profile','policy','index.json','bodies.json','thumbs.pack','report','size'])test('release checker '+kind,async t=>{
  const {dir,manifest}=await releaseFixture(t);
  if(kind==='profile')manifest.profile='dev';
  if(kind==='policy')manifest.policyHash='0'.repeat(64);
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  if(kind.endsWith('.json')||kind==='thumbs.pack')await fs.appendFile(path.join(dir,kind),'x');
  if(kind==='report')await fs.writeFile(path.join(dir,'report.json'),'{}');
  if(kind==='valid')await checkRelease(dir);
  else await assert.rejects(checkRelease(dir,kind==='size'?3:60*1024*1024),kind==='profile'?/profile/:kind==='policy'?/policyHash/:kind==='report'?/report.json/:kind==='size'?/60 MB/:/sha256/);
});
test('release directory rejects unexpected file',async t=>{const {dir}=await releaseFixture(t);await fs.writeFile(path.join(dir,'extra.txt'),'x');await assert.rejects(checkRelease(dir),/extra.txt/);});
test('release checksum rejects equal-length tampering',async t=>{const {dir}=await releaseFixture(t);await fs.writeFile(path.join(dir,'index.json'),'{}');await assert.rejects(checkRelease(dir),/sha256/);});
test('dev content masquerading as release is rejected despite correct hashes',async t=>{
 const sources=await sourceFixture(t,[row('bad-source','A detailed studio composition with colorful paper sculpture.')]),out=path.join(await temp(t),'data');await runImport(sources,'dev',out);
 const m=JSON.parse(await fs.readFile(path.join(out,'manifest.json'),'utf8'));m.profile='release';m.policyHash=await policyHash();await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(m));await fs.rm(path.join(out,'report.json'));await assert.rejects(checkRelease(out),/发布内容不符合清单/);
});
