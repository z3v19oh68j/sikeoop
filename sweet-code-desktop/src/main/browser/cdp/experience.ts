import { randomUUID } from 'node:crypto';
import { CdpSession } from './session.ts';
import { isUserInput } from './input-origin.ts';

export const OVERLAY_ATTRIBUTE = 'data-sikeoop-automation-overlay';
/** Worlds isolate JS bindings, NOT DOM. Only the closed shadow contents are hidden from page JS. */
export class CdpExperience {
  private session: CdpSession;
  private world = `sikeoop-experience-${randomUUID()}`;
  private binding = `sikeoopInput_${randomUUID().replaceAll('-', '')}`;
  private contexts = new Map<string, { id: number; sid?: string }>();
  private scripts = new Map<string, { id: string; sid?: string }>();
  private installations = new Map<string, Promise<void>>();
  private motions = new Set<Promise<void>>();
  private watching = false;
  private generation = 0;
  private disconnected = () => { this.generation++; this.scripts.clear(); this.contexts.clear(); this.installations.clear(); };
  private userInput: () => void;
  private failure: (reason:string) => void;
  private changed = (_method: string, params: any, sid?: string) => {
    if (_method === 'Runtime.bindingCalled' && this.watching && params.name === this.binding && params.payload === 'input' && [...this.contexts.values()].some(c => c.sid === sid && c.id === params.executionContextId)) this.userInput();
    if (_method === 'Runtime.executionContextCreated' && params.context?.name === this.world && params.context.auxData?.isDefault !== true) {
      this.contexts.set(`${sid ?? ''}:${params.context.auxData?.frameId}`, { id: params.context.id, sid });
    }
    if (_method === 'Runtime.executionContextDestroyed') for (const [key, c] of this.contexts) if (c.sid === sid && c.id === params.executionContextId) this.contexts.delete(key);
    if (_method === 'Runtime.executionContextsCleared') for (const [key, c] of this.contexts) if (c.sid === sid) this.contexts.delete(key);
    if (_method === 'Target.detachedFromTarget') { const key = params.sessionId; this.scripts.delete(key); this.installations.delete(key); for (const [k, c] of this.contexts) if (c.sid === key) this.contexts.delete(k); }
  };
  private framesChanged = () => { if (this.watching) void this.install().catch(e => this.failure((e as Error).message)); };
  private documentChanged = () => { this.contexts.clear(); if (this.watching) void this.install().catch(e => this.failure((e as Error).message)); };
  constructor(session: CdpSession, userInput: () => void, failure?: (reason:string)=>void) {
    this.session = session; this.userInput = userInput; this.failure = failure ?? (()=>userInput());
    session.on('disconnected', this.disconnected); session.on('event', this.changed); session.on('framesChanged', this.framesChanged); session.on('document', this.documentChanged);
  }
  private listenerScript(): string {
    return `(()=>{if(globalThis.__sikeoopInput)return;const listener=e=>{if((${isUserInput.toString()})(e))globalThis[${JSON.stringify(this.binding)}]('input')};globalThis.__sikeoopInput=listener;for(const type of ['mousemove','mousedown','mouseup','wheel','keydown','keyup','pointerdown'])addEventListener(type,listener,{capture:true,passive:true})})()`;
  }
  private async installTarget(sid?: string): Promise<void> {
    const key = sid ?? '';
    const generation = this.generation;
    if (!this.watching) return;
    if (!this.scripts.has(key)) {
      await this.session.send('Runtime.addBinding', { name: this.binding, executionContextName: this.world }, sid);
      const result = await this.session.send('Page.addScriptToEvaluateOnNewDocument', { source: this.listenerScript(), worldName: this.world }, sid);
      if (generation !== this.generation) throw new Error("CDP disconnected during experience setup.");
      this.scripts.set(key, { id: result.identifier, sid });
    }
    const { frameTree } = await this.session.send('Page.getFrameTree', {}, sid);
    const frames: string[] = [];
    const visit = (tree: any) => { if (!tree?.frame?.id) return; if (this.session.frameSession(tree.frame.id) && this.session.frameSession(tree.frame.id) !== sid) return; frames.push(tree.frame.id); for (const child of tree.childFrames ?? []) visit(child); };
    visit(frameTree);
    for (const frameId of frames) {
      const { executionContextId } = await this.session.send('Page.createIsolatedWorld', { frameId, worldName: this.world }, sid);
      this.contexts.set(`${key}:${frameId}`, { id: executionContextId, sid });
      await this.evaluate(executionContextId, this.listenerScript(), sid);
    }
  }
  private async install(): Promise<void> {
    await this.session.connect();
    await Promise.all([undefined, ...this.session.sessionIds()].map(sid => {
      const key = sid ?? ''; let pending = this.installations.get(key);
      if (!pending) { pending = this.installTarget(sid).finally(() => this.installations.delete(key)); this.installations.set(key, pending); }
      return pending;
    }));
  }
  async start(): Promise<void> { this.watching = true; await this.install(); }
  private async evaluate(contextId: number, expression: string, sid?: string): Promise<any> {
    const result = await this.session.send('Runtime.evaluate', { contextId, expression, awaitPromise: true, returnByValue: true }, sid);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Browser experience injection failed.');
    return result.result?.value;
  }
  async visual(speed: 'demo' | 'normal' | 'fast', kind: 'click' | 'fill' | 'hover', point: {x:number;y:number}, box?: {x:number;y:number;width:number;height:number}): Promise<void> {
    if (speed === 'fast') { await this.remove(); return; }
    const motion = this.animate(kind, point, box);
    this.motions.add(motion);
    void motion.finally(() => this.motions.delete(motion)).catch(() => {});
    if (speed === 'demo') await motion;
    else void motion.catch(e => this.failure((e as Error).message));
  }
  async animate(kind: 'click' | 'fill' | 'hover', point: { x: number; y: number }, box?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const { frameTree } = await this.session.send('Page.getFrameTree', {});
    const { executionContextId } = await this.session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: this.world });
    this.contexts.set(`:${frameTree.frame.id}`, { id: executionContextId });
    await this.evaluate(executionContextId, `(async()=>{
      let layer=globalThis.__sikeoopLayer;
      if(!layer||!layer.host.isConnected){
        const host=document.createElement('div');host.setAttribute('${OVERLAY_ATTRIBUTE}','');host.setAttribute('aria-hidden','true');host.setAttribute('inert','');
        host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;';
        const root=host.attachShadow({mode:'closed'});root.innerHTML='<style>:host,*{pointer-events:none!important} .cursor{position:absolute;width:16px;height:16px;border:2px solid white;background:#7c5cff;border-radius:50%;box-shadow:0 1px 6px #0008;transform:translate(-50%,-50%)} .ring{position:absolute;width:30px;height:30px;border:2px solid #7c5cff;border-radius:50%;transform:translate(-50%,-50%)} .box{position:absolute;border:2px solid #7c5cff;border-radius:4px;box-sizing:border-box;box-shadow:0 0 8px #7c5cff88}</style><div class="cursor"></div>';
        (document.documentElement||document).appendChild(host);layer=globalThis.__sikeoopLayer={host,root,cursor:root.querySelector('.cursor'),x:0,y:0};
      }
      const target=${JSON.stringify(point)},kind=${JSON.stringify(kind)},box=${JSON.stringify(box ?? null)};
      const from={x:layer.x,y:layer.y};layer.x=target.x;layer.y=target.y;
      layer.cursor.style.left=target.x+'px';layer.cursor.style.top=target.y+'px';
      const motion=layer.cursor.animate([{left:from.x+'px',top:from.y+'px'},{left:target.x+'px',top:target.y+'px'}],{duration:150,easing:'cubic-bezier(.22,.61,.36,1)'});
      if(kind==='fill'&&box){const e=document.createElement('div');e.className='box';Object.assign(e.style,{left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px'});layer.root.append(e);setTimeout(()=>e.remove(),700);}
      // Timer fallback: animations may be throttled in a hidden webview.
      await Promise.race([motion.finished.catch(()=>{}),new Promise(r=>setTimeout(r,180))]);
      if(kind==='click'){const e=document.createElement('div');e.className='ring';e.style.left=target.x+'px';e.style.top=target.y+'px';layer.root.append(e);const ripple=e.animate([{opacity:1,scale:'.3'},{opacity:0,scale:'1.8'}],{duration:250});await Promise.race([ripple.finished.catch(()=>{}),new Promise(r=>setTimeout(r,260))]);e.remove();}
    })()`);
  }
  async remove(): Promise<void> {
    await Promise.all([...this.contexts.values()].map(c => this.evaluate(c.id, `(()=>{globalThis.__sikeoopLayer?.host.remove();delete globalThis.__sikeoopLayer})()`, c.sid).catch(() => {})));
  }
  async stopWatching(): Promise<void> {
    this.watching = false;
    await Promise.allSettled([...this.installations.values(), ...this.motions]);
    await this.remove();
    await Promise.all([...this.contexts.values()].map(c => this.evaluate(c.id, `(()=>{const l=globalThis.__sikeoopInput;if(l)for(const t of ['mousemove','mousedown','mouseup','wheel','keydown','keyup','pointerdown'])removeEventListener(t,l,true);delete globalThis.__sikeoopInput})()`, c.sid).catch(() => {})));
    await Promise.all([...this.scripts.values()].map(s => this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.id }, s.sid).catch(() => {})));
    this.scripts.clear();
    await Promise.all([undefined, ...this.session.sessionIds()].map(sid => this.session.send("Runtime.removeBinding", {name:this.binding}, sid).catch(() => {})));
  }
  dispose(): void { this.watching = false; this.session.off('disconnected', this.disconnected); this.session.off('event', this.changed); this.session.off('framesChanged', this.framesChanged); this.session.off('document', this.documentChanged); this.contexts.clear(); this.scripts.clear(); }
}
