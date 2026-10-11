import { previewUrl } from "./protocol.ts";
import type { PvService } from "./service.ts";
import type { FfmpegService } from "./ffmpeg.ts";
import type { PvProject, PvStep } from "../../shared/types.ts";
type Handle=(channel:string,handler:(_event:unknown,...args:any[])=>unknown)=>void;
export function registerPvIpc(handle:Handle,pv:PvService,ffmpeg:FfmpegService){
  const checked=(fn:(root:string,...args:any[])=>unknown)=>async(root:string,...args:any[])=>{await pv.check(root);return fn(root,...args);};
  const methods:Record<string,(...args:any[])=>unknown>={
    list:checked(root=>pv.store.list(root)),create:checked((root,input:Pick<PvProject,"name"|"kind"|"ratio"|"seconds">)=>pv.store.create(root,input)),
    get:checked((root,id)=>pv.store.get(root,id)),runStep:(root,id,step:PvStep,note)=>pv.runStep(root,id,step,note),cancel:(root,id)=>pv.cancel(root,id),
    readFile:checked((root,id,file)=>pv.store.read(root,id,file)),
    writeFile:checked(async(root,id,file,text)=>{if(file==="project.json")throw new Error("项目元数据不可直接改写");if(file==="storyboard.json")return pv.store.saveStoryboard(root,id,text);await pv.store.write(root,id,file,text);}),
    storyboard:checked((root,id)=>pv.store.storyboard(root,id)),saveStoryboard:checked((root,id,sb)=>pv.store.saveStoryboard(root,id,sb)),
    previewUrl:checked((root,id,file)=>previewUrl(root,id,file)),
    packs:()=>pv.packs(),ffmpeg:()=>ffmpeg.state(),ffmpegDownload:()=>ffmpeg.download(),renderPreview:(root,id)=>pv.renderPreview(root,id)
  };
  for(const [name,fn] of Object.entries(methods))handle("pv:"+name,async(_e,...args)=>{await pv.check((args[0] && typeof args[0]==="string" && !["packs","ffmpeg","ffmpegDownload"].includes(name))?args[0]:pv.currentRoot());return fn(...args);});
}
