import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
let sharp;
try { sharp=require('sharp'); }
catch { sharp=require(path.join(process.env.SIKEOOP_NODE_MODULES||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'),'sharp')); }
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(p.endsWith('.svg'))out.push(p);}return out;}
const checks=[];
for(const f of await walk(root)){
  if(f.endsWith('/sprite.svg'))continue;
  const meta=await sharp(f).metadata();
  const bytes=await sharp(f).resize({width:Math.min(meta.width,320),withoutEnlargement:true}).png().toBuffer();
  checks.push({file:path.relative(root,f),width:meta.width,height:meta.height,thumbnailBytes:bytes.length,status:'rendered'});
}
for(const state of ['welcome','options','installing','finish','error','cancel']){
  await sharp(path.join(root,'screens/installer-'+state+'.svg')).png().toFile(path.join(root,'previews/installer-'+state+'.png'));
}
for(const name of ['installer-effect','installer-flow-overview','components-overview']){
  await sharp(path.join(root,'previews/'+name+'.svg')).png().toFile(path.join(root,'previews/'+name+'.png'));
}
await sharp(path.join(root,'screens/installer-welcome.svg')).resize(2080,1320).png().toFile(path.join(root,'previews/installer-welcome@2x.png'));
await sharp(path.join(root,'components/checkbox-off.svg')).png().toFile(path.join(root,'previews/checkbox-alpha.png'));
await fs.writeFile(path.join(root,'render-checks.json'),JSON.stringify(checks,null,2)+'\n');
process.stdout.write(JSON.stringify({svgRendered:checks.length,failures:0})+'\n');
