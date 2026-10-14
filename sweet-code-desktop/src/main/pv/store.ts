import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PvProject, PvStoryboard, PvShot, PvStep } from "../../shared/types.ts";

export const steps = ["brief", "script", "storyboard", "beats", "assets", "compose", "render"] as const;
export async function safePath(root: string, id: string, file: string): Promise<string> {
  if (typeof id !== "string" || typeof file !== "string" || !/^[a-zA-Z0-9-]+$/.test(id) || !file || file.includes("\\") || file.includes("\0") || path.isAbsolute(file) || file.split("/").some(s => !s || s === "." || s === "..")) throw new Error("路径越界");
  const base = await fs.realpath(root);
  const parts = ["pv", id, ...file.split("/")];
  let at = base;
  for (const part of parts) {
    at = path.join(at, part);
    try { const st = await fs.lstat(at); if (st.isSymbolicLink()) throw new Error("路径越界：不允许符号链接"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return at;
}
export function parseStoryboard(input: unknown): PvStoryboard {
  let value: unknown = input;
  if (typeof input === "string") {
    const text = input.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
    try { value = JSON.parse(text); } catch {
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      try { value = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("分镜不是有效 JSON"); }
    }
  }
  const shots = Array.isArray(value) ? value : (value as PvStoryboard | null)?.shots;
  if (!Array.isArray(shots) || shots.length > 500) throw new Error("分镜需要 shots 数组（最多 500）");
  const ids = new Set<string>();
  return { shots: shots.map((raw: unknown, i: number) => {
    if (!raw || typeof raw !== "object") throw new Error("镜头格式错误");
    const s = raw as PvShot;
    const id = s.id ?? `shot-${i + 1}`;
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error("镜头 ID 重复或为空");
    ids.add(id);
    if (!Number.isFinite(s.seconds) || s.seconds <= 0 || s.seconds > 3600) throw new Error("镜头时长无效");
    for (const key of ["framing", "camera", "visual"] as const) if (typeof s[key] !== "string") throw new Error("镜头字段缺失");
    const source = s.source ?? "code";
    if (!["code", "file", "screen", "ai"].includes(source)) throw new Error("素材来源无效");
    for (const key of ["caption", "transition", "asset"] as const) if (s[key] !== undefined && typeof s[key] !== "string") throw new Error("镜头可选字段无效");
    return { id, seconds: s.seconds, framing: s.framing, camera: s.camera, visual: s.visual, source, ...(s.caption !== undefined ? {caption:s.caption} : {}), ...(s.transition !== undefined ? {transition:s.transition} : {}), ...(s.asset !== undefined ? {asset:s.asset} : {}) };
  }) };
}
export class PvStore {
  private readonly isActive: (dir: string, step: PvStep) => boolean;
  private readonly loading = new Map<string, Promise<PvProject | null>>();
  constructor(isActive: (dir: string, step: PvStep) => boolean = () => false) { this.isActive = isActive; }
  async read(root: string, id: string, file: string): Promise<string> {
    const p = await safePath(root,id,file);
    const handle = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await handle.stat()).size > 4*1024*1024) throw new Error("文件超过 4 MB"); return await handle.readFile("utf8"); } finally { await handle.close(); }
  }
  async write(root: string, id: string, file: string, text: string): Promise<void> {
    if (typeof text !== "string" || Buffer.byteLength(text) > 4*1024*1024) throw new Error("文件超过 4 MB");
    let p = await safePath(root,id,file);
    await fs.mkdir(path.dirname(p), {recursive:true});
    p = await safePath(root,id,file);
    const tmp = path.join(path.dirname(p), `.${randomUUID()}.tmp`);
    try { await fs.writeFile(tmp,text,{flag:"wx"}); await safePath(root,id,file); await fs.rename(tmp,p); }
    finally { await fs.rm(tmp,{force:true}); }
  }
  async get(root: string,id: string): Promise<PvProject | null> {
    const file = await safePath(root,id,"project.json");
    // Concurrent first reads share recovery, so a late startup rewrite cannot clobber a new job.
    const existing = this.loading.get(file);
    if (existing) return structuredClone(await existing);
    const pending = this.loadProject(root,id,file);
    this.loading.set(file,pending);
    try { return structuredClone(await pending); }
    finally { if(this.loading.get(file)===pending)this.loading.delete(file); }
  }
  private async loadProject(root: string,id: string,file: string): Promise<PvProject | null> {
    try {
      const p = JSON.parse(await this.read(root,id,"project.json")) as PvProject;
      if (p.id !== id || !steps.every(s => ["todo","running","done","error"].includes(p.steps?.[s]))) throw new Error("项目数据损坏");
      p.dir = path.dirname(file);
      let recovered = false;
      for(const step of steps)if(p.steps[step]==="running" && !this.isActive(p.dir,step)){
        p.steps[step]="todo";recovered=true;
      }
      if(recovered){p.updatedAt=Date.now();await this.write(root,id,"project.json",JSON.stringify(p,null,2));}
      return p;
    }
    catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async list(root: string): Promise<PvProject[]> {
    // Validate pv itself before reading its children.
    await safePath(root,"probe","project.json");
    const names = await fs.readdir(path.join(await fs.realpath(root),"pv")).catch((e: NodeJS.ErrnoException) => {if(e.code==="ENOENT") return []; throw e;});
    const out: PvProject[] = [];
    for (const id of names) { if (!/^[a-zA-Z0-9-]+$/.test(id)) continue; const p = await this.get(root,id); if(p) out.push(p); }
    return out.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  async create(root: string, input: Pick<PvProject,"name"|"kind"|"ratio"|"seconds">): Promise<PvProject> {
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length>200 || !["promo","music"].includes(input.kind) || !["16:9","9:16","1:1"].includes(input.ratio) || !Number.isFinite(input.seconds) || input.seconds<=0 || input.seconds>3600) throw new Error("项目参数无效");
    const id=randomUUID(); const dir=path.dirname(await safePath(root,id,"project.json"));
    const p: PvProject={...input,name:input.name.trim(),id,dir,steps:Object.fromEntries(steps.map(s=>[s,"todo"])) as PvProject["steps"],updatedAt:Date.now()};
    await this.write(root,id,"project.json",JSON.stringify(p,null,2));
    for(const [file,text] of [["brief.md",""],["script.md",""],["storyboard.json",'{"shots":[]}']]) await this.write(root,id,file,text);
    await fs.mkdir(await safePath(root,id,"out"),{recursive:true});
    await fs.mkdir(await safePath(root,id,"assets"),{recursive:true});
    await fs.mkdir(await safePath(root,id,"remotion"),{recursive:true});
    return p;
  }
  async storyboard(root:string,id:string):Promise<PvStoryboard> {return parseStoryboard(await this.read(root,id,"storyboard.json"));}
  async saveStoryboard(root:string,id:string,sb:unknown):Promise<void> {await this.write(root,id,"storyboard.json",JSON.stringify(parseStoryboard(sb),null,2));}
}
