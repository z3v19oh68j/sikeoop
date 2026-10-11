import {test} from "node:test";
import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {PvStore,parseStoryboard,safePath} from "../../src/main/pv/store.ts";
import {loadPacks,packContext} from "../../src/main/pv/packs.ts";
import {FfmpegService} from "../../src/main/pv/ffmpeg.ts";
import {PvService} from "../../src/main/pv/service.ts";
import {Dispatcher} from "../../src/main/dispatch/scheduler.ts";
import {remotionTemplate} from "../../src/main/pv/template.ts";
const shot={id:"one",seconds:5,framing:"中景",camera:"固定",visual:"标题",source:"code"};
async function temp(fn:(root:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),"pv-test-"));try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
test("分镜兼容围栏、说明和数组，缺省 source/id",()=>{
  assert.equal(parseStoryboard("说明\n"+JSON.stringify({shots:[shot]})+"\n结束").shots.length,1);
  assert.equal(parseStoryboard("```json\n"+JSON.stringify({shots:[shot]})+"\n```").shots[0].id,"one");
  assert.equal(parseStoryboard([{seconds:1,framing:"",camera:"",visual:""}]).shots[0].source,"code");
});
test("分镜拒绝无效 JSON、时长、重复 ID 和来源",()=>{
  for(const input of ["bad",{shots:[{...shot,seconds:0}]},{shots:[shot,shot]},{shots:[{...shot,source:"remote"}]},{shots:[{...shot,caption:3}]}])assert.throws(()=>parseStoryboard(input));
});
test("项目创建、列举、更新、分镜读写",()=>temp(async root=>{
  const store=new PvStore();const p=await store.create(root,{name:"sikeoop",kind:"promo",ratio:"16:9",seconds:30});
  assert.equal((await store.list(root))[0].id,p.id);assert.equal((await store.get(root,p.id))?.dir,p.dir);
  await store.saveStoryboard(root,p.id,{shots:[shot]});assert.equal((await store.storyboard(root,p.id)).shots.length,1);
  await store.write(root,p.id,"brief.md","中文");assert.equal(await store.read(root,p.id,"brief.md"),"中文");
  assert.equal(await store.get(root,"missing"),null);
}));
test("路径越界和符号链接拒绝",()=>temp(async root=>{
  for(const [id,file] of [["..","a"],["id","../a"],["id","/tmp/a"],["id","a\\b"],["id","a/../../b"]])await assert.rejects(safePath(root,id,file),/路径越界/);
  await fs.mkdir(path.join(root,"pv","id"),{recursive:true});
  await fs.symlink(os.tmpdir(),path.join(root,"pv","id","escape"));
  await assert.rejects(safePath(root,"id","escape/out"),/符号链接/);
  await fs.symlink(os.tmpdir(),path.join(root,"pv","id","file"));
  await assert.rejects(new PvStore().write(root,"id","file","x"),/符号链接/);
}));
test("经验包按类型和步骤筛选",async()=>{
  const packs=await loadPacks(path.resolve("resources/pv-packs"));
  assert.equal(packs.length,5);
  assert.match(packContext(packs,"promo","brief"),/痛点/);
  assert.doesNotMatch(packContext(packs,"music","brief"),/sikeoop/);
  assert.doesNotMatch(packContext(packs,"promo","assets"),/镜头/);
});
test("ffmpeg 校验失败清理且不执行、不发布",()=>temp(async root=>{
  let runs=0,requests=0,approved=0;
  const service=new FfmpegService({userData:root,platform:"win32",request:async()=>{requests++;return new Response("bad",{headers:{"content-length":"3"}});},run:async()=>{runs++;return 0;},approve:async()=>{approved++;return true;},plan:async()=>({url:"https://github.com/test/archive.zip",sha256:"a".repeat(64),size:3,archive:"zip",binary:"ffmpeg"})});
  const state=await service.download();assert.equal(state.status,"error");assert.match(state.error!,/SHA-256/);
  assert.equal(runs,0);assert.equal(requests,1);assert.equal(approved,1);
  assert.deepEqual(await fs.readdir(path.join(root,"tools","ffmpeg")),[]);
}));
test("ffmpeg 审批拒绝不请求下载",()=>temp(async root=>{
  let requests=0;
  const service=new FfmpegService({userData:root,platform:"win32",request:async()=>{requests++;return new Response("");},run:async()=>0,approve:async()=>false,plan:async()=>({url:"https://github.com/test.zip",sha256:"a".repeat(64),size:3,archive:"zip",binary:"ffmpeg"})});
  assert.equal((await service.download()).status,"error");assert.equal(requests,0);
}));
test("ffmpeg 没有摘要不进入审批或下载",()=>temp(async root=>{
  const service=new FfmpegService({userData:root,platform:"win32",request:async()=>{throw Error("不应请求");},run:async()=>0,approve:async()=>{throw Error("不应审批");},plan:async()=>({url:"https://github.com/test.zip",sha256:"",size:3,archive:"zip",binary:"ffmpeg"})});
  assert.match((await service.download()).error!,/校验信息/);
}));
test("Remotion 模板比例、总帧数和项目依赖",()=>temp(async root=>{
 const p=await new PvStore().create(root,{name:"test",kind:"promo",ratio:"9:16",seconds:5});
 const files=remotionTemplate(p,parseStoryboard({shots:[shot]}));
 assert.match(files["src/index.tsx"],/width=\{1080\} height=\{1920\}/);
 assert.match(files["src/index.tsx"],/durationInFrames=\{150\}/);
 assert.ok(JSON.parse(files["package.json"]).dependencies.remotion);
}));
test("模型步骤调度、产物和树归属，第二批明确拒绝",()=>temp(async root=>{
 const dispatcher=new Dispatcher({emit:()=>{}});
 const events:any[]=[];
 const ffmpeg=new FfmpegService({userData:root,platform:"win32",request:async()=>new Response(""),run:async()=>0,approve:async()=>false,plan:async()=>{throw Error("不用下载");}});
 const pv=new PvService({root:()=>root,development:()=>true,packsDir:path.resolve("resources/pv-packs"),dispatcher,ffmpeg,model:async()=>"立项说明",compose:async()=>"done",run:async()=>0,emit:e=>events.push(e)});
 const p=await pv.store.create(root,{name:"test",kind:"promo",ratio:"16:9",seconds:5});
 const id=await pv.runStep(root,p.id,"brief");
 const wait=async()=>{for(let i=0;i<100;i++){if((await pv.store.get(root,p.id))?.steps.brief==="done")return;await new Promise(r=>setTimeout(r,10));}throw Error("未完成");};
 await wait();assert.equal(await pv.store.read(root,p.id,"brief.md"),"立项说明");assert.ok(events.some(e=>e.status==="done"));
 const second=await pv.runStep(root,p.id,"script");
 assert.equal(dispatcher.jobs().find(j=>j.id===second)?.rootId,id);
 await assert.rejects(pv.runStep(root,p.id,"beats"),/第二批/);
 await pv.cancel(root,p.id);
 // Let completion persistence finish before fixture removal.
 await new Promise(r=>setTimeout(r,30));
}));
test("开发开关和工作区边界",()=>temp(async root=>{
 const deps:any={root:()=>root,development:()=>false};
 await assert.rejects(new PvService(deps).check(root),/开发版/);
 deps.development=()=>true;
 await assert.rejects(new PvService(deps).check(os.tmpdir()),/当前项目/);
}));

test("系统 ffmpeg 探测 PATH、固定位置与不可执行文件，缺失提示且绝不下载",async()=>{
  const {probeSystemFfmpeg}=await import("../../src/main/pv/ffmpeg.ts");
  const visited:string[]=[];
  const fake={stat:async(file:string)=>{visited.push(file);return {isFile:()=>true};},access:async(file:string)=>{if(file!=="/opt/homebrew/bin/ffmpeg")throw Error("not executable");}};
  assert.deepEqual(await probeSystemFfmpeg("darwin","relative:/custom/bin",fake),{status:"ready",path:"/opt/homebrew/bin/ffmpeg"});
  assert.deepEqual(visited,["/custom/bin/ffmpeg","/opt/homebrew/bin/ffmpeg"]);
  const missing={stat:async()=>{throw Error("missing");},access:async()=>{}};
  assert.match((await probeSystemFfmpeg("darwin","",missing)).hint!,/brew install ffmpeg/);
  for(const platform of ["darwin","linux"]){
    const service=new FfmpegService({platform,envPath:"",systemFs:missing,userData:"/unused",request:async()=>{throw Error("network");},run:async()=>{throw Error("run");},approve:async()=>{throw Error("approve");},plan:async()=>{throw Error("plan");}});
    const state=await service.download();assert.equal(state.status,"missing");assert.ok(state.hint);
  }
});
test("PV 媒体协议只读、Range、HEAD、路径越界与符号链接拒绝",()=>temp(async root=>{
  const {servePvMedia,previewUrl}=await import("../../src/main/pv/protocol.ts");
  await fs.mkdir(path.join(root,"pv","id","out"),{recursive:true});
  await fs.writeFile(path.join(root,"pv","id","out","preview.mp4"),"0123456789");
  const url=await previewUrl(root,"id","preview.mp4");assert.equal(url,"sikeoop-pv://id/preview.mp4");
  const get=(url:string,init?:RequestInit)=>servePvMedia(new Request(url,init),()=>root);
  let res=await get(url,{headers:{Range:"bytes=2-5"}});assert.equal(res.status,206);assert.equal(res.headers.get("content-range"),"bytes 2-5/10");assert.equal(await res.text(),"2345");
  res=await get(url,{headers:{Range:"bytes=-3"}});assert.equal(await res.text(),"789");
  assert.equal((await get(url,{headers:{Range:"bytes=20-"}})).status,416);
  res=await get(url,{method:"HEAD"});assert.equal(res.headers.get("content-length"),"10");assert.equal(await res.text(),"");
  assert.equal((await get(url,{method:"POST"})).status,405);
  assert.equal((await servePvMedia(new Request(url),()=>null)).status,404);
  for(const file of ["%2e%2e%2fsecret.mp4","%2fetc%2fpasswd.mp4","bad%5cfile.mp4","project.json","%00.mp4"]){assert.equal((await get("sikeoop-pv://id/"+file)).status,403);}
  await fs.symlink(path.join(root,"pv","id","out","preview.mp4"),path.join(root,"pv","id","out","link.mp4"));
  assert.equal((await get("sikeoop-pv://id/link.mp4")).status,403);
  await fs.symlink(os.tmpdir(),path.join(root,"pv","id","out","escape"));
  assert.equal((await get("sikeoop-pv://id/escape/file.mp4")).status,403);
}));
