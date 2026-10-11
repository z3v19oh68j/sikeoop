import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
let sharp;
try {sharp=require('sharp');}
catch {sharp=require(path.join(process.env.SIKEOOP_NODE_MODULES||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'),'sharp'));}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function files(dir){let result=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.name.endsWith('.svg'))result.push(p);}return result;}
const checks=[];
for(const p of await files(root)){
  if(p.endsWith('/icons/sprite.svg'))continue;
  const meta=await sharp(p).metadata();
  const buf=await sharp(p).resize({width:Math.min(meta.width||320,320),withoutEnlargement:true}).png().toBuffer();
  checks.push({file:path.relative(root,p),width:meta.width,height:meta.height,thumbnailBytes:buf.length,status:'rendered'});
}
for(const [s,d] of [['auto-update-card-on-canvas.svg','card-ready.png'],['illustrations/hero-eva-miku-paths.svg','header-paths.png'],['states/update-error.svg','card-error.png'],['states/update-downloading.svg','card-downloading.png'],['states/update-checking.svg','card-checking.png'],['states/update-installing.svg','card-installing.png'],['previews/asset-overview.svg','asset-overview.png'],['components/toggle-off.svg','toggle-off.png'],['components/button-primary-normal.svg','button-primary-normal.png']]){
  await sharp(path.join(root,s)).png().toFile(path.join(root,'previews',d));
}
await fs.writeFile(path.join(root,'render-checks.json'),JSON.stringify(checks,null,2)+'\n');
process.stdout.write(JSON.stringify({svgRendered:checks.length,failures:0})+'\n');
