import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PvFfmpegState } from "../../shared/types.ts";
import { downloadTo, getJson, sha256File, type HttpRequest } from "../papers/net-download.ts";
import { extractZip, extractTarGz } from "../papers/archive.ts";
import type { RunProcess } from "../papers/quarto.ts";
const hosts=["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"];
export interface FfmpegPlan { url:string; sha256:string; size:number; archive:"zip"|"tar.gz"; binary:string }
export interface SystemFfmpegFs { stat(file:string):Promise<{isFile():boolean}>; access(file:string,mode:number):Promise<void> }
export async function probeSystemFfmpeg(platform:string,envPath:string,files:SystemFfmpegFs=fs):Promise<PvFfmpegState> {
  const dirs=[...envPath.split(path.delimiter).filter(Boolean),"/opt/homebrew/bin","/usr/local/bin","/usr/bin"];
  for(const dir of new Set(dirs)){
    if(!path.isAbsolute(dir)) continue;
    const file=path.join(dir,"ffmpeg");
    try {if(!(await files.stat(file)).isFile())continue;await files.access(file,constants.X_OK);return {status:"ready",path:file};}catch {}
  }
  return {status:"missing",hint:platform==="darwin"?"请运行 brew install ffmpeg 安装 ffmpeg":"请使用发行版包管理器安装 ffmpeg（例如 apt install ffmpeg、dnf install ffmpeg）"};
}
export interface FfmpegDeps { platform?:string; envPath?:string; systemFs?:SystemFfmpegFs; userData:string; request:HttpRequest; run:RunProcess; approve(plan:FfmpegPlan):Promise<boolean>; plan():Promise<FfmpegPlan> }
export async function githubPlan(request:HttpRequest,platform:string,arch:string):Promise<FfmpegPlan> {
  // BtbN's LGPL-only builds; other platforms fail closed, never silently install GPL.
  if (!["win32","linux"].includes(platform) || arch!=="x64") throw new Error("当前平台暂无已配置的 LGPL ffmpeg 下载源（支持 Windows/Linux x64）");
  const release=await getJson(request,"https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest",["api.github.com"]) as {assets?:{name:string;browser_download_url:string;digest?:string;size:number}[]};
  const suffix=platform==="win32"?"win64-lgpl.zip":"linux64-lgpl.tar.xz";
  // Archive helper supports gzip/zip, not xz: do not pretend the Linux archive is gzip.
  if(platform==="linux") throw new Error("Linux LGPL 发布包为 tar.xz，第一批尚未支持解包");
  const asset=release.assets?.find(a=>a.name.endsWith(suffix) && !a.name.includes("shared"));
  if(!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest??"")) throw new Error("发布包没有可信 SHA-256，未下载");
  const folder=asset.name.replace(/\.zip$/,"");
  return {url:asset.browser_download_url,sha256:asset.digest!.slice(7),size:asset.size,archive:"zip",binary:folder+"/bin/ffmpeg.exe"};
}
export class FfmpegService {
  private deps:FfmpegDeps;
  private current:PvFfmpegState={status:"missing"};
  private pending?:Promise<PvFfmpegState>;
  constructor(deps:FfmpegDeps){this.deps=deps;}
  private platform(){return this.deps.platform??process.platform;}
  private bin(){return path.join(this.deps.userData,"tools","ffmpeg","installed",this.platform()==="win32"?"ffmpeg.exe":"ffmpeg");}
  async state():Promise<PvFfmpegState>{
    if(this.platform()!=="win32") return probeSystemFfmpeg(this.platform(),this.deps.envPath??process.env.PATH??"",this.deps.systemFs);
    if(this.current.status==="downloading") return {...this.current};
    try {const record=JSON.parse(await fs.readFile(this.bin()+".json","utf8")) as {sha256:string};
      if(await sha256File(this.bin())===record.sha256) this.current={status:"ready",path:this.bin()};
      else this.current={status:"error",error:"已安装 ffmpeg 校验失败"};
    } catch { if(this.current.status!=="error") this.current={status:"missing"}; }
    return {...this.current};
  }
  download():Promise<PvFfmpegState>{
    if(this.platform()!=="win32") return this.state();
    if(this.pending) return this.pending;
    this.pending=this.install().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async install():Promise<PvFfmpegState>{
    const staging=path.join(this.deps.userData,"tools","ffmpeg",".staging-"+randomUUID());
    try {
      if((await this.state()).status==="ready") return this.state();
      const plan=await this.deps.plan();
      if(!/^[a-f0-9]{64}$/.test(plan.sha256) || !Number.isSafeInteger(plan.size) || plan.size<=0 || plan.size>512*1024*1024) throw new Error("下载校验信息无效");
      if(!await this.deps.approve(plan)) throw new Error("下载未批准");
      this.current={status:"downloading",progress:0};
      await fs.mkdir(staging,{recursive:true});
      const part=path.join(staging,"archive");
      const signal=AbortSignal.timeout(15*60_000);
      await downloadTo({request:this.deps.request,url:plan.url,hosts,part,total:plan.size,signal,progress:(n,t)=>{this.current={status:"downloading",progress:t?n/t:0};}});
      if(await sha256File(part)!==plan.sha256) throw new Error("SHA-256 校验失败，已删除下载");
      const unpack=path.join(staging,"unpack");await fs.mkdir(unpack);
      await (plan.archive==="zip"?extractZip(part,unpack,{signal,windows:this.platform()==="win32"}):extractTarGz(part,unpack,{signal,windows:false}));
      if(path.isAbsolute(plan.binary) || plan.binary.split(/[\\/]/).some(s=>s===".." || !s)) throw new Error("程序路径无效");
      const bin=path.join(unpack,plan.binary);await fs.chmod(bin,0o755);
      let output="";if(await this.deps.run(bin,["-version"],unpack,t=>{output+=t;},signal)!==0 || !/^ffmpeg version /m.test(output)) throw new Error("ffmpeg 运行检查失败");
      const dest=this.bin();await fs.mkdir(path.dirname(dest),{recursive:true});
      const sha256=await sha256File(bin);await fs.rename(bin,dest);await fs.writeFile(dest+".json",JSON.stringify({sha256}));
      this.current={status:"ready",path:dest};
    } catch(e){this.current={status:"error",error:e instanceof Error?e.message:String(e)};}
    finally {await fs.rm(staging,{recursive:true,force:true});}
    return {...this.current};
  }
}
