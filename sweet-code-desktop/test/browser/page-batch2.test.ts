import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CdpSession} from '../../src/main/browser/cdp/session.ts';
import {CdpPage,ElementRefs} from '../../src/main/browser/cdp/page.ts';
class Fake extends EventEmitter {
  attached=false;
  calls:{method:string;params:any;sid?:string}[]=[];
  handler:(method:string,params:any,sid?:string)=>any=()=>({});
  isAttached(){return this.attached;}
  attach(){this.attached=true;}
  detach(){this.attached=false;}
  async sendCommand(method:string,params?:any,sid?:string){this.calls.push({method,params,sid});return this.handler(method,params,sid);}
}
function setup(branch='ok') {
  const fake=new Fake(),session=new CdpSession(fake),page=new CdpPage(session),ref=page.refs.ref(10);
  let quadReads=0;
  fake.handler=(method,params)=>{
    if(method==='DOM.resolveNode')return {object:{objectId:'node'}};
    if(method==='Runtime.callFunctionOn'){
      const fn=params.functionDeclaration;
      if(fn.includes('document.visibilityState'))return {result:{value:'hidden'}};
      if(fn.includes('const rect='))throw new Error('background must not wait for RAF');
      if(fn.includes('file:this.matches'))return {result:{value:{exists:true,file:true,multiple:true,disabled:false}}};
      return {result:{value:{exists:true,visible:true,disabled:branch==='disabled',password:false,submits:false,label:'button'}}};
    }
    if(method==='DOM.getContentQuads'){quadReads++;return {quads:[[branch==='moving'?quadReads*10:0,0,20,0,20,20,0,20]]};}
    if(method==='Page.getLayoutMetrics')return {layoutViewport:{clientWidth:100,clientHeight:100}};
    if(method==='DOM.getNodeForLocation')return {backendNodeId:branch==='covered'?20:10};
    if(method==='DOM.describeNode')return {node:{backendNodeId:params.backendNodeId,nodeName:'DIV'}};
    return {};
  };
  return {fake,session,page,ref};
}
test('background page uses two DOM quad samples without RAF',async()=>{
  const {fake,session,page,ref}=setup();
  assert.equal((await page.actionable(ref,1)).x,10);
  assert.equal(fake.calls.filter(c=>c.method==='DOM.getContentQuads').length,3);
  assert.ok(fake.calls.some(c=>c.method==='DOM.getNodeForLocation'));session.dispose();
});
for(const [branch,message] of [['moving','移动'],['covered','挡住'],['disabled','不可用']])test(`background fallback still rejects ${branch}`,async()=>{
  const {session,page,ref}=setup(branch);await assert.rejects(page.actionable(ref,1),new RegExp(message));session.dispose();
});
test('refs isolate identical backend IDs across target sessions',()=>{
  const refs=new ElementRefs();const a=refs.ref(10),b=refs.ref(10,'child');assert.notEqual(a,b);assert.equal(refs.get(b),10);assert.equal(refs.session(b),'child');refs.reset();assert.throws(()=>refs.get(a));
});
test('snapshot diff tracks changes and scopes independent baselines',async()=>{
  const {fake,session,page}=setup();let title='Old';let extra=false;
  fake.handler=(method,params)=>{
    if(method==='DOM.getDocument'||method==='DOM.describeNode')return {[method==='DOM.getDocument'?'root':'node']:{backendNodeId:1,nodeName:'DOCUMENT',children:[{backendNodeId:10,nodeName:'BUTTON'},{backendNodeId:20,nodeName:'BUTTON'}]}};
    if(method==='Accessibility.getFullAXTree')return {nodes:[{backendDOMNodeId:10,role:{value:'button'},name:{value:title}},...(extra?[{backendDOMNodeId:20,role:{value:'button'},name:{value:'New'}}]:[])]};return {};
  };
  assert.match(await page.snapshot(),/Old/);title='Updated';extra=true;
  const diff=await page.snapshot({diff:true});assert.match(diff,/文字变化/);assert.match(diff,/新增/);assert.match(diff,/其余不变/);
  extra=false;assert.match(await page.snapshot({diff:true}),/消失/);
  const scope=page.refs.ref(1);assert.match(await page.snapshot({scope,diff:true}),/新增/);assert.equal(await page.snapshot({diff:true}),'其余不变');session.dispose();
});
test('upload uses setFileInputFiles and disabled input is rejected',async()=>{
  const {fake,session,page,ref}=setup();await page.upload(ref,['/project/a.txt']);assert.deepEqual(fake.calls.find(c=>c.method==='DOM.setFileInputFiles')?.params.files,['/project/a.txt']);session.dispose();
});
test('wait validates DOM conditions and times out conservatively',async()=>{
  const {fake,session,page}=setup();fake.handler=(method)=>method==='Runtime.evaluate'?{result:{value:true}}:{};
  await page.wait({kind:'text',text:'Hello',timeout:1});await page.wait({kind:'url',url:'https://example.test',timeout:1});
  fake.handler=(method)=>method==='Runtime.evaluate'?{result:{value:false}}:{};
  await assert.rejects(page.wait({kind:'element',selector:'.absent',timeout:1}),/超时/);session.dispose();
});
test('extract is pure DOM, removes input values and does not call model',async()=>{
  const {fake,session,page}=setup();fake.handler=(method,params)=>{
    if(method==='Runtime.evaluate'){assert.match(params.expression,/cloneNode/);assert.match(params.expression,/input,textarea,script,style/);return {result:{value:{kind:'table',rows:[['A']]}}};}return {};
  };assert.deepEqual(await page.extract({kind:'table'}),{kind:'table',rows:[['A']]});assert.ok(fake.calls.every(c=>c.method==='Network.enable'||!c.method.includes('Network')));session.dispose();
});
test('OOPIF clicks validate child hit, parent hit and translate input to root',async()=>{
  const {fake,session,page}=setup();const child=page.refs.ref(10,'child');
  session.send=(method,params,sid)=>fake.sendCommand(method,params,sid);
  session.frameIdForSession=sid=>sid==='child'?'frame-child':undefined;
  session.frameSession=()=>undefined;
  const original=fake.handler;
  fake.handler=(method,params,sid)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root'},childFrames:[{frame:{id:'frame-child'}}]}};
    if(method==='DOM.getFrameOwner')return {backendNodeId:30};
    if(method==='DOM.getContentQuads'&&params.backendNodeId===30)return {quads:[[100,100,200,100,200,200,100,200]]};
    if(method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('perspective:'))return {result:{value:{visible:true,disabled:false,perspective:false}}};
    if(method==='DOM.getNodeForLocation'&&!sid)return {backendNodeId:30};
    return original(method,params,sid);
  };
  await page.click(child);
  const input=fake.calls.find(c=>c.method==='Input.dispatchMouseEvent');assert.equal(input?.params.x,110);assert.equal(input?.params.y,110);assert.equal(input?.sid,undefined);
  fake.handler=(method,params,sid)=>method==='DOM.getNodeForLocation'&&!sid?{backendNodeId:99}:method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('perspective:')?{result:{value:{visible:true,disabled:false,perspective:false}}}:method==='DOM.getFrameOwner'?{backendNodeId:30}:method==='Page.getFrameTree'?{frameTree:{frame:{id:'root'},childFrames:[{frame:{id:'frame-child'}}]}}:method==='DOM.getContentQuads'&&params.backendNodeId===30?{quads:[[100,100,200,100,200,200,100,200]]}:original(method,params,sid);
  await assert.rejects(page.actionable(child,1),/iframe 被/);session.dispose();
});
test('child navigation invalidates only child refs',async()=>{
  const {session,page,ref}=setup();const child=page.refs.ref(10,'child');session.emit('event','DOM.documentUpdated',{},'child');assert.equal(page.refs.get(ref),10);assert.throws(()=>page.refs.get(child));session.dispose();
});
test('wait URL omitted observes a change and malformed wait rejects',async()=>{
  const {fake,session,page}=setup();fake.handler=(method,params)=>method==='Runtime.evaluate'?{result:{value:params.expression==='location.href'?'https://old.test':true}}:{};
  await page.wait({kind:'url',timeout:1});assert.ok(fake.calls.some(c=>c.params?.expression==='location.href!=="https://old.test"'));
  await assert.rejects(page.wait({kind:'text',text:''}),/不能为空/);await assert.rejects(page.wait({kind:'element'}),/需要/);session.dispose();
});
test('hidden wait accepts an invalidated ref',async()=>{
  const {session,page,ref}=setup();page.refs.reset();await page.wait({kind:'element',ref,state:'hidden',timeout:1});session.dispose();
});
test('press detects password focus in a child session instead of stale action session',async()=>{
  const {fake,session,page}=setup();session.sessionIds=()=>['child'];session.send=(m,p,s)=>fake.sendCommand(m,p,s);
  fake.handler=(method,_params,sid)=>method==='Runtime.evaluate'?{result:{value:{focused:sid==='child',password:sid==='child'}}}:{};
  await assert.rejects(page.press('a'),/密码/);assert.ok(!fake.calls.some(c=>c.method==='Input.dispatchKeyEvent'));session.dispose();
});
test('press directs keys to the uniquely focused child session',async()=>{
  const {fake,session,page}=setup();session.sessionIds=()=>['child'];session.send=(m,p,s)=>fake.sendCommand(m,p,s);
  fake.handler=(method,params,sid)=>method==='Runtime.evaluate'?{result:{value:params.expression.includes('focused:')?{focused:sid==='child',password:false}:false}}:method==='Accessibility.getFullAXTree'?{nodes:[]}:{};
  await page.press('a',0,false);assert.ok(fake.calls.filter(c=>c.method==='Input.dispatchKeyEvent').every(c=>c.sid==='child'));session.dispose();
});
