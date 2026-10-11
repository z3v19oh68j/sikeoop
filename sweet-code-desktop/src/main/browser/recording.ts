import type { BrowserFlow, BrowserFlowStep } from '../../shared/types.ts';
import { randomUUID } from 'node:crypto';
import { cleanStep, flowName, recordingUrl } from './flows.ts';

/** Main-process accumulation also redacts passwords and coalesces continuous typing. */
export class BrowserFlowRecording {
  readonly flow:BrowserFlow;
  private values:'record'|'parameterize';
  constructor(name?:string, values:'record'|'parameterize'='parameterize') {
    this.values=values;const now=Date.now();
    name=flowName(name===undefined?`未命名-${now}-${randomUUID().slice(0,8)}`:name);
    this.flow={version:1,name,createdAt:now,updatedAt:now,steps:[],history:[]};
  }
  add(raw:BrowserFlowStep):void {
    let step=cleanStep(raw);
    if(step.action==='navigate')step={...step,url:recordingUrl(step.url!,this.flow.steps.length+1)};
    const prev=this.flow.steps.at(-1);
    const same=prev?.action===step.action&&JSON.stringify(prev.selector)===JSON.stringify(step.selector);
    if(step.action==='navigate'&&prev?.action==='navigate'&&prev.url===step.url)return;
    if(this.values==='parameterize'&&!step.password&&step.text!==undefined)step={...step,text:same&&prev?.text?prev.text:`{value${this.flow.steps.length+1}}`};
    if(same&&(step.action==='fill'||step.action==='select'||step.action==='check'))this.flow.steps[this.flow.steps.length-1]=step;
    else {if(this.flow.steps.length>=1000)throw new Error('录制超过 1000 步');this.flow.steps.push(step);}
    this.flow.updatedAt=Date.now();
  }
}
