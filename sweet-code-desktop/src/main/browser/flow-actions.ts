import type { BrowserFlowStep } from '../../shared/types.ts';

export interface FlowActionsBrowser {
  origin(ref?:number):Promise<string>;
  rect(ref:number):Promise<{submits:boolean;label:string}>;
  click(ref:number):Promise<void>;
  type(ref:number,text:string,opts:{clear?:boolean;submit?:boolean}):Promise<void>;
  select(ref:number,text:string):Promise<boolean>;
  check(ref:number,checked:boolean):Promise<void>;
  focus(ref:number):Promise<void>;
  press(key:string):Promise<void>;
  validateUpload(files:string[]):Promise<string[]>;
  upload(ref:number,files:string[]):Promise<void>;
  open(url:string):Promise<unknown>;
}
export type FlowApprove = (description:string, detail:string, signal?:AbortSignal)=>Promise<boolean>;
const local=(url:string)=>{try{const u=new URL(url),h=u.hostname.replace(/^\[|\]$/g,'');return u.protocol==='file:'||h==='localhost'||h.endsWith('.localhost')||h==='::1'||h==='0.0.0.0'||/^127\./.test(h);}catch{return false;}};
/** All entrypoints (tool, IPC, scheduled graph) share this executor and human approval path. */
export async function executeFlowAction(browser:FlowActionsBrowser, step:BrowserFlowStep, ref:number|undefined, approve:FlowApprove, checkpoint:()=>Promise<void>, signal?:AbortSignal):Promise<void>{
  const guard=async()=>{if(signal?.aborted)throw new Error('Browser action cancelled.');await checkpoint();};
  await guard();
  if(step.password)throw new Error('密码字段只能由用户操作');
  if(step.action==='navigate'){
    if(!step.url||! /^(https?|file):/.test(step.url))throw new Error('脚本导航仅允许 http、https、file URL');
    if(!local(step.url)&&!await approve('打开外部网页',step.url,signal))throw new Error('用户拒绝打开网页');
    await guard();await browser.open(step.url);return;
  }
  if(ref===undefined)throw new Error('动作缺少目标元素');
  const destination=await browser.origin(ref);
  const info=step.action==='click'?await browser.rect(ref):undefined;
  const files=step.action==='upload'?await browser.validateUpload(step.files??[]):undefined;
  // Enter/Space can submit/activate without a submit button, so key playback is conservative.
  const risky=step.action==='upload'||step.action==='press'||!!info?.submits||/提交|付款|支付|发送|删除|购买|确认订单|submit|pay|send|delete|purchase|checkout/i.test(info?.label??'');
  if(risky||!local(destination)){
    if(!await approve(`运行浏览器脚本：${step.action}`,JSON.stringify({destination,ref,label:info?.label,files,text:step.text?.slice(0,200),key:step.key,checked:step.checked}),signal))throw new Error('用户拒绝浏览器脚本动作');
    await guard();if(await browser.origin(ref)!==destination)throw new Error('审批期间网页目标已变化');
  }
  await guard();
  switch(step.action){
    case 'click':await browser.click(ref);break;
    case 'fill':if(step.text===undefined)throw new Error('fill 缺少 text');await browser.type(ref,step.text,{clear:true});break;
    case 'select':if(step.text===undefined)throw new Error('select 缺少 text');if(!await browser.select(ref,step.text))throw new Error('选择选项失败');break;
    case 'check':await browser.check(ref,step.checked??true);break;
    case 'press':if(!step.key)throw new Error('press 缺少 key');await browser.focus(ref);await browser.press(step.key);break;
    case 'upload':await browser.upload(ref,files!);break;
  }
}
