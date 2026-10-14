import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardSchema,manifestSchema } from '../../src/main/image-prompts/schema.ts';
import { sha } from './dedupe.ts';
import { policyHash,policyViolations } from './policy.ts';
const base=path.dirname(fileURLToPath(import.meta.url));
export async function checkRelease(dir=path.resolve(base,'../../resources/image-prompts'),maxPackBytes=60*1024*1024):Promise<void>{
 const manifest=manifestSchema.parse(JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8')));
 if(manifest.profile!=='release')throw new Error('manifest.profile 必须是 release');
 if(manifest.policyHash!==await policyHash())throw new Error('发布清单 policyHash 不匹配');
 for(const name of ['index.json','bodies.json','thumbs.pack'] as const){const b=await fs.readFile(path.join(dir,name));if(b.length!==manifest.files[name].bytes||sha(b)!==manifest.files[name].sha256)throw new Error(name+' 大小或 sha256 不匹配');}
 const allowed=new Set(['manifest.json','index.json','bodies.json','thumbs.pack','NOTICE.md','.gitignore']);const extra=(await fs.readdir(dir)).filter(n=>!allowed.has(n));if(extra.length)throw new Error('发布目录不能包含 '+extra.join(', '));
 const cards=JSON.parse(await fs.readFile(path.join(dir,'index.json'),'utf8')).map((r:unknown)=>cardSchema.parse(r));const errors=policyViolations(cards,JSON.parse(await fs.readFile(path.join(base,'release-policy.json'),'utf8')));if(errors.length)throw new Error('发布内容不符合清单 ('+errors.length+'):\n'+errors.slice(0,20).join('\n'));
 if(manifest.files['thumbs.pack'].bytes>maxPackBytes)throw new Error('thumbs.pack 超过 60 MB');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await checkRelease(process.argv[2]?path.resolve(base,'../..',process.argv[2]):undefined);console.log('发布数据校验通过');}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
}
