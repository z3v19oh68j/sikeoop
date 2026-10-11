import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserFlowStore,cleanStep,cleanSelector,expandStep,substitute,replayFlow,SelectorFailure} from '../../src/main/browser/flows.ts';
import {BrowserFlowRecording} from '../../src/main/browser/recording.ts';
import {executeFlowAction} from '../../src/main/browser/flow-actions.ts';
import {BrowserAutomation} from '../../src/main/browser/automation.ts';
import {CdpRecorder} from '../../src/main/browser/cdp/recorder.ts';
import {CdpSession} from '../../src/main/browser/cdp/session.ts';
import {CdpPage} from '../../src/main/browser/cdp/page.ts';
import {parseBrowserFlowNode} from '../../src/main/automation/browser-flow.ts';
import type {BrowserFlow, BrowserFlowStep} from '../../src/shared/types.ts';

const tick=()=>new Promise<void>(r=>setImmediate(r));
const fixture=new URL('../fixtures/browser-pages/form.html',import.meta.url);
function flow(steps:BrowserFlowStep[]):BrowserFlow {return {version:1,name:'测试流程',createdAt:1,updatedAt:1,steps,history:[]};}
async function project(t:{after:(fn:()=>Promise<void>)=>void}) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'browser-flows-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,store:new BrowserFlowStore(()=>root)};}
class Fake extends EventEmitter {
  attached=false;
  calls:{method:string;params:any;sid?:string}[]=[];
  nodes=[{backendDOMNodeId:2,role:{value:'textbox'},name:{value:'姓名'}},{backendDOMNodeId:3,role:{value:'textbox'},name:{value:'邮箱'}},{backendDOMNodeId:4,role:{value:'button'},name:{value:'提交'}}];
  dom={backendNodeId:1,nodeName:'#document',children:[{backendNodeId:2,nodeName:'INPUT'},{backendNodeId:3,nodeName:'INPUT'},{backendNodeId:4,nodeName:'BUTTON'}]};
  names:Record<number,{css:string;text:string}>={2:{css:'#name',text:''},3:{css:'#email',text:''},4:{css:'#submit-btn',text:'提交'}};
  isAttached(){return this.attached;}
  attach(){this.attached=true;}
  detach(){this.attached=false;this.emit('detach');}
  async sendCommand(method:string,params?:any,sid?:string):Promise<any>{
    this.calls.push({method,params,sid});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:10};
    if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'source'};
    if(method==='DOM.getDocument')return {root:this.dom};
    if(method==='Accessibility.getFullAXTree')return {nodes:this.nodes};
    if(method==='DOM.resolveNode')return {object:{objectId:String(params.backendNodeId)}};
    if(method==='Runtime.callFunctionOn'){
      const data=this.names[Number(params.objectId)];
      if(params.functionDeclaration.includes('ownerDocument.URL'))return {result:{value:'http://localhost/form.html'}};
      const [css,text]=params.arguments.map((a:any)=>a.value);return {result:{value:(!css||css===data?.css)&&(!text||text===data?.text)}};
    }
    return {};
  }
  event(method:string,params:any){this.emit('message',{},method,params);}
}

test('fixture form accessible roles/names take priority over contradictory CSS; fallback CSS then text',async()=>{
  const html=await fs.readFile(fixture,'utf8');assert.match(html,/<label for="name">姓名/);assert.match(html,/id="submit-btn">提交/);
  const fake=new Fake(),session=new CdpSession(fake),page=new CdpPage(session);
  const ref=await page.resolveFlowSelector({role:'textbox',name:'姓名',css:'#email'});assert.equal(page.refs.get(ref),2);
  assert.equal(page.refs.get(await page.resolveFlowSelector({role:'textbox',name:'旧邮箱',css:'#email'})),3);
  assert.equal(page.refs.get(await page.resolveFlowSelector({css:'#gone',text:'提交'})),4);
  assert.equal(fake.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);session.dispose();
});
test('ambiguous selector fails instead of guessing; CSS disambiguates a duplicated role/name',async()=>{
  const fake=new Fake();fake.nodes[1].name.value='姓名';const session=new CdpSession(fake),page=new CdpPage(session);
  await assert.rejects(page.resolveFlowSelector({role:'textbox',name:'姓名'}),SelectorFailure);
  assert.equal(page.refs.get(await page.resolveFlowSelector({role:'textbox',name:'姓名',css:'#email'})),3);
  await assert.rejects(page.resolveFlowSelector({css:'#missing'}),/元素不存在/);session.dispose();
});
test('parameterization is default, distinct per field; continuous input coalesces without storing values',()=>{
  const r=new BrowserFlowRecording('form');r.add({action:'fill',selector:{css:'#name'},text:'王'});r.add({action:'fill',selector:{css:'#name'},text:'王小明'});r.add({action:'fill',selector:{css:'#email'},text:'private@example.com'});
  assert.equal(r.flow.steps.length,2);assert.deepEqual(r.flow.steps.map(s=>s.text),['{value1}','{value2}']);assert.ok(!JSON.stringify(r.flow).includes('private'));
  const raw=new BrowserFlowRecording('raw','record');raw.add({action:'fill',selector:{css:'#name'},text:'一'});raw.add({action:'fill',selector:{css:'#name'},text:'一二'});assert.equal(raw.flow.steps[0].text,'一二');
});
test('passwords are removed twice and never reach disk, even with malicious extra fields',async t=>{
  const html=await fs.readFile(fixture,'utf8');assert.match(html,/id="pwd"[^>]*type="password"/);
  const {root,store}=await project(t);const r=new BrowserFlowRecording('测试流程','record');r.add({action:'fill',selector:{css:'#pwd'},password:true,text:'SECRET',key:'S',files:['SECRET']} as BrowserFlowStep);
  r.flow.steps[0]={...r.flow.steps[0],text:'SECRET',value:'SECRET',args:{password:'SECRET'}} as BrowserFlowStep;
  await store.save(r.flow,true);const disk=await fs.readFile(path.join(root,'.sikeoop/browser-flows/测试流程.json'),'utf8');assert.ok(!disk.includes('SECRET'));assert.match(disk,/填写密码字段/);assert.equal((await store.load('测试流程')).steps[0].text,undefined);
});
test('variables expand fields and URLs; missing/inherited variables fail; password variables never expand',()=>{
  const step=expandStep({action:'fill',selector:{role:'textbox',name:'{label}'},text:'你好 {who}'},{label:'姓名',who:'世界'});assert.equal(step.text,'你好 世界');assert.equal(step.selector?.name,'姓名');
  assert.equal(expandStep({action:'navigate',url:'http://localhost/{page}'},{page:'form.html'}).url,'http://localhost/form.html');
  assert.throws(()=>substitute('{toString}',{}),/缺少/);assert.throws(()=>substitute('{__proto__}',{}),/缺少/);
  assert.equal(expandStep({action:'fill',selector:{css:'#pwd'},password:true,text:'{secret}'},{}).text,undefined);
});
test('store rejects traversal, symlinked folders before mkdir, and symlinked scripts; only current project used',async t=>{
  const {root,store}=await project(t);for(const name of ['../escape','a/b','a\\b','..','/tmp/x','a.json',' x'])await assert.rejects(store.load(name),/非法|越界/);
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'browser-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.symlink(outside,path.join(root,'.sikeoop'));await assert.rejects(store.list(),/符号链接/);await assert.rejects(fs.stat(path.join(outside,'browser-flows')),/ENOENT/);
  await fs.unlink(path.join(root,'.sikeoop'));await store.save(flow([]),true);
  const file=path.join(root,'.sikeoop/browser-flows/测试流程.json');await fs.unlink(file);await fs.writeFile(path.join(outside,'secret.json'),JSON.stringify(flow([])));await fs.symlink(path.join(outside,'secret.json'),file);
  await assert.rejects(store.load('测试流程'),/符号链接/);await assert.rejects(store.save(flow([])),/符号链接/);await assert.rejects(store.delete('测试流程'),/符号链接/);
});
test('store save is exclusive when recording; list/version/delete are validated',async t=>{
  const {store,root}=await project(t);await store.save(flow([]),true);await assert.rejects(store.save(flow([]),true),/EEXIST/);assert.equal((await store.list())[0].version,1);
  const file=path.join(root,'.sikeoop/browser-flows/测试流程.json');await fs.writeFile(file,JSON.stringify({...flow([]),version:99}));await assert.rejects(store.load('测试流程'),/版本/);await store.delete('测试流程');assert.deepEqual(await store.list(),[]);
});
function runner(overrides:Record<string,unknown>={}){
  const sequence=new BrowserAutomation(()=>{});const executed:BrowserFlowStep[]=[];
  return {executed,runActions:sequence.run.bind(sequence),resolve:async()=>2,execute:async(s:BrowserFlowStep)=>{executed.push(s);},snapshot:async()=> '[2] textbox "姓名"',checkProject:()=>{},...overrides};
}
test('replay uses native batch without model; default healing OFF and failure returns step + snapshot',async t=>{
  const {store}=await project(t);let models=0;
  const r=runner({resolve:async()=>{throw new SelectorFailure('选择器失效');},heal:async()=>{models++;return {css:'#name'};}});
  const result=await replayFlow(flow([{action:'navigate',url:'http://localhost/form.html'},{action:'fill',selector:{css:'#old'},text:'x'},{action:'click',selector:{css:'#submit-btn'}}]),store,r);
  assert.deepEqual(result,{completed:1,total:3,failedStep:2,reason:'选择器失效',snapshot:'[2] textbox "姓名"'});assert.equal(models,0);assert.equal(r.executed.length,1);
});
test('explicit healing calls snapshot-only model, validates new selector, retries once and writes history',async t=>{
  const {store}=await project(t);let models=0;const f=flow([{action:'fill',selector:{css:'#old'},text:'{name}'}]);await store.save(f,true);
  const r=runner({resolve:async(s:any)=>{if(s.css==='#old')throw new SelectorFailure('missing');return 2;},heal:async(s:any,snapshot:string)=>{models++;assert.equal(s.css,'#old');assert.match(snapshot,/姓名/);return {role:'textbox',name:'姓名',css:'#name'};}});
  const result=await replayFlow(f,store,r,{name:'小明'},true);assert.equal(result.failedStep,null);assert.equal(models,1);assert.equal(r.executed[0].text,'小明');
  const disk=await store.load(f.name);assert.equal(disk.history.length,1);assert.equal(disk.history[0].step,1);assert.equal(disk.history[0].before.css,'#old');assert.equal(disk.steps[0].selector?.css,'#name');assert.equal(disk.steps[0].text,'{name}');
});
test('no healing for action errors/denial/password; missing variable fails at correct step',async t=>{
  const {store}=await project(t);let models=0;
  const r=runner({execute:async()=>{throw new Error('denied');},heal:async()=>{models++;return {css:'#name'};}});
  const result=await replayFlow(flow([{action:'click',selector:{css:'#name'}}]),store,r,{},true);assert.equal(result.reason,'denied');assert.equal(models,0);
  const p=runner({heal:async()=>{models++;return {css:'#name'};}});const password=await replayFlow(flow([{action:'fill',selector:{css:'#pwd'},password:true}]),store,p,{},true);assert.match(password.reason!,/手动填写/);assert.equal(p.executed.length,0);assert.equal(models,0);
  assert.equal((await replayFlow(flow([{action:'fill',selector:{css:'#name'},text:'{missing}'}]),store,p)).failedStep,1);
});
test('healing rejects invalid model output and does not overwrite a script after denial or second resolution failure',async t=>{
  const {store}=await project(t);const f=flow([{action:'click',selector:{css:'#old'}}]);await store.save(f,true);
  const r=runner({resolve:async(s:any)=>{if(s.css==='#old')throw new SelectorFailure('missing');return 2;},heal:async()=>({css:'#new'}),execute:async()=>{throw new Error('denied');}});
  assert.equal((await replayFlow(f,store,r,{},true)).reason,'denied');assert.equal((await store.load(f.name)).history.length,0);
  const bad=runner({resolve:async()=>{throw new SelectorFailure('missing');},heal:async()=>({action:'click'})});assert.match((await replayFlow(f,store,bad,{},true)).reason!,/选择器/);assert.equal((await store.load(f.name)).steps[0].selector?.css,'#old');
});
test('project guard cancels replay before mutation, and cancellation reports precise failedStep',async t=>{
  const {store}=await project(t);const r=runner({checkProject:()=>{throw new Error('项目已切换');}});
  const f=flow([{action:'navigate',url:'http://localhost/'}]);const result=await replayFlow(f,store,r);assert.equal(result.failedStep,1);assert.equal(r.executed.length,0);
  const controller=new AbortController();controller.abort();assert.equal((await replayFlow(f,store,runner(),{},false,controller.signal)).failedStep,1);
});
test('recorder bindings only accept known isolated execution contexts; teardown removes scripts/listeners',async()=>{
  const fake=new Fake(),session=new CdpSession(fake),steps:BrowserFlowStep[]=[];const recorder=new CdpRecorder(session,{},s=>steps.push(s),()=>{});await recorder.start();
  const name=fake.calls.find(c=>c.method==='Runtime.addBinding')!.params.name;
  fake.event('Runtime.bindingCalled',{name,payload:JSON.stringify({action:'fill',selector:{css:'#name'},text:'x'}),executionContextId:0});assert.equal(steps.length,0);
  fake.event('Runtime.bindingCalled',{name,payload:JSON.stringify({action:'fill',selector:{css:'#name'},text:'x'}),executionContextId:10});assert.equal(steps.length,1);
  fake.event('Runtime.bindingCalled',{name,payload:JSON.stringify({action:'fill',selector:{css:'#pwd'},password:true,text:'SECRET'}),executionContextId:10});assert.equal(steps[1].text,undefined);
  await recorder.stop();fake.event('Runtime.bindingCalled',{name,payload:JSON.stringify({action:'click',selector:{css:'#submit-btn'}}),executionContextId:10});assert.equal(steps.length,2);
  assert.ok(fake.calls.some(c=>c.method==='Page.removeScriptToEvaluateOnNewDocument'));assert.ok(fake.calls.some(c=>c.method==='Runtime.removeBinding'));session.dispose();
});
function recorderDOMTarget(type:string,id:string,name:string){
  const t:any={tagName:type==='button'?'BUTTON':'INPUT',nodeType:1,id,parentElement:null,labels:[{textContent:name}],textContent:type==='button'?name:'',getAttribute:(k:string)=>k==='type'?type:null,closest:()=>t};
  t.matches=(s:string)=>{if(s==='input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]')return type==='password';if(s==='input[type="checkbox"]')return type==='checkbox';if(s==='input[type="radio"]')return false;if(s==='input[type="submit"],input[type="button"],input[type="reset"]')return false;if(s==='input[type="search"]'||s==='input[type="number"]')return false;if(s==='input, [contenteditable="true"]')return type!=='button';if(s==='button,a,[role="button"]'||s==='button,a,[role="button"]')return type==='button';if(s.startsWith('input:not([type="submit"])'))return type!=='button';if(s.startsWith('input:not([type="checkbox"])'))return type==='text';if(s.includes('input[type="checkbox"],input[type="radio"]'))return type==='checkbox';return false;};return t;
}
test('injected recorder does not access password.value; filters synthetic input and parameterizes before binding',()=>{
  const fake=new Fake(),session=new CdpSession(fake);const recorder=new CdpRecorder(session,{},()=>{},()=>{});const listeners=new Map<string,(e:any)=>void>(),payloads:any[]=[];
  const source=recorder.source();const binding=source.match(/globalThis\["([^"]+)"\]/)![1];runInNewContext(source,{addEventListener:(type:string,fn:any)=>listeners.set(type,fn),CSS:{escape:(s:string)=>s},URL,location:{href:'http://localhost/form.html'},[binding]:(s:string)=>payloads.push(JSON.parse(s))});
  const pwd=recorderDOMTarget('password','pwd','密码');Object.defineProperty(pwd,'value',{get(){throw new Error('PASSWORD READ');}});
  const emit=(type:string,target:any,stamp=30,trusted=true,key?:string)=>listeners.get(type)!({type,composedPath:()=>[target],isTrusted:trusted,timeStamp:stamp,key});
  emit('input',pwd);assert.equal(payloads[0].description,'填写密码字段');assert.equal(payloads[0].text,undefined);emit('keydown',pwd,30,true,'Enter');assert.equal(payloads.length,1);
  const input=recorderDOMTarget('text','name','姓名');Object.defineProperty(input,'value',{get(){throw new Error('PARAMETERIZED VALUE READ');}});emit('input',input,-1);emit('input',input,30,false);assert.equal(payloads.length,1);emit('input',input);assert.equal(payloads[1].text,'{value}');assert.equal(payloads[1].selector.role,'textbox');assert.equal(payloads[1].selector.name,'姓名');assert.equal(payloads[1].selector.css,'#name');recorder.dispose();session.dispose();
});
test('recorder records raw values only by opt-in, and click/select/check/press/navigate remain action data',()=>{
  const fake=new Fake(),session=new CdpSession(fake);const recorder=new CdpRecorder(session,{values:'record'},()=>{},()=>{});assert.match(recorder.source(),/String\(target.isContentEditable/);assert.ok(!new CdpRecorder(session,{},()=>{},()=>{}).source().includes('String(target.isContentEditable'));
  const r=new BrowserFlowRecording('form');for(const s of [{action:'click',selector:{role:'button',name:'提交',css:'#submit-btn'}},{action:'select',selector:{css:'#city'},text:'bj'},{action:'check',selector:{css:'#news'},checked:true},{action:'press',selector:{css:'#name'},key:'Tab'},{action:'navigate',url:'http://localhost/spa.html'}] as BrowserFlowStep[])r.add(s);assert.deepEqual(r.flow.steps.map(s=>s.action),['click','select','check','press','navigate']);recorder.dispose();session.dispose();
});
function actionsBrowser(){const calls:string[]=[];return {calls,origin:async()=> 'http://localhost',rect:async()=>({submits:true,label:'提交'}),click:async()=>{calls.push('click');},type:async()=>{calls.push('fill');},select:async()=>{calls.push('select');return true;},check:async()=>{calls.push('check');},focus:async()=>{calls.push('focus');},press:async()=>{calls.push('press');},validateUpload:async(f:string[])=>f,upload:async()=>{calls.push('upload');},open:async()=>{calls.push('navigate');}};}
test('all replay entrypoints require local submit/upload/key and external navigation approvals; denial has no mutation',async()=>{
  const browser=actionsBrowser();let asks=0;const deny=async()=>{asks++;return false;};const checkpoint=async()=>{};
  for(const step of [{action:'click',selector:{css:'#submit-btn'}},{action:'upload',selector:{css:'#file'},files:['test.txt']},{action:'press',selector:{css:'#name'},key:'Enter'},{action:'navigate',url:'https://example.com'}] as BrowserFlowStep[])await assert.rejects(executeFlowAction(browser,step,2,deny,checkpoint),/拒绝/);
  assert.equal(asks,4);assert.deepEqual(browser.calls,[]);await executeFlowAction(browser,{action:'press',selector:{css:'#name'},key:'Tab'},2,async()=>true,checkpoint);assert.deepEqual(browser.calls,['focus','press']);
});
test('destination revalidated after approval; select failure stops instead of pretending success',async()=>{
  const browser=actionsBrowser();let changed=false;browser.origin=async()=>changed?'https://other.example':'http://localhost';await assert.rejects(executeFlowAction(browser,{action:'click',selector:{css:'#submit-btn'}},2,async()=>{changed=true;return true;},async()=>{}),/已变化/);assert.deepEqual(browser.calls,[]);
  browser.select=async()=>false;await assert.rejects(executeFlowAction(browser,{action:'select',selector:{css:'#city'},text:'missing'},2,async()=>true,async()=>{}),/选择选项失败/);
});
test('pauseReason distinguishes manual/user/approval/error, resumes clear it and approval does not override manual takeover',async()=>{
  const sequence=new BrowserAutomation(()=>{});let approve!:()=>void;let executed=0;
  const run=sequence.run([1,2],String,async()=>{if(!executed)await sequence.approval(()=>new Promise<void>(r=>approve=r));executed++;});await tick();assert.equal(sequence.state().pauseReason,'approval');
  sequence.pause();assert.equal(sequence.state().pauseReason,'manual');approve();await tick();assert.equal(sequence.state().status,'paused');assert.equal(executed,1);sequence.resume();await run;assert.equal(sequence.state().pauseReason,undefined);
  let wait!:()=>void;const again=sequence.run([1,2],String,async()=>new Promise<void>(r=>wait=r));await tick();sequence.userInput();assert.equal(sequence.state().pauseReason,'user');assert.match(sequence.state().reason!,/接手/);sequence.stop();wait();assert.equal((await again).failedStep,1);assert.equal(sequence.state().pauseReason,'error');
});
test('flow graph node is a new kind with existing text JSON; rejects traversal and nonstring vars',()=>{
  assert.deepEqual(parseBrowserFlowNode('{"name":"网页检查","vars":{"query":"新闻"}}'),{name:'网页检查',vars:{query:'新闻'}});assert.throws(()=>parseBrowserFlowNode('{"name":"../x"}'),/越界/);assert.throws(()=>parseBrowserFlowNode('{"name":"x","vars":{"x":42}}'),/字符串/);assert.throws(()=>cleanSelector({action:'click'}),/选择器/);assert.equal(cleanStep({action:'click',selector:{css:'#x'},extra:'ignored'}).action,'click');
});

test('recorded URL credentials, query and fragment cannot leak a GET password; frame identity strips them',async t=>{
  const {store,root}=await project(t);const r=new BrowserFlowRecording('测试流程','record');r.add({action:'navigate',url:'https://user:SECRET@example.com/form?password=SECRET&next=ok#SECRET'});r.add({action:'fill',selector:{role:'textbox',name:'姓名',frameUrl:'https://user:SECRET@example.com/form?password=SECRET#SECRET',css:'#name'},text:'小明'});
  await store.save(r.flow,true);const disk=await fs.readFile(path.join(root,'.sikeoop/browser-flows/测试流程.json'),'utf8');assert.ok(!disk.includes('SECRET'));assert.ok(!disk.includes('user:'));assert.equal(r.flow.steps[0].url,'https://example.com/form?password={url1_query1}&next={url1_query2}#{url1_hash}');assert.equal(r.flow.steps[1].selector?.frameUrl,'https://example.com/form');
});
test('aria-labelledby whitespace is resolved before label/CSS fallback in the actual injected source',()=>{
  const fake=new Fake(),session=new CdpSession(fake),recorder=new CdpRecorder(session,{},()=>{},()=>{});const source=recorder.source();const listeners=new Map<string,(e:any)=>void>(),payloads:any[]=[];const binding=source.match(/globalThis\["([^"]+)"\]/)![1];
  runInNewContext(source,{URL,CSS:{escape:(s:string)=>s},location:{href:'http://localhost/form.html'},addEventListener:(type:string,fn:any)=>listeners.set(type,fn),[binding]:(s:string)=>payloads.push(JSON.parse(s))});
  const input=recorderDOMTarget('text','name','fallback');input.getAttribute=(k:string)=>k==='aria-labelledby'?'first  second':null;input.ownerDocument={getElementById:(id:string)=>({textContent:id==='first'?'姓名':'输入'})};
  listeners.get('input')!({type:'input',composedPath:()=>[input],isTrusted:true,timeStamp:30});assert.equal(payloads[0].selector.name,'姓名 输入');recorder.dispose();session.dispose();
});
test('recorder injection exceptions fail startup rather than silently recording only navigation',async()=>{
  const fake=new Fake(),base=fake.sendCommand.bind(fake);fake.sendCommand=async(method,params,sid)=>method==='Runtime.evaluate'?{exceptionDetails:{exception:{description:'listener failed'}}}:base(method,params,sid);const session=new CdpSession(fake),recorder=new CdpRecorder(session,{},()=>{},()=>{});await assert.rejects(recorder.start(),/listener failed/);await recorder.stop();session.dispose();
});

test('keyboard activation records press once and ignores the browser-generated detail=0 click',()=>{
  const fake=new Fake(),session=new CdpSession(fake),recorder=new CdpRecorder(session,{},()=>{},()=>{});const source=recorder.source(),listeners=new Map<string,(e:any)=>void>(),payloads:any[]=[];const binding=source.match(/globalThis\["([^"]+)"\]/)![1];
  runInNewContext(source,{URL,CSS:{escape:(s:string)=>s},location:{href:'http://localhost/form.html'},addEventListener:(type:string,fn:any)=>listeners.set(type,fn),[binding]:(s:string)=>payloads.push(JSON.parse(s))});
  const button=recorderDOMTarget('button','submit-btn','提交');listeners.get('keydown')!({type:'keydown',key:'Enter',composedPath:()=>[button],isTrusted:true,timeStamp:100});listeners.get('click')!({type:'click',detail:0,composedPath:()=>[button],isTrusted:true,timeStamp:101});assert.deepEqual(payloads.map(s=>s.action),['press']);listeners.get('click')!({type:'click',detail:1,composedPath:()=>[button],isTrusted:true,timeStamp:102});assert.deepEqual(payloads.map(s=>s.action),['press','click']);recorder.dispose();session.dispose();
});
