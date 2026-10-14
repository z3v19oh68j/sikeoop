import { promises as fs } from "node:fs";
import path from "node:path";
import type { PvPack, PvKind, PvStep } from "../../shared/types.ts";
import { steps } from "./store.ts";
export async function loadPacks(dir:string):Promise<PvPack[]> {
  const out:PvPack[]=[];
  for(const kind of ["common","promo","music"] as const) for(const name of (await fs.readdir(path.join(dir,kind))).sort()) {
    if(!name.endsWith(".json")) continue;
    const p=JSON.parse(await fs.readFile(path.join(dir,kind,name),"utf8")) as PvPack;
    if(p.kind!==kind || typeof p.id!=="string" || typeof p.name!=="string" || !Array.isArray(p.entries) || p.entries.some(e=>typeof e.id!=="string" || typeof e.title!=="string" || typeof e.body!=="string" || !Array.isArray(e.steps) || e.steps.some(s=>!steps.includes(s)))) throw new Error("经验包格式错误");
    out.push(p);
  }
  return out;
}
export function packContext(packs:PvPack[],kind:PvKind,step:PvStep):string {
  return packs.filter(p=>p.kind==="common" || p.kind===kind).flatMap(p=>p.entries.filter(e=>e.steps.includes(step)).map(e=>`## ${e.title}\n${e.body}`)).join("\n\n");
}
