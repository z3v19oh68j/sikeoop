import { randomUUID } from 'node:crypto';
import { CdpSession } from './session.ts';
import { isUserInput } from './input-origin.ts';
import { cleanStep } from '../flows.ts';
import type { BrowserFlowStep, BrowserFlowRecordingOptions } from '../../../shared/types.ts';

/** Isolated-world listener; password value is never accessed, even before sanitization. */
export class CdpRecorder {
  private session: CdpSession;
  private world = `sikeoop-recorder-${randomUUID()}`;
  private binding = `sikeoopRecord_${randomUUID().replaceAll('-', '')}`;
  private contexts = new Map<string, {id:number;sid?:string}>();
  private scripts = new Map<string,{id:string;sid?:string}>();
  private installing = new Map<string,Promise<void>>();
  private active = false;
  private options: BrowserFlowRecordingOptions;
  private receive: (step: BrowserFlowStep) => void;
  private failure: (reason: string) => void;
  private event = (method:string, params:any, sid?:string) => {
    if(method==='Runtime.executionContextCreated'&&params.context?.name===this.world&&params.context.auxData?.isDefault!==true)
      this.contexts.set(`${sid??''}:${params.context.auxData?.frameId}`, {id:params.context.id,sid});
    if(method==='Runtime.executionContextDestroyed')for(const [k,c]of this.contexts)if(c.sid===sid&&c.id===params.executionContextId)this.contexts.delete(k);
    if(method==='Runtime.executionContextsCleared')for(const [k,c]of this.contexts)if(c.sid===sid)this.contexts.delete(k);
    if(method==='Target.detachedFromTarget'){this.scripts.delete(params.sessionId);for(const[k,c]of this.contexts)if(c.sid===params.sessionId)this.contexts.delete(k);}
    if(method==='Runtime.bindingCalled'&&this.active&&params.name===this.binding&&typeof params.payload==='string'&&params.payload.length<=20000&&[...this.contexts.values()].some(c=>c.sid===sid&&c.id===params.executionContextId)) {
      try { this.receive(cleanStep(JSON.parse(params.payload))); } catch(e) {this.failure((e as Error).message);}
    }
  };
  private changed = () => { if(this.active)void this.install().catch(e=>this.failure((e as Error).message)); };
  private disconnected = () => { if(this.active)this.failure('录制调试会话已断开'); };
  constructor(session:CdpSession, options:BrowserFlowRecordingOptions, receive:(step:BrowserFlowStep)=>void, failure:(reason:string)=>void) {
    this.session=session;this.options=options;this.receive=receive;this.failure=failure;
    session.on('event',this.event);session.on('framesChanged',this.changed);session.on('document',this.changed);session.on('disconnected',this.disconnected);
  }
  source():string {
    return `(()=>{
      if(globalThis.__sikeoopRecorder)return;
      const send=step=>globalThis[${JSON.stringify(this.binding)}](JSON.stringify(step));
      const selector=e=>{
        const role=e.getAttribute('role')||({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox'}[e.tagName])||(e.matches('input[type="submit"],input[type="button"],input[type="reset"]')?'button':e.matches('input[type="search"]')?'searchbox':e.matches('input[type="number"]')?'spinbutton':e.matches('input[type="checkbox"]')?'checkbox':e.matches('input[type="radio"]')?'radio':e.matches('input, [contenteditable="true"]')?'textbox':'');
        const ids=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean);
        const name=(e.getAttribute('aria-label')||ids.map(id=>e.ownerDocument.getElementById(id)?.textContent||'').join(' ')||[...(e.labels||[])].map(l=>l.textContent).join(' ')||e.getAttribute('alt')||e.getAttribute('title')||(e.matches('button,a,[role="button"]')?e.textContent:'')||e.getAttribute('placeholder')||'').trim().slice(0,160);
        const parts=[];let n=e;while(n&&n.nodeType===1){if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}const tag=n.tagName.toLowerCase();const peers=n.parentElement?[...n.parentElement.children].filter(c=>c.tagName===n.tagName):[n];parts.unshift(tag+(peers.length>1?':nth-of-type('+(peers.indexOf(n)+1)+')':''));n=n.parentElement;}
        const u=new URL(location.href);u.username='';u.password='';u.search='';u.hash='';const out={css:parts.join(' > '),frameUrl:u.href};if(role&&name){out.role=role;out.name=name;}
        if(e.matches('button,a,[role="button"]')&&e.textContent?.trim())out.text=e.textContent.trim().slice(0,160);
        return out;
      };
      let activation=-Infinity;
      const listener=e=>{
        if(!(${isUserInput.toString()})(e))return;
        let target=e.composedPath()[0];if(!target?.matches)return;
        const password=target.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]');
        if(password){if(e.type==='input'||e.type==='change')send({action:'fill',selector:selector(target),password:true,description:'填写密码字段'});return;}
        if(e.type==='click'){
          if(e.detail===0&&e.timeStamp-activation>=0&&e.timeStamp-activation<1000)return;
          target=target.closest('button,a,input,[role="button"],[role="link"],[role="tab"],[role="menuitem"]')||target;
          if(target.matches('input:not([type="submit"]):not([type="button"]):not([type="reset"]),textarea,select,[contenteditable="true"]'))return;
          send({action:'click',selector:selector(target)});
        }else if(e.type==='change'&&target.matches('input[type="checkbox"],input[type="radio"]'))send({action:'check',selector:selector(target),checked:target.checked});
        else if(e.type==='change'&&target.matches('select'))send({action:'select',selector:selector(target),text:${this.options.values==='record'?'String(target.value)':'"{value}"'}});
        else if(e.type==='input'&&target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),textarea,[contenteditable="true"]'))send({action:'fill',selector:selector(target),text:${this.options.values==='record'?'String(target.isContentEditable?target.textContent:target.value)':'"{value}"'}});
        else if(e.type==='keydown'&&['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)){if(e.key==='Enter'||e.key===' ')activation=e.timeStamp;send({action:'press',selector:selector(target),key:e.key===' '?'Space':e.key});}
      };
      globalThis.__sikeoopRecorder=listener;for(const t of ['click','input','change','keydown'])addEventListener(t,listener,{capture:true,passive:true});
    })()`;
  }
  private async target(sid?:string):Promise<void> {
    const key=sid??'';if(this.installing.has(key))return this.installing.get(key);
    const task=(async()=>{
      if(!this.scripts.has(key)) {
        await this.session.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world},sid);
        const {identifier}=await this.session.send('Page.addScriptToEvaluateOnNewDocument',{source:this.source(),worldName:this.world},sid);
        this.scripts.set(key,{id:identifier,sid});
      }
      const {frameTree}=await this.session.send('Page.getFrameTree',{},sid);const frames:string[]=[];
      const walk=(t:any)=>{if(!t?.frame)return;if(!this.session.frameSession(t.frame.id)||this.session.frameSession(t.frame.id)===sid)frames.push(t.frame.id);for(const c of t.childFrames??[])walk(c);};walk(frameTree);
      for(const frameId of frames){if(!this.active)return;const {executionContextId:id}=await this.session.send('Page.createIsolatedWorld',{frameId,worldName:this.world,grantUniveralAccess:false},sid);this.contexts.set(`${key}:${frameId}`,{id,sid});const result=await this.session.send('Runtime.evaluate',{expression:this.source(),contextId:id},sid);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'录制监听器安装失败');}
    })();this.installing.set(key,task);try{await task;}finally{this.installing.delete(key);}
  }
  private async install():Promise<void>{await this.session.connect();await Promise.all([undefined,...this.session.sessionIds()].map(s=>this.target(s)));}
  async start():Promise<void>{this.active=true;await this.install();}
  async stop():Promise<void>{
    this.active=false;await Promise.allSettled([...this.installing.values()]);
    await Promise.all([...this.contexts.values()].map(c=>this.session.send('Runtime.evaluate',{contextId:c.id,expression:`(()=>{const l=globalThis.__sikeoopRecorder;if(l)for(const t of ['click','input','change','keydown'])removeEventListener(t,l,true);delete globalThis.__sikeoopRecorder})()`},c.sid).catch(()=>{})));
    await Promise.all([...this.scripts.values()].map(s=>this.session.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:s.id},s.sid).catch(()=>{})));
    await Promise.all([undefined,...this.session.sessionIds()].map(sid=>this.session.send('Runtime.removeBinding',{name:this.binding},sid).catch(()=>{})));
    this.dispose();
  }
  dispose():void{this.active=false;this.session.off('event',this.event);this.session.off('document',this.changed);this.session.off('framesChanged',this.changed);this.session.off('disconnected',this.disconnected);}
}
