import { promises as fs } from "node:fs";
import path from "node:path";
import type { SkillStore } from "../plugins/skills.ts";
export async function installPvSkills(store:SkillStore,dir:string):Promise<void>{
  const pack=[];
  for(const name of ["pv-storyboard","remotion-pv","ffmpeg-recipes","pv-html-timeline","pv-audio-mix"]){
    // syncBuiltin has update logic; PV deliberately only installs absent names.
    if(await fs.lstat(store.dirOf(name)).then(()=>true, (e:NodeJS.ErrnoException)=>{if(e.code==="ENOENT")return false;throw e;})) continue;
    let markdown:Buffer;
    try{markdown=await fs.readFile(path.join(dir,name,"SKILL.md"));}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
    pack.push({name,files:new Map([["SKILL.md",markdown]])});
  }
  await store.syncBuiltin(pack);
}
