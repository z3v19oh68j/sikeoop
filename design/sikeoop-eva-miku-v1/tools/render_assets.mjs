import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const require=createRequire(import.meta.url);
let sharp;
try { sharp=require('sharp'); }
catch {
  const modules=process.env.SIKEOOP_NODE_MODULES || path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  sharp=require(path.join(modules,'sharp'));
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const targets=[
  ['svg/theme-vector-layered.svg','images/theme-vector-preview.png',1920],
  ['svg/ui-skin-layered.svg','images/ui-layered-preview.png',1920],
  ['svg/ui-skin-vector-only.svg','images/ui-vector-preview.png',1920],
  ['svg/icon-contact-sheet.svg','images/icon-contact-sheet.png',1600],
  ['icons/brand/app-icon.svg','images/app-icon-1024.png',1024],
];
for (const [source,dest,width] of targets) {
  await sharp(path.join(root,source)).resize({width}).png().toFile(path.join(root,dest));
  process.stdout.write(`${dest}\n`);
}
const iconset=path.join(root,'icons/app/sikeoop-eva-miku.iconset');
await fs.mkdir(iconset,{recursive:true});
for (const logical of [16,32,128,256,512]) {
  for (const scale of [1,2]) {
    const filename=`icon_${logical}x${logical}${scale===2?'@2x':''}.png`;
    await sharp(path.join(root,'icons/brand/app-icon.svg')).resize(logical*scale,logical*scale).png().toFile(path.join(iconset,filename));
  }
}
