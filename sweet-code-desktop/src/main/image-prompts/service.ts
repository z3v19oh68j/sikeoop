import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { releasePolicyHash } from './release-policy-hash.ts';
import releasePolicy from '../../../scripts/image-prompts/release-policy.json' with {type:'json'};
import { policyViolations } from '../../../scripts/image-prompts/policy.ts';
import type { ImagePromptDetail, ImagePromptMeta, ImagePromptPage, ImagePromptCard } from '../../shared/types.ts';
import { bodySchema, cardSchema, manifestSchema, favoritesSchema, querySchema, idSchema, copySchema, safeUrl, type DiskCard, type DiskBody } from './schema.ts';
export interface ImagePromptServiceOptions { dataDir:string; userData:string; copy:(text:string)=>void; requireRelease:boolean }
const CATEGORY_LABELS:Record<string,string>={portrait:'人像写真',poster:'海报与排版',product:'产品与电商',ui:'界面与网页',infographic:'信息图与图表',illustration:'插画与艺术',character:'角色与 IP',photo:'摄影与写实场景',brand:'品牌与标志',space:'建筑与空间',edit:'改图与参考图',fun:'创意玩法',other:'其他'};
const MODEL_LABELS:Record<string,string>={'gpt-image-2':'GPT Image 2','gpt-image-2.5':'GPT Image 2.5',other:'其他'};
const LANG_LABELS:Record<string,string>={zh:'中文',en:'英文',other:'其他'};
const EMPTY_META:ImagePromptMeta={state:'missing',dataset:'',profile:'dev',generatedAt:0,total:0,favorites:0,categories:[],models:[],langs:[],sources:[]};
// One category must not fill the first screens: featured first, then categories take turns.
// Input is already sorted, so the result is stable for paging.
function interleave<T extends {card:{featured:boolean;category:string}}>(rows:T[]):T[]{const out:T[]=[];for(const featured of [true,false]){const groups=new Map<string,T[]>();for(const r of rows)if(r.card.featured===featured){const g=groups.get(r.card.category);if(g)g.push(r);else groups.set(r.card.category,[r]);}const lists=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(e=>e[1]);for(let i=0,more=true;more;i++){more=false;for(const list of lists)if(i<list.length){out.push(list[i]);more=true;}}}return out;}
export class ImagePromptService {
 private options:ImagePromptServiceOptions;
 private loading?:Promise<void>;
 private state:ImagePromptMeta={...EMPTY_META};
 private records=new Map<string,{card:DiskCard;body:DiskBody;search:string}>();
 private pack?:{file:string;size:number;sha256:string};
 private packIdentity?:string;
 private packRetryAt=0;
 private failedUntil=0;
 private packState:'idle'|'checking'|'valid'|'invalid'='idle';
 private packCheck?:Promise<void>;
 private badThumbs=new Set<string>();
 private favorites=new Map<string,number>();
 private saves:Promise<void>=Promise.resolve();
 private favoritesLoaded=false;
 private favoritesNeedBackup=false;
 constructor(options:ImagePromptServiceOptions){this.options=options;}
 private async fixed(name:string,max:number):Promise<Buffer>{
  const root=await fs.realpath(this.options.dataDir); const target=await fs.realpath(path.join(root,name));
  const rel=path.relative(root,target); if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error('Dataset file escapes data directory: '+name);
  const f=await fs.open(target,'r'); try {const stat=await f.stat();if(!stat.isFile()||stat.size>max) throw new Error('Invalid dataset file: '+name);return await f.readFile();}finally{await f.close();}
 }
 private async loadFavorites():Promise<void>{
  if(this.favoritesLoaded)return;
  this.favoritesLoaded=true;
  try{
   const f=await fs.open(path.join(this.options.userData,'image-prompts.json'),'r');
   let bytes:Buffer;
   try{const stat=await f.stat();if(!stat.isFile()||stat.size>1024*1024)throw new Error('Invalid favorites file');const buffer=Buffer.alloc(1024*1024+1);let length=0;while(length<buffer.length){const result=await f.read(buffer,length,buffer.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}if(length>1024*1024)throw new Error('Invalid favorites file');bytes=buffer.subarray(0,length);}finally{await f.close();}
   const p=favoritesSchema.parse(JSON.parse(bytes.toString('utf8')));this.favorites=new Map(p.favorites.map(x=>[x.id,x.at]));
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.favoritesNeedBackup=true;}
 }
 private async load():Promise<void>{
  await this.loadFavorites();
  this.records.clear();
  let releaseRejected=false;
  try{
   const manifest=manifestSchema.parse(JSON.parse((await this.fixed('manifest.json',1024*1024)).toString()));
   if(this.options.requireRelease&&manifest.profile!=='release'){releaseRejected=true;throw new Error('Packaged builds require a release dataset');}
   const index=await this.fixed('index.json',16*1024*1024), bodies=await this.fixed('bodies.json',64*1024*1024);
   let pack:typeof this.pack;
   try{
    const root=await fs.realpath(this.options.dataDir),file=await fs.realpath(path.join(root,'thumbs.pack'));
    const rel=path.relative(root,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Unsafe pack');
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>200*1024*1024||stat.size!==manifest.files['thumbs.pack'].bytes)throw new Error('Invalid pack size');
    pack={file,size:stat.size,sha256:manifest.files['thumbs.pack'].sha256};
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   for(const [name,buf] of [['index.json',index],['bodies.json',bodies]] as const){if(buf.length!==manifest.files[name].bytes||createHash('sha256').update(buf).digest('hex')!==manifest.files[name].sha256)throw new Error('Dataset checksum mismatch: '+name);}
   if(createHash('sha256').update(index).digest('hex').slice(0,12)!==manifest.dataset)throw new Error('Dataset id mismatch');
   if(this.options.requireRelease){if(manifest.policyHash!==releasePolicyHash)throw new Error('Release policy mismatch');const errors=policyViolations(JSON.parse(index.toString()).map((c:unknown)=>cardSchema.parse(c)),releasePolicy);if(errors.length)throw new Error(errors.slice(0,20).join('\n'));const allowed=new Set(['manifest.json','index.json','bodies.json','thumbs.pack','NOTICE.md','.gitignore']);if((await fs.readdir(this.options.dataDir)).some(n=>!allowed.has(n)))throw new Error('Extra release files');}
   const rows:unknown=JSON.parse(index.toString()), raw:unknown=JSON.parse(bodies.toString());if(!Array.isArray(rows)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid dataset containers');
   for(const row of rows){const c=cardSchema.safeParse(row);if(!c.success)continue;const b=bodySchema.safeParse((raw as Record<string,unknown>)[c.data.id]);if(!b.success||this.records.has(c.data.id))continue; b.data.sourceUrl=safeUrl(b.data.sourceUrl);this.records.set(c.data.id,{card:c.data,body:b.data,search:[c.data.title,c.data.titleEn,c.data.author,...c.data.tags,...b.data.variants.flatMap(v=>v.steps.map(s=>s.text))].join('\n').normalize('NFKC').toLowerCase()});}
   this.pack=pack;this.state={...EMPTY_META,state:'ready',dataset:manifest.dataset,profile:manifest.profile,generatedAt:manifest.generatedAt,total:this.records.size,sources:manifest.sources};
  }catch(e){this.failedUntil=Date.now()+5000;this.records.clear();this.pack=undefined;const missing=(e as NodeJS.ErrnoException).code==='ENOENT';this.state={...EMPTY_META,state:missing?'missing':'invalid',reason:missing?'没有找到提示词数据':releaseRejected?'这份数据还没有经过发布筛选':'数据文件校验没有通过'};}
 }
 private async ready(){if(this.state.state!=='ready'&&Date.now()<this.failedUntil)return;if(!this.loading){const pending=this.load();this.loading=pending;try{await pending;}finally{if(this.state.state!=='ready'&&this.loading===pending)this.loading=undefined;}}else await this.loading;}
 private image(c:DiskCard){const t=c.thumb,p=this.pack;return !!(t&&p&&!this.badThumbs.has(c.id)&&this.packState!=='invalid'&&t.n>=3&&t.n<=200*1024&&t.o+t.n<=p.size);}
 private async openPack(){
  const p=this.pack!;const root=await fs.realpath(this.options.dataDir),file=await fs.realpath(path.join(root,'thumbs.pack'));
  if(file!==p.file)throw new Error('Pack changed');
  const rel=path.relative(root,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Unsafe pack');
  const f=await fs.open(file,'r');try{const stat=await f.stat();if(!stat.isFile()||stat.size!==p.size)throw new Error('Pack changed');return f;}catch(e){await f.close();throw e;}
 }
 private identity(stat:{ino:number;mtimeMs:number;size:number}){return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;}
 private startPackCheck(){
  this.packState='checking';
  this.packCheck=(async()=>{
   try{
    const f=await this.openPack();
    try{const initial=await f.stat();this.packIdentity=this.identity(initial);const hash=createHash('sha256');let size=0;for await(const chunk of f.createReadStream({autoClose:false})){size+=chunk.length;hash.update(chunk);}this.packState=size===this.pack!.size&&hash.digest('hex')===this.pack!.sha256&&this.identity(await f.stat())===this.packIdentity?'valid':'invalid';this.packRetryAt=0;}
    finally{await f.close();}
   }catch{this.packState='invalid';this.packRetryAt=Date.now()+30000;}
  })();
 }
 private card(c:DiskCard):ImagePromptCard{const {thumb,...rest}=c;const hasThumb=this.image(c);return {...rest,hasThumb,...(hasThumb?{thumbW:thumb!.w,thumbH:thumb!.h}:{}),favorite:this.favorites.has(c.id)};}
 async meta():Promise<ImagePromptMeta>{await this.ready();const cards=[...this.records.values()].map(r=>r.card);const facets=(values:string[],labels:Record<string,string>)=>[...new Set(values)].sort().map(id=>({id,label:labels[id]??'其他',count:values.filter(v=>v===id).length}));return {...this.state,favorites:cards.filter(c=>this.favorites.has(c.id)).length,categories:facets(cards.map(c=>c.category),CATEGORY_LABELS) as ImagePromptMeta['categories'],models:facets(cards.flatMap(c=>c.models),MODEL_LABELS) as ImagePromptMeta['models'],langs:facets(cards.flatMap(c=>c.langs),LANG_LABELS) as ImagePromptMeta['langs']};}
 async query(input:unknown):Promise<ImagePromptPage>{const q=querySchema.parse(input);await this.ready();const term=q.q?.normalize('NFKC').toLowerCase();const sorted=[...this.records.values()].filter(r=>(!term||r.search.includes(term))&&(!q.category||r.card.category===q.category)&&(!q.model||r.card.models.includes(q.model))&&(!q.lang||r.card.langs.includes(q.lang))&&(!q.favoritesOnly||this.favorites.has(r.card.id))&&(!q.withImage||this.image(r.card))).sort((a,b)=>Number(b.card.featured)-Number(a.card.featured)||a.card.id.localeCompare(b.card.id));const rows=q.category?sorted:interleave(sorted);return {items:rows.slice(q.offset,q.offset+q.limit).map(r=>this.card(r.card)),total:rows.length,offset:q.offset,nextOffset:q.offset+q.limit<rows.length?q.offset+q.limit:null,dataset:this.state.dataset};}
 async get(input:unknown):Promise<ImagePromptDetail|null>{const id=idSchema.parse(input);await this.ready();const r=this.records.get(id);return r?structuredClone({...this.card(r.card),...r.body}):null;}
 async thumbs(input:unknown):Promise<Record<string,string>>{
  const ids=z.array(idSchema).max(24).parse(input);await this.ready();const out:Record<string,string>={};
  if(!this.pack)return out;
  if(this.packState!=='checking'){try{const stat=await fs.stat(this.pack.file),changed=this.packIdentity!==undefined&&this.identity(stat)!==this.packIdentity;if(changed||(this.packState==='invalid'&&this.packRetryAt>0&&Date.now()>=this.packRetryAt)){this.packState='idle';this.badThumbs.clear();}}catch{if(this.packState!=='invalid'){this.packState='invalid';this.packRetryAt=Date.now()+30000;}return out;}}
  if(this.packState==='invalid')return out;
  if(this.packState==='idle'){this.startPackCheck();return out;}
  if(this.packState!=='valid')return out;
  try{
   const f=await this.openPack();
   try{if(this.identity(await f.stat())!==this.packIdentity){this.startPackCheck();return out;}for(const id of ids){const c=this.records.get(id)?.card;if(!c||!this.image(c))continue;const t=c.thumb!,bytes=Buffer.alloc(t.n);let read=0;
    while(read<t.n){const r=await f.read(bytes,read,t.n-read,t.o+read);if(!r.bytesRead)break;read+=r.bytesRead;}
    if(read===t.n&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))out[id]='data:image/jpeg;base64,'+bytes.toString('base64');else this.badThumbs.add(id);
   }if(this.identity(await f.stat())!==this.packIdentity){this.startPackCheck();return {};}}finally{await f.close();}
  }catch{this.packState='invalid';this.packRetryAt=Date.now()+30000;return {};}
  return out;
 }
 async setFavorite(input:unknown,onInput:unknown):Promise<{id:string;favorite:boolean;count:number}>{const id=idSchema.parse(input),on=z.boolean().parse(onInput);await this.ready();if(on&&!this.records.has(id))throw new Error('Prompt not found');let result!:{id:string;favorite:boolean;count:number};const operation=this.saves.then(async()=>{const next=new Map(this.favorites);if(on){if(!next.has(id)&&next.size>=5000)throw new Error('Favorite limit reached');next.set(id,Date.now());}else next.delete(id);const file=path.join(this.options.userData,'image-prompts.json'),tmp=file+'.'+randomUUID()+'.tmp';await fs.mkdir(this.options.userData,{recursive:true});try{await fs.writeFile(tmp,JSON.stringify({version:1,favorites:[...next].map(([id,at])=>({id,at}))}),{flag:'wx',mode:0o600});if(this.favoritesNeedBackup){try{await fs.rename(file,file+'.bad-'+Date.now()+'-'+randomUUID());this.favoritesNeedBackup=false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;this.favoritesNeedBackup=false;}}await fs.rename(tmp,file);this.favorites=next;}finally{await fs.rm(tmp,{force:true});}result={id,favorite:on,count:[...next.keys()].filter(k=>this.records.has(k)).length};});this.saves=operation.catch(()=>{});await operation;return result;}
 async copyPrompt(input:unknown):Promise<{chars:number}>{const q=copySchema.parse(input);const r=await this.get(q.id);if(!r)throw new Error('Prompt not found');const v=q.lang?r.variants.find(v=>v.lang===q.lang):r.variants[0];if(!v)throw new Error('Language not found');if(q.step!==undefined&&!v.steps[q.step])throw new Error('Step not found');const text=q.step===undefined?v.steps.map(s=>s.text).join('\n\n'):v.steps[q.step].text;this.options.copy(text);return {chars:text.length};}
}
