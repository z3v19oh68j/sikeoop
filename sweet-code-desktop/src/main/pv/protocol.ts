import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { safePath } from "./store.ts";

export const PV_SCHEME = "sikeoop-pv";
const media:Record<string,string>={".mp4":"video/mp4",".webm":"video/webm",".mov":"video/quicktime",".m4v":"video/mp4",".mp3":"audio/mpeg",".wav":"audio/wav",".ogg":"audio/ogg",".m4a":"audio/mp4",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp"};
export async function previewPath(root:string,id:string,file:string):Promise<string>{
  if(!media[path.extname(file).toLowerCase()])throw new Error("仅允许媒体文件");
  const target=await safePath(root,id,"out/"+file);
  const real=await fs.realpath(target);
  if(real!==target)throw new Error("路径越界");
  if(!(await fs.stat(real)).isFile())throw new Error("不是媒体文件");
  return real;
}
export async function previewUrl(root:string,id:string,file:string):Promise<string>{
  await previewPath(root,id,file);
  return `${PV_SCHEME}://${id}/${file.split("/").map(encodeURIComponent).join("/")}`;
}
/** Pure handler, injected current workspace; no renderer-supplied filesystem root. */
export async function servePvMedia(request:Request,currentRoot:()=>string|null):Promise<Response>{
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response(null,{status:405,headers:{Allow:"GET, HEAD"}});
  const root=currentRoot();if(!root)return new Response(null,{status:404});
  let target:string;
  try{
    // Reject raw traversal before URL's dot-segment normalization hides it.
    const raw=request.url.match(/^sikeoop-pv:\/\/([^/?#]+)(\/[^?#]*)$/);
    if(!raw)throw Error("URL 无效");
    const id=raw[1],file=decodeURIComponent(raw[2].slice(1));
    target=await previewPath(root,id,file);
    if(currentRoot()!==root)throw Error("项目已切换");
  }catch(e){return new Response(null,{status:(e as NodeJS.ErrnoException).code==="ENOENT"?404:403});}
  let handle;
  try{handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch{return new Response(null,{status:403});}
  try{
    const st=await handle.stat();if(!st.isFile()||currentRoot()!==root){await handle.close();return new Response(null,{status:403});}
    let start=0,end=st.size-1,status=200;
    const headers:Record<string,string>={"Content-Type":media[path.extname(target).toLowerCase()],"Accept-Ranges":"bytes","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
    const range=request.headers.get("Range");
    if(range){
      const m=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(m&&(m[1]||m[2])){
        if(m[1]){start=Number(m[1]);if(m[2])end=Number(m[2]);}
        else {start=Math.max(0,st.size-Number(m[2]));}
      }else start=NaN;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=st.size){await handle.close();return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${st.size}`}});}
      end=Math.min(end,st.size-1);status=206;headers["Content-Range"]=`bytes ${start}-${end}/${st.size}`;
    }
    headers["Content-Length"]=String(Math.max(0,end-start+1));
    if(request.method==="HEAD"||st.size===0){await handle.close();return new Response(null,{status,headers});}
    const stream=handle.createReadStream({start,end,autoClose:true});
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status,headers});
  }catch(e){await handle.close();throw e;}
}
