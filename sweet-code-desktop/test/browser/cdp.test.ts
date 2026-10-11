import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpSession } from "../../src/main/browser/cdp/session.ts";
import { CdpPage, ElementRefs, compactTree } from "../../src/main/browser/cdp/page.ts";

class Fake extends EventEmitter {
  attached = false;
  calls: {method:string; params:any}[] = [];
  handler: (method:string, params:any)=>any = () => ({});
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; this.emit("detach"); }
  async sendCommand(method:string, params?:any) { this.calls.push({method,params}); return this.handler(method, params); }
  event(method:string, params:any = {}) { this.emit("message", {}, method, params); }
}
test("compact AX tree filters decoration, retains landmarks and masks passwords", () => {
  const refs = new ElementRefs();
  const root = {backendNodeId:1,nodeName:"DOCUMENT",children:[{backendNodeId:2,nodeName:"INPUT",attributes:["type","password"]}]};
  const tree = compactTree([
    {backendDOMNodeId:2,role:{value:"textbox"},name:{value:"Login"}},
    {backendDOMNodeId:3,role:{value:"button"},name:{value:"Send"},properties:[{name:"disabled",value:{value:true}}]},
    {backendDOMNodeId:4,role:{value:"generic"},name:{value:"decoration"}},
    {backendDOMNodeId:5,role:{value:"heading"},name:{value:"Title"}},
    {backendDOMNodeId:6,ignored:true,role:{value:"button"}},
  ],root,refs);
  assert.match(tree,/password field \(user only\)/); assert.match(tree,/disabled/); assert.match(tree,/heading/); assert.doesNotMatch(tree,/decoration/);
  assert.equal(refs.ref(2),1); refs.reset(); assert.throws(()=>refs.get(1),/已不在/); assert.equal(refs.ref(2),4);
});
test("session attaches, distributes events, reconnects and cleans up", async () => {
  const fake = new Fake(); const session = new CdpSession(fake); const page = new CdpPage(session);
  await Promise.all([session.connect(),session.connect()]); assert.equal(fake.calls.filter(c=>c.method==="Page.enable").length,1);
  let seen = false; session.on("event",()=>seen=true); fake.event("DOM.childNodeInserted"); assert.ok(seen);
  page.refs.ref(10); fake.detach(); assert.throws(()=>page.refs.get(1),/已不在/);
  await session.send("DOM.getDocument"); assert.ok(fake.attached); session.dispose(); assert.equal(fake.listenerCount("message"),0);
});
test("commands time out and pending commands reject on detach", async () => {
  const fake=new Fake(); const session=new CdpSession(fake,20); await session.connect();
  fake.handler=()=>new Promise(()=>{}); await assert.rejects(session.send("Slow"),/命令超时/);
  const pending=session.send("Pending"); await new Promise(r=>setTimeout(r,1)); fake.detach(); await assert.rejects(pending,/断开/); session.dispose();
});
test("idle follows network completion and DOM quiet; persistent requests time out", async () => {
  const fake=new Fake(); const session=new CdpSession(fake); await session.connect();
  fake.event("Network.requestWillBeSent",{requestId:"a"});
  const waiting=session.waitForIdle(100,5); setTimeout(()=>fake.event("Network.loadingFinished",{requestId:"a"}),10); await waiting;
  session.beginAction(); fake.event("DOM.attributeModified"); await session.waitForIdle(100,5);
  fake.event("Network.requestWillBeSent",{requestId:"b"}); await assert.rejects(session.waitForIdle(20,5),/超时/);
  fake.event("Network.loadingFailed",{requestId:"b"});
  fake.event("Page.frameNavigated",{frame:{id:"main"}}); await session.waitForIdle(100,5); session.dispose();
});
function setup(branch = "ok") {
  const fake=new Fake(); const session=new CdpSession(fake); const page=new CdpPage(session); const ref=page.refs.ref(10);
  fake.handler=(method,params)=>{
    if(method==="DOM.resolveNode") { if(branch==="missing") throw new Error("missing"); return {object:{objectId:"node"}}; }
    if(method==="Runtime.callFunctionOn") {
      if(params.functionDeclaration.includes("const rect=")) return {result:{value:branch!=="moving"}};
      return {result:{value:{exists:true,visible:branch!=="hidden",disabled:branch==="disabled",password:branch==="password",submits:true,label:"Send"}}};
    }
    if(method==="DOM.getContentQuads") return {quads:branch==="empty"?[]:[[0,0,20,0,20,20,0,20]]};
    if(method==="Page.getLayoutMetrics") return {layoutViewport:{clientWidth:100,clientHeight:100}};
    if(method==="DOM.getNodeForLocation") return {backendNodeId:branch==="covered"?20:branch==="child"?11:10};
    if(method==="DOM.describeNode") return {node:{backendNodeId:params.backendNodeId,nodeName:"DIV",children:[{backendNodeId:11,nodeName:"SPAN"}]}};
    if(method==="Runtime.evaluate") return {result:{value:false}};
    return {};
  };
  return {fake,session,page,ref};
}
for(const [branch,reason] of [["missing","已不在"],["hidden","不可见"],["moving","移动"],["disabled","不可用"],["empty","不可见"],["covered","被 DIV 挡住"]]) {
  test(`actionability: ${branch}`,async()=>{const {session,page,ref}=setup(branch); await assert.rejects(page.actionable(ref,1),new RegExp(reason)); session.dispose();});
}
test("actionability accepts target and descendant; clicks use CDP Input",async()=>{
  for(const branch of ["ok","child"]) {const {session,page,ref,fake}=setup(branch); const r=await page.actionable(ref); assert.equal(r.x,10); assert.equal(r.submits,true); await page.click(ref); assert.equal(fake.calls.filter(c=>c.method==="Input.dispatchMouseEvent").length,3); session.dispose();}
});
test("password input and click are blocked",async()=>{const {session,page,ref,fake}=setup("password"); await assert.rejects(page.type(ref,"secret",{}),/密码/); await assert.rejects(page.click(ref),/密码/); assert.ok(!fake.calls.some(c=>c.method==="Input.insertText")); session.dispose();});
test("Chinese text uses insertText and keyboard uses key events",async()=>{const {session,page,ref,fake}=setup(); await page.type(ref,"中文",{clear:false}); await page.press("Enter"); assert.ok(fake.calls.some(c=>c.method==="Input.insertText"&&c.params.text==="中文")); assert.ok(fake.calls.some(c=>c.method==="Input.dispatchKeyEvent"&&c.params.key==="Enter")); session.dispose();});
