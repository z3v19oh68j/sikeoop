import { spawn } from "node:child_process";
import { runProcess } from "../papers/host.ts";
import type { RunProcess } from "../papers/quarto.ts";
/** CLI JS runs in Electron's embedded Node without modifying the parent's environment. */
export const runPvProcess:RunProcess=(bin,args,cwd,output,signal)=>{
  if(bin!==process.execPath) return runProcess(bin,args,cwd,output,signal);
  return new Promise((resolve,reject)=>{
    if(signal.aborted){resolve(-1);return;}
    const child=spawn(bin,args,{cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},shell:false,windowsHide:true,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
    const stop=()=>{
      if(process.platform==="win32" && child.pid) {
        spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{windowsHide:true}).on("error",()=>child.kill());
      } else if(child.pid) {try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}}
    };
    signal.addEventListener("abort",stop,{once:true});
    child.stdout.on("data",b=>output(b.toString()));child.stderr.on("data",b=>output(b.toString()));
    const end=()=>signal.removeEventListener("abort",stop);
    child.on("error",e=>{end();reject(e);});child.on("close",code=>{end();resolve(code??-1);});
  });
};
