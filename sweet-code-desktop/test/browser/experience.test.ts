import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { CdpSession } from '../../src/main/browser/cdp/session.ts';
import { CdpExperience, OVERLAY_ATTRIBUTE } from '../../src/main/browser/cdp/experience.ts';
import { isUserInput, SELF_INPUT_TIMESTAMP } from '../../src/main/browser/cdp/input-origin.ts';
import { BrowserAutomation } from '../../src/main/browser/automation.ts';
import { compactTree, ElementRefs, CdpPage } from '../../src/main/browser/cdp/page.ts';

const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
class Fake extends EventEmitter {
  attached = false;
  calls: {method:string;params:any;sid?:string}[] = [];
  evaluate: (params:any) => any = () => undefined;
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; this.emit('detach'); }
  async sendCommand(method:string, params?:any, sid?:string) {
    this.calls.push({method,params,sid});
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: {id:'same-origin'} }] } };
    if (method === 'Page.createIsolatedWorld') return {executionContextId: params.frameId === 'main' ? 12 : 13};
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return {identifier:'script'};
    if (method === 'Runtime.evaluate') return {result:{value: await this.evaluate(params)}};
    return {};
  }
  event(method:string, params:any) { this.emit('message', {}, method, params); }
}
test('isolated worlds monitor every local frame; binding calls must come from a registered context', async () => {
  const fake = new Fake(), session = new CdpSession(fake); let inputs = 0;
  const experience = new CdpExperience(session, () => inputs++);
  await experience.start();
  assert.deepEqual(fake.calls.filter(c => c.method === 'Page.createIsolatedWorld').map(c => c.params.frameId), ['main','same-origin']);
  const binding = fake.calls.find(c => c.method === 'Runtime.addBinding')!.params;
  assert.ok(binding.executionContextName);
  fake.event('Runtime.bindingCalled', {name:binding.name,payload:'input',executionContextId:0}); assert.equal(inputs,0);
  fake.event('Runtime.bindingCalled', {name:binding.name,payload:'arbitrary',executionContextId:12}); assert.equal(inputs,0);
  fake.event('Runtime.bindingCalled', {name:binding.name,payload:'input',executionContextId:13}); assert.equal(inputs,1);
  await experience.stopWatching();
  fake.event('Runtime.bindingCalled', {name:binding.name,payload:'input',executionContextId:12}); assert.equal(inputs,1);
  assert.ok(fake.calls.some(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  experience.dispose(); session.dispose();
});
test('trusted CDP input is not mistaken for physical input, and page-dispatched events are ignored', async () => {
  assert.equal(isUserInput({isTrusted:true,timeStamp:-1700000000000}),false);
  assert.equal(isUserInput({isTrusted:false,timeStamp:20}),false);
  assert.equal(isUserInput({isTrusted:true,timeStamp:20}),true);
  assert.equal(isUserInput({isTrusted:true,timeStamp:NaN}),false);
  assert.equal(isUserInput({isTrusted:true,timeStamp:0}),false);
  const fake = new Fake(), session = new CdpSession(fake);
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:2});
  await session.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a'});
  for (const c of fake.calls.filter(c => c.method.startsWith('Input.'))) assert.equal(c.params.timestamp,SELF_INPUT_TIMESTAMP);
  session.dispose();
});
test('injected listener applies the same trusted/timestamp predicate without exposing keystrokes', async () => {
  const fake = new Fake(), session = new CdpSession(fake); const experience = new CdpExperience(session, () => {});
  await experience.start();
  const source = fake.calls.find(c => c.method === 'Page.addScriptToEvaluateOnNewDocument')!.params.source;
  const name = fake.calls.find(c => c.method === 'Runtime.addBinding')!.params.name;
  const listeners = new Map<string,(event:any)=>void>(); const values:string[] = [];
  runInNewContext(source, {addEventListener:(type:string,fn:any)=>listeners.set(type,fn),[name]:(value:string)=>values.push(value)});
  listeners.get('keydown')!({isTrusted:true,timeStamp:-100,key:'password'});
  listeners.get('keydown')!({isTrusted:false,timeStamp:100,key:'password'});
  listeners.get('mousemove')!({isTrusted:true,timeStamp:100});
  assert.deepEqual(values,['input']);
  await experience.stopWatching(); experience.dispose(); session.dispose();
});
test('overlay script creates a pointer-transparent closed shadow layer, animates, highlights and removes it', async () => {
  const fake = new Fake(), session = new CdpSession(fake); const experience = new CdpExperience(session, () => {});
  const hosts:any[] = []; const durations:number[] = []; const roots:any[] = [];
  function element() {
    const e:any = {style:{},attrs:{},isConnected:true,children:[],setAttribute:(k:string,v:string)=>e.attrs[k]=v,remove:()=>e.isConnected=false,
      append:(child:any)=>e.children.push(child),animate:(_frames:any,opts:any)=>{durations.push(opts.duration);return {finished:Promise.resolve()};},
      attachShadow:(opts:any)=>{assert.equal(opts.mode,'closed');const root:any={innerHTML:'',children:[],querySelector:()=>element(),append:(child:any)=>root.children.push(child)}; roots.push(root); return root;}};
    return e;
  }
  const context:any = { document:{createElement:element,documentElement:{appendChild:(host:any)=>hosts.push(host)}},setTimeout:(fn:any,_ms:number)=>{fn();return 1;} };
  fake.evaluate = params => runInNewContext(params.expression, context);
  await experience.animate('fill',{x:40,y:60},{x:10,y:20,width:100,height:25});
  assert.equal(hosts.length,1); assert.equal(hosts[0].attrs[OVERLAY_ATTRIBUTE],'');
  assert.equal(hosts[0].attrs['aria-hidden'],'true'); assert.match(hosts[0].style.cssText,/pointer-events:none!important/);
  assert.match(hosts[0].style.cssText,/2147483647/); assert.match(roots[0].innerHTML,/\.box/);
  await experience.animate('click',{x:40,y:60}); assert.deepEqual(durations,[150,150,250]);
  assert.equal(fake.calls.filter(c => c.method.startsWith('Input.')).length,0);
  await experience.remove(); assert.equal(hosts[0].isConnected,false);
  experience.dispose(); session.dispose();
});
test('fast never injects a layer; demo awaits animation; normal returns while animation is pending', async () => {
  const fake = new Fake(), session = new CdpSession(fake); const experience = new CdpExperience(session, () => {});
  await experience.visual('fast','click',{x:1,y:2}); assert.equal(fake.calls.length,0);
  const wait = deferred(); let called = 0;
  experience.animate = async () => { called++; await wait.promise; };
  let finished = false; const demo = experience.visual('demo','click',{x:1,y:2}).then(()=>finished=true);
  await tick(); assert.equal(finished,false); wait.resolve(); await demo; assert.equal(finished,true);
  const pending = deferred(); experience.animate = async () => {called++;await pending.promise;};
  await experience.visual('normal','hover',{x:3,y:4}); assert.equal(called,2);
  pending.resolve(); await experience.stopWatching(); experience.dispose(); session.dispose();
});
test('compact snapshot excludes overlay host and closed shadow descendants regardless of AX role', () => {
  const root = {backendNodeId:1,nodeName:'HTML',children:[{backendNodeId:2,nodeName:'DIV',attributes:[OVERLAY_ATTRIBUTE,''],shadowRoots:[{backendNodeId:3,nodeName:'#shadow-root',children:[{backendNodeId:4,nodeName:'BUTTON'}]}]},{backendNodeId:5,nodeName:'BUTTON'}]};
  const text = compactTree([2,4,5].map(id=>({backendDOMNodeId:id,role:{value:'button'},name:{value:`node${id}`}})),root,new ElementRefs());
  assert.doesNotMatch(text,/node2|node4/); assert.match(text,/node5/);
});
test('takeover pauses the current sequence, resume continues without replay, and progress is 1-based', async () => {
  const states:any[] = [], done:number[] = []; const controller = new BrowserAutomation(s=>states.push(s));
  const run = controller.run([1,2], n=>`Action ${n}`, async n=>{if(n===1)controller.userInput();await controller.checkpoint();done.push(n);});
  await tick(); assert.equal(controller.state().status,'paused'); assert.equal(controller.state().step,1); assert.deepEqual(done,[]);
  await assert.rejects(controller.run([3],String,async()=>{}),/already/);
  controller.resume(); const result = await run; assert.equal(result.completed,2); assert.deepEqual(done,[1,2]);
  assert.equal(controller.state().status,'done'); assert.equal(controller.state().total,2);
  assert.ok(states.some(s=>s.status==='paused')); controller.userInput(); assert.equal(controller.state().status,'done');
});
test('stop while paused wakes checkpoint, never starts a later step, and resume cannot resurrect it', async () => {
  const controller = new BrowserAutomation(()=>{}); const entered:number[] = [];
  const run = controller.run([1,2],String,async n=>{entered.push(n);controller.userInput();await controller.checkpoint();});
  await tick(); assert.equal(controller.state().status,'paused'); controller.stop(); assert.equal(controller.state().status,'error');
  const result = await run; assert.equal(result.failedStep,1); assert.deepEqual(entered,[1]); assert.match(result.reason!,/stopped/);
  controller.resume(); assert.equal(controller.state().status,'error');
  const next = await controller.run([3],String,async n=>entered.push(n)); assert.equal(next.completed,1);
});
test('abort wakes a paused batch, and an action failure sets error with the failing step', async () => {
  const controller = new BrowserAutomation(()=>{}), abort = new AbortController();
  const run = controller.run([1,2],String,async()=>{controller.userInput();await controller.checkpoint();},abort.signal);
  await tick(); abort.abort(); assert.equal((await run).failedStep,1); assert.match(controller.state().reason!,/cancelled/);
  await controller.run([1,2],String,async n=>{if(n===2)throw new Error('missing');});
  assert.equal(controller.state().status,'error'); assert.equal(controller.state().step,2); assert.equal(controller.state().reason,'missing');
});
test('stop cancels an active idle wait rather than waiting for its timeout', async () => {
  const fake = new Fake(), session = new CdpSession(fake), controller = new BrowserAutomation(()=>{});
  session.actionSignal=()=>controller.actionSignal();
  const ready = deferred();
  const run = controller.run([1,2],String,async()=>{await session.connect();fake.event('Network.requestWillBeSent',{requestId:'pending'});ready.resolve();await session.waitForIdle(60000);});
  await ready.promise; await tick(); controller.stop(); const result = await run;
  assert.equal(result.failedStep,1); assert.equal(controller.state().status,'error'); session.dispose();
});
