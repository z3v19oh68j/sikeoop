import { SelectorFailure, cleanSelector, normalizeFrameUrl } from "../flows.ts";
import type { BrowserFlowSelector } from "../../../shared/types.ts";
import { CdpSession } from "./session.ts";
import { OVERLAY_ATTRIBUTE } from "./experience.ts";

interface AXNode { ignored?: boolean; backendDOMNodeId?: number; role?: { value: string }; name?: { value: string }; properties?: { name: string; value: { value: unknown } }[] }
interface DOMNode { backendNodeId: number; nodeName: string; attributes?: string[]; children?: DOMNode[]; shadowRoots?: DOMNode[]; contentDocument?: DOMNode; frameId?: string }
export class ElementRefs {
  private next = 1;
  private forward = new Map<number, number>();
  private reverse = new Map<string, number>();
  private sessions = new Map<number, string | undefined>();
  ref(backend: number, sessionId?: string): number {
    const key = `${sessionId ?? ""}:${backend}`;
    let ref = this.reverse.get(key);
    if (!ref) { ref = this.next++; this.reverse.set(key, ref); this.forward.set(ref, backend); this.sessions.set(ref, sessionId); }
    return ref;
  }
  get(ref: number): number { const id = this.forward.get(ref); if (!id) throw new Error(`元素 [${ref}] 已不在`); return id; }
  session(ref: number): string | undefined { this.get(ref); return this.sessions.get(ref); }
  resetSession(sessionId: string): void {
    for (const [ref, sid] of this.sessions) if (sid === sessionId) { const backend=this.forward.get(ref);this.forward.delete(ref);this.sessions.delete(ref);this.reverse.delete(`${sid}:${backend}`); }
  }
  reset(): void { this.forward.clear(); this.reverse.clear(); this.sessions.clear(); } // never reuse public numbers
}
export function compactTree(nodes: AXNode[], root: DOMNode, refs: ElementRefs, sessionId?: string): string {
  const dom = new Map<number, DOMNode>();
  const excluded = new Set<number>();
  const walk = (node: DOMNode, hidden = false) => { hidden ||= (node.attributes ?? []).includes(OVERLAY_ATTRIBUTE); if (hidden) excluded.add(node.backendNodeId); dom.set(node.backendNodeId, node); for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) walk(child, hidden); };
  walk(root);
  const interactive = /^(button|link|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|slider|spinbutton|listbox|option|treeitem)$/;
  const landmark = /^(heading|banner|main|navigation|region|complementary|contentinfo|dialog|alert|table|grid|list)$/;
  const lines: string[] = [];
  for (const node of nodes) {
    const role = node.role?.value ?? ""; const name = node.name?.value ?? "";
    if (node.ignored || !node.backendDOMNodeId || excluded.has(node.backendDOMNodeId) || !(interactive.test(role) || (landmark.test(role) && name))) continue;
    const element = dom.get(node.backendDOMNodeId);
    const attrs = element?.attributes ?? [];
    const attr = (key: string) => { const i = attrs.indexOf(key); return i >= 0 ? attrs[i + 1] : ""; };
    const password = attr("type") === "password" || /^(current|new)-password$/.test(attr("autocomplete"));
    const disabled = node.properties?.some((p) => p.name === "disabled" && p.value.value === true);
    lines.push(`[${refs.ref(node.backendDOMNodeId, sessionId)}] ${password ? "password field (user only)" : role} ${JSON.stringify(name.slice(0, 160))}${disabled ? " disabled" : ""}`);
    if (lines.length >= 160) break;
  }
  return lines.join("\n");
}
// Executed on a resolved node. Never return form values, especially passwords.
const inspect = `function() {
  if (!this.isConnected) return {exists:false};
  const r=this.getBoundingClientRect(), s=getComputedStyle(this);
  return {exists:true, visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0.05,
    disabled:this.matches(':disabled')||this.getAttribute('aria-disabled')==='true',
    password:this.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]'),
    submits:!!this.closest('form')&&this.matches('button:not([type="button"]):not([type="reset"]),input[type="submit"],input[type="image"]'),
    label:(this.getAttribute('aria-label')||this.textContent||this.getAttribute('placeholder')||'').trim().slice(0,60)};
}`;
export class CdpPage {
  readonly refs = new ElementRefs();
  checkpoint?: () => Promise<void>;
  beforeVisual?: (kind: "click" | "fill" | "hover", point: {x:number;y:number}, box?: {x:number;y:number;width:number;height:number}) => Promise<void>;
  private session: CdpSession;
  private activeSession: string | undefined;
  private baselines = new Map<string, string>();
  private send(method: string, params?: any, ...sessions: [string | undefined] | []): Promise<any> { return this.session.send(method, params, sessions.length ? sessions[0] : this.activeSession); }
  constructor(session: CdpSession) { this.session = session; session.on("document", () => { this.refs.reset(); this.baselines.clear(); this.activeSession = undefined; }); session.on("event", (method, params, sid) => { const invalid = method === "Target.detachedFromTarget" ? params.sessionId : sid && (method === "DOM.documentUpdated" || method === "Page.frameNavigated") ? sid : undefined; if(invalid) {this.refs.resetSession(invalid); if(this.activeSession===invalid)this.activeSession=undefined;} }); }
  async snapshot(opts: {scope?: number; diff?: boolean} = {}): Promise<string> {
    await this.session.connect();
    const scopeSession = opts.scope === undefined ? undefined : this.refs.session(opts.scope);
    const sessions = opts.scope === undefined ? [undefined, ...this.session.sessionIds()] : [scopeSession];
    if(opts.scope!==undefined){
      const {node}=await this.send('DOM.describeNode',{backendNodeId:this.refs.get(opts.scope),depth:-1,pierce:true},scopeSession);
      const add=(n:DOMNode)=>{if(n.frameId){const child=this.session.frameSession(n.frameId);if(child&&!sessions.includes(child))sessions.push(child);}for(const c of [...(n.children??[]),...(n.shadowRoots??[]),...(n.contentDocument?[n.contentDocument]:[])])add(c);};add(node);
      // Include nested OOPIF descendants using frame parentage from the root tree.
      const {frameTree}=await this.send('Page.getFrameTree',{},undefined);
      const descendants=(t:any,included=false)=>{const sid=this.session.frameSession(t?.frame?.id);const inside=included||!!sid&&sessions.includes(sid);if(inside&&sid&&!sessions.includes(sid))sessions.push(sid);for(const c of t?.childFrames??[])descendants(c,inside);};descendants(frameTree);
    }
    const lines: string[] = [];
    for (const sid of sessions) {
      const scoped = opts.scope !== undefined && sid === scopeSession;
      const root = !scoped
        ? (await this.send("DOM.getDocument", {depth:-1,pierce:true}, sid)).root
        : (await this.send("DOM.describeNode", {backendNodeId:this.refs.get(opts.scope!),depth:-1,pierce:true}, sid)).node;
      let nodes: AXNode[] = (await this.send("Accessibility.getFullAXTree", {}, sid)).nodes ?? [];
      const {frameTree} = await this.send("Page.getFrameTree", {}, sid);
      const frames: string[] = []; const collect = (tree: any) => { for (const child of tree?.childFrames ?? []) { if (!this.session.frameSession(child.frame.id)) frames.push(child.frame.id); collect(child); } }; collect(frameTree);
      for (const frameId of frames) nodes.push(...((await this.send("Accessibility.getFullAXTree", {frameId}, sid)).nodes ?? []));
      nodes = [...new Map(nodes.map(n => [n.backendDOMNodeId ?? n, n])).values()];
      if (scoped) {
        const ids = new Set<number>(); const walk = (n: DOMNode) => { ids.add(n.backendNodeId); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c); }; walk(root);
        nodes = nodes.filter(n => n.backendDOMNodeId && ids.has(n.backendDOMNodeId));
      }
      lines.push(compactTree(nodes, root, this.refs, sid));
    }
    const current = lines.filter(Boolean).join("\n"); const key = String(opts.scope ?? "all");
    const previous = this.baselines.get(key); this.baselines.set(key, current);
    if (!opts.diff) return current;
    const parse = (text: string) => new Map(text.split("\n").filter(Boolean).map(line => [line.match(/^\[\d+\]/)?.[0] ?? line, line]));
    const before = parse(previous ?? ""), after = parse(current), changes: string[] = [];
    for (const [id, line] of after) { if (!before.has(id)) changes.push(`新增 ${line}`); else if (before.get(id) !== line) changes.push(`文字变化 ${line}`); }
    for (const [id, line] of before) if (!after.has(id)) changes.push(`消失 ${line}`);
    return [...changes, "其余不变"].join("\n");
  }
  /** Unique role/name first, then CSS, then exact text; never guess the first hit. */
  async resolveFlowSelector(raw: BrowserFlowSelector): Promise<number> {
    const selector = cleanSelector(raw);
    await this.session.connect();
    const candidates: {backend:number;sid?:string;role:string;name:string}[] = [];
    for (const sid of [undefined, ...this.session.sessionIds()]) {
      const {root} = await this.send('DOM.getDocument', {depth:-1,pierce:true}, sid);
      let ax: AXNode[] = (await this.send('Accessibility.getFullAXTree', {}, sid)).nodes ?? [];
      const {frameTree} = await this.send('Page.getFrameTree', {}, sid);
      const frameIds:string[]=[]; const gather=(t:any)=>{for(const c of t?.childFrames??[]){if(!this.session.frameSession(c.frame.id))frameIds.push(c.frame.id);gather(c);}};gather(frameTree);
      for(const frameId of frameIds) ax.push(...((await this.send('Accessibility.getFullAXTree',{frameId},sid)).nodes??[]));
      const byId = new Map(ax.filter(n=>!n.ignored).map(n=>[n.backendDOMNodeId,n]));
      const walk=(n:DOMNode, excluded=false)=>{
        excluded ||= (n.attributes??[]).includes(OVERLAY_ATTRIBUTE);
        if(!excluded && n.backendNodeId && !n.nodeName.startsWith('#')) { const a=byId.get(n.backendNodeId); candidates.push({backend:n.backendNodeId,sid,role:a?.role?.value??'',name:a?.name?.value??''}); }
        for(const c of [...(n.children??[]),...(n.shadowRoots??[]),...(n.contentDocument?[n.contentDocument]:[])])walk(c,excluded);
      };walk(root);
    }
    let pool = candidates;
    if(selector.frameUrl) {
      pool=[];
      for(const c of candidates) if(normalizeFrameUrl(await this.call(c.backend, 'function(){return this.ownerDocument.URL}',[],c.sid))===selector.frameUrl)pool.push(c);
    }
    const unique=(hits:typeof candidates):number=>{
      const distinct=[...new Map(hits.map(c=>[`${c.sid??''}:${c.backend}`,c])).values()];
      if(distinct.length!==1)throw new SelectorFailure(distinct.length?'选择器命中多个元素':'选择器失效：元素不存在');
      return this.refs.ref(distinct[0].backend,distinct[0].sid);
    };
    const matching=async(items:typeof candidates,css?:string,text?:string)=>{
      const hits:typeof candidates=[];
      for(const c of items) if(await this.call(c.backend, `function(css,text){return (!css||this.matches(css))&&(!text||(this.textContent||'').trim()===text)}`,[css??'',text??''],c.sid))hits.push(c);
      return hits;
    };
    if(selector.role&&selector.name) {
      const hits=pool.filter(c=>c.role===selector.role&&c.name===selector.name);
      if(hits.length===1)return unique(hits);
      if(hits.length>1) { const narrowed=await matching(hits,selector.css,selector.text);return unique(narrowed); }
    }
    if(selector.css) { const hits=await matching(pool,selector.css);if(hits.length)return unique(hits.length>1&&selector.text?await matching(hits,undefined,selector.text):hits); }
    if(selector.text)return unique(await matching(pool,undefined,selector.text));
    throw new SelectorFailure('选择器失效：元素不存在');
  }

  async call(backendNodeId: number, functionDeclaration: string, args: unknown[] = [], ...sessions: [string | undefined] | []): Promise<any> {
    const sid = sessions.length ? sessions[0] : this.activeSession;
    let objectId: string;
    try { objectId = (await this.send("DOM.resolveNode", { backendNodeId }, sid)).object.objectId; }
    catch { throw new Error("元素已不在"); }
    if (!objectId) throw new Error("元素已不在");
    try {
      const result = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true }, sid);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面操作失败");
      return result.result.value;
    } finally { await this.send("Runtime.releaseObject", { objectId }, sid).catch(() => {}); }
  }
  async actionable(ref: number, timeout = 3000): Promise<{ x: number; y: number; submits: boolean; label: string; password: boolean }> {
    this.activeSession = this.refs.session(ref);
    const backendNodeId = this.refs.get(ref); const deadline = Date.now() + timeout;
    let reason = "元素已不在";
    do {
      await this.checkpoint?.();
      try {
        const info = await this.call(backendNodeId, inspect);
        if (!info.exists) throw new Error("元素已不在");
        if (!info.visible) throw new Error("元素不可见");
        await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const visibility = await this.call(backendNodeId, `function(){return document.visibilityState}`);
        let stable: boolean;
        if (visibility === "hidden") {
          const a = (await this.send("DOM.getContentQuads", {backendNodeId})).quads;
          await new Promise(r => setTimeout(r, 50));
          const b = (await this.send("DOM.getContentQuads", {backendNodeId})).quads;
          stable = !!a?.length && a.length === b?.length && a.every((q: number[], i: number) => q.length === b[i].length && q.every((v, j) => Math.abs(v-b[i][j]) < 0.5));
        } else stable = await this.call(backendNodeId, `async function(){const rect=()=>{const r=this.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};const a=rect();const frames=async()=>{await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r));return true};if(!await Promise.race([frames(),new Promise(r=>setTimeout(()=>r(false),120))]))return false;return a.every((v,i)=>Math.abs(v-rect()[i])<0.5)}`);
        if (!stable) throw new Error("元素仍在移动");
        const current = await this.call(backendNodeId, inspect);
        if (!current.exists) throw new Error("元素已不在");
        if (!current.visible) throw new Error("元素不可见");
        if (current.disabled) throw new Error("元素不可用（disabled）");
        const { quads } = await this.send("DOM.getContentQuads", { backendNodeId });
        if (!quads?.length) throw new Error("元素不可见");
        const { layoutViewport: viewport } = await this.send("Page.getLayoutMetrics");
        const q = quads.find((q: number[]) => q.every(Number.isFinite) && Math.min(...q.filter((_: number, i: number) => i % 2 === 0)) < viewport.clientWidth && Math.max(...q.filter((_: number, i: number) => i % 2 === 0)) > 0 && Math.min(...q.filter((_: number, i: number) => i % 2 === 1)) < viewport.clientHeight && Math.max(...q.filter((_: number, i: number) => i % 2 === 1)) > 0);
        if (!q) throw new Error("元素不在视口内");
        const x = Math.max(0, Math.min(viewport.clientWidth - 1, (q[0]+q[2]+q[4]+q[6])/4));
        const y = Math.max(0, Math.min(viewport.clientHeight - 1, (q[1]+q[3]+q[5]+q[7])/4));
        const hit = await this.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false });
        let matches = hit.backendNodeId === backendNodeId;
        if (!matches) {
          const { node } = await this.send("DOM.describeNode", { backendNodeId, depth: -1, pierce: true });
          const contains = (n: DOMNode): boolean => n.backendNodeId === hit.backendNodeId || [...(n.children ?? []), ...(n.shadowRoots ?? [])].some(contains);
          matches = contains(node);
        }
        if (!matches) {
          const { node } = await this.send("DOM.describeNode", { backendNodeId: hit.backendNodeId });
          throw new Error(`被 ${node.nodeName} 挡住`);
        }
        const point = await this.translatePoint(x, y, this.activeSession);
        return { ...point, ...current };
      } catch (error) { reason = (error as Error).message; }
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline-Date.now())));
    } while (Date.now() < deadline);
    throw new Error(reason);
  }
  private async translatePoint(x: number, y: number, sid?: string): Promise<{x:number;y:number}> {
    if (!sid) return {x,y};
    const frameId = this.session.frameIdForSession(sid);
    if (!frameId) throw new Error("iframe 会话已断开");
    // Frame tree is queried in the parent target; only validated owners can receive input.
    const {frameTree} = await this.send("Page.getFrameTree", {}, undefined);
    const parent = (tree: any): string | undefined => {
      for (const child of tree.childFrames ?? []) { if (child.frame.id === frameId) return tree.frame.id; const found = parent(child); if (found) return found; }
      return undefined;
    };
    const parentFrame = parent(frameTree);
    const parentSid = parentFrame ? this.session.frameSession(parentFrame) : undefined;
    const owner = await this.send("DOM.getFrameOwner", {frameId}, parentSid);
    const ownerInfo = await this.call(owner.backendNodeId, `function(){const s=getComputedStyle(this);const r=this.getBoundingClientRect();return {visible:this.isConnected&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05,disabled:this.matches(':disabled')||this.getAttribute('aria-disabled')==='true',perspective:(()=>{for(let e=this;e;e=e.parentElement){const t=getComputedStyle(e);if(t.transform.startsWith('matrix3d')||t.perspective!=='none')return true;}return false})()}}`, [], parentSid);
    if(!ownerInfo.visible||ownerInfo.disabled)throw new Error("iframe 不可见或不可用");
    if(ownerInfo.perspective)throw new Error("iframe 3D 变换不支持精确坐标换算");
    const {quads} = await this.send("DOM.getContentQuads", {backendNodeId:owner.backendNodeId}, parentSid);
    if (!quads?.length) throw new Error("iframe 不可见");
    const q = quads[0];
    const {layoutViewport:v} = await this.send("Page.getLayoutMetrics", {}, sid);
    // Bilinear mapping also handles CSS transforms on the iframe owner.
    const u=x/v.clientWidth, w=y/v.clientHeight;
    const px=(1-u)*(1-w)*q[0]+u*(1-w)*q[2]+u*w*q[4]+(1-u)*w*q[6];
    const py=(1-u)*(1-w)*q[1]+u*(1-w)*q[3]+u*w*q[5]+(1-u)*w*q[7];
    const hit=await this.send("DOM.getNodeForLocation", {x:Math.round(px),y:Math.round(py),includeUserAgentShadowDOM:true,ignorePointerEventsNone:false},parentSid);
    if (hit.backendNodeId !== owner.backendNodeId && hit.frameId !== frameId) throw new Error("iframe 被其他元素挡住");
    return this.translatePoint(px,py,parentSid);
  }
  async click(ref: number): Promise<void> {
    const { x, y, password } = await this.actionable(ref);
    if (password) throw new Error("密码字段只能由用户操作");
    await this.beforeVisual?.("click", {x,y});
    this.session.beginAction();
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 }, undefined);
    await this.session.waitForIdle();
  }
  async press(key: string, modifiers = 0, wait = true): Promise<void> {
    const keys: Record<string, [string, string, number]> = { Enter:["Enter","Enter",13], Return:["Enter","Enter",13], Backspace:["Backspace","Backspace",8], Tab:["Tab","Tab",9], Escape:["Escape","Escape",27], ArrowDown:["ArrowDown","ArrowDown",40], ArrowUp:["ArrowUp","ArrowUp",38], ArrowLeft:["ArrowLeft","ArrowLeft",37], ArrowRight:["ArrowRight","ArrowRight",39], Delete:["Delete","Delete",46], Home:["Home","Home",36], End:["End","End",35], Space:[" ","Space",32] };
    const spec = keys[key] ?? (key.length === 1 ? [key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)] : null);
    if (!spec) throw new Error(`不支持的按键：${key}`);
    await this.session.connect();
    let focused: string | undefined; let found=false; let structured=false;
    for(const sid of [undefined,...this.session.sessionIds()]){
      const {result}=await this.send('Runtime.evaluate',{expression:`(()=>{let e=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return {focused:!!e&&!e.matches('iframe,frame,body,html'),password:!!e?.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]')}})()`,returnByValue:true},sid);
      if(result?.value&&typeof result.value==='object'){structured=true;if(result.value.password)throw new Error('密码字段只能由用户操作');if(result.value.focused){if(found)throw new Error('输入焦点不明确');focused=sid;found=true;}}
      else if(result?.value===true)throw new Error('密码字段只能由用户操作');
    }
    if(structured&&!found)throw new Error('输入焦点不明确');
    this.activeSession=focused;
    this.session.beginAction();
    // Do not let press type into a password focused by the user.
    const { result } = await this.send("Runtime.evaluate", { expression: `(()=>{let e=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return !!e?.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]')})()`, returnByValue:true });
    if (result.value) throw new Error("密码字段只能由用户操作");
    const { nodes = [] } = await this.send("Accessibility.getFullAXTree");
    for (const node of nodes as AXNode[]) {
      if (node.backendDOMNodeId && node.properties?.some(p => p.name === "focused" && p.value.value === true)) {
        if ((await this.call(node.backendDOMNodeId, inspect)).password) throw new Error("密码字段只能由用户操作");
      }
    }
    const [value, code, windowsVirtualKeyCode] = spec;
    await this.send("Input.dispatchKeyEvent", { type:"keyDown", key:value, code, windowsVirtualKeyCode, modifiers, ...(value === "Enter" ? { text:"\r" } : value.length === 1 && !modifiers ? { text:value } : {}) });
    await this.send("Input.dispatchKeyEvent", { type:"keyUp", key:value, code, windowsVirtualKeyCode, modifiers });
    if (wait) await this.session.waitForIdle();
  }
  async type(ref: number, text: string, opts: {clear?: boolean; submit?: boolean}): Promise<void> {
    const info = await this.actionable(ref);
    if (info.password) throw new Error("密码字段只能由用户操作");
    const box = await this.call(this.refs.get(ref), `function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}`);
    const start = await this.translatePoint(box.x, box.y, this.activeSession);
    const end = await this.translatePoint(box.x + box.width - 1, box.y + box.height - 1, this.activeSession);
    await this.beforeVisual?.("fill", info, {x:start.x,y:start.y,width:Math.abs(end.x-start.x)+1,height:Math.abs(end.y-start.y)+1});
    await this.call(this.refs.get(ref), `function(){if(!this.matches('input,textarea,[contenteditable="true"],[contenteditable=""]'))throw new Error('元素不可输入');this.focus()}`);
    if (opts.clear ?? true) { await this.press("a", process.platform === "darwin" ? 4 : 2, false); await this.press("Backspace", 0, false); }
    this.session.beginAction();
    await this.send("Input.insertText", { text });
    if (opts.submit) await this.press("Enter", 0, false);
    await this.session.waitForIdle();
  }
  async select(ref: number, value: string): Promise<boolean> {
    await this.actionable(ref); this.session.beginAction();
    const result = await this.call(this.refs.get(ref), `function(value){if(this.tagName!=='SELECT')throw new Error('元素不是 select');const opt=[...this.options].find(o=>o.value===value||o.textContent.trim()===value);if(!opt||opt.disabled)throw new Error('选项不存在或不可用');this.value=opt.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true}`, [value]);
    await this.session.waitForIdle(); return result;
  }
  async scroll(dy: number, ref?: number): Promise<number> {
    this.activeSession = ref === undefined ? undefined : this.refs.session(ref);
    this.session.beginAction();
    if (ref) await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId:this.refs.get(ref) });
    else await this.send("Runtime.evaluate", { expression:`scrollBy({top:${JSON.stringify(dy)},behavior:'instant'})` });
    await this.session.waitForIdle();
    return (await this.send("Runtime.evaluate", { expression:"Math.round(scrollY)", returnByValue:true })).result.value;
  }
  async interactionOrigins(ref?:number):Promise<string[]> {
    await this.session.connect();
    if(ref!==undefined){const sid=this.refs.session(ref);const origin=await this.call(this.refs.get(ref),`function(){return this.ownerDocument.location.origin}`,[],sid);return [origin];}
    const origins=new Set<string>();
    for(const sid of [undefined,...this.session.sessionIds()]){
      const {result}=await this.send('Runtime.evaluate',{expression:`(()=>{const out=[];const walk=w=>{try{out.push(w.location.origin);for(let i=0;i<w.frames.length;i++)walk(w.frames[i]);}catch{}};walk(window);return out})()`,returnByValue:true},sid);
      for(const origin of result.value??[])if(typeof origin==='string')origins.add(origin);
    }
    return [...origins];
  }
  async hover(ref: number): Promise<void> {
    const {x,y,password}=await this.actionable(ref); if(password) throw new Error("密码字段只能由用户操作");
    await this.beforeVisual?.("hover", {x,y});
    this.session.beginAction(); await this.send("Input.dispatchMouseEvent", {type:"mouseMoved",x,y,button:"none"}, undefined); await this.session.waitForIdle();
  }
  async check(ref: number, checked = true): Promise<void> {
    await this.actionable(ref);
    const state=await this.call(this.refs.get(ref), `function(){if(!this.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],[role="switch"]'))throw new Error('元素不是 checkbox/radio/switch');return this.matches('input')?this.checked:this.getAttribute('aria-checked')==='true'}`);
    if (state !== checked) await this.click(ref);
    const actual=await this.call(this.refs.get(ref), `function(){return this.matches('input')?this.checked:this.getAttribute('aria-checked')==='true'}`);
    if(actual!==checked)throw new Error("勾选状态未改变");
  }
  async upload(ref: number, files: string[]): Promise<void> {
    this.activeSession=this.refs.session(ref);
    const info=await this.call(this.refs.get(ref), `function(){return {exists:this.isConnected,disabled:this.matches(':disabled')||this.getAttribute('aria-disabled')==='true',file:this.matches('input[type="file"]'),multiple:this.multiple}}`);
    if(!info.exists||!info.file)throw new Error("元素不是文件输入框");
    if(info.disabled)throw new Error("元素不可用（disabled）");
    if(files.length>1&&!info.multiple)throw new Error("文件输入框不允许多个文件");
    this.session.beginAction(); await this.send("DOM.setFileInputFiles", {backendNodeId:this.refs.get(ref),files}); await this.session.waitForIdle();
  }
  async wait(opts: {kind:'text'|'element'|'url'|'network_idle';text?:string;selector?:string;ref?:number;state?:'visible'|'hidden';url?:string;timeout?:number}): Promise<void> {
    const timeout=Math.max(0,Math.min(opts.timeout??5000,60000));
    if(opts.kind==='network_idle'){await this.session.waitForIdle(timeout,500);return;}
    if(opts.kind==='text'&&!opts.text)throw new Error('等待文字不能为空');
    if(opts.kind==='element'&&opts.ref===undefined&&!opts.selector)throw new Error('等待元素需要 ref 或 selector');
    let initialUrl:string|undefined;
    if(opts.kind==='url'&&!opts.url){initialUrl=(await this.send('Runtime.evaluate',{expression:'location.href',returnByValue:true},undefined)).result.value;}
    const deadline=Date.now()+timeout;
    do {
      await this.checkpoint?.();
      let matched=false;
      try {this.activeSession=opts.ref===undefined?undefined:this.refs.session(opts.ref);} catch(error){if(opts.kind==='element'&&opts.state==='hidden')return;throw error;}
      if(opts.kind==='element'&&opts.ref!==undefined){
        try {const info=await this.call(this.refs.get(opts.ref),inspect);matched=opts.state==='hidden'?!info.exists||!info.visible:info.exists&&info.visible;} catch {matched=opts.state==='hidden';}
      }else{
        const expression=opts.kind==='url'?opts.url ? `location.href===${JSON.stringify(opts.url)}` : `location.href!==${JSON.stringify(initialUrl)}`
          :opts.kind==='text'?`(()=>{const w=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const e=n.parentElement;if(!e||e.closest('script,style,input[type="password"],textarea'))continue;const s=getComputedStyle(e);if(!e.getClientRects().length||s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<=0.05)continue;if(n.textContent.includes(${JSON.stringify(opts.text??'')}))return true;}return false})()`
          :`(()=>{const e=document.querySelector(${JSON.stringify(opts.selector??'')});const s=e&&getComputedStyle(e);const visible=!!e&&e.getClientRects().length>0&&s.visibility!=='hidden'&&s.display!=='none';return ${opts.state==='hidden'?'!visible':'visible'}})()`;
        const result=await this.send('Runtime.evaluate',{expression,returnByValue:true});if(result.exceptionDetails)throw new Error('等待条件无效');matched=result.result.value===true;
      }
      if(matched)return; if(Date.now()<deadline)await new Promise(r=>setTimeout(r,Math.min(50,deadline-Date.now())));
    }while(Date.now()<deadline);
    throw new Error(`等待 ${opts.kind} 超时`);
  }
  async extract(opts:{kind:'table'|'list';ref?:number;selector?:string}):Promise<any> {
    const fn=`function(kind){const clean=e=>{const clone=e.cloneNode(true);clone.querySelectorAll('input,textarea,script,style').forEach(n=>n.remove());return (clone.textContent||'').trim().replace(/\\s+/g,' ').slice(0,2000)};if(kind==='table'){const table=this.matches('table,[role="table"],[role="grid"]')?this:this.querySelector('table,[role="table"],[role="grid"]');if(!table)throw new Error('未找到表格');const rows=[...table.querySelectorAll('tr,[role="row"]')].filter(r=>r.closest('table,[role="table"],[role="grid"]')===table).slice(0,500).map(r=>[...r.querySelectorAll('th,td,[role="cell"],[role="columnheader"],[role="rowheader"]')].map(clean));return {kind:'table',rows};}const list=this.matches('ul,ol,[role="list"]')?this:this.querySelector('ul,ol,[role="list"]');if(!list)throw new Error('未找到列表');return {kind:'list',items:[...list.querySelectorAll('li,[role="listitem"]')].filter(e=>e.closest('ul,ol,[role="list"]')===list).slice(0,500).map(clean)}}`;
    if(opts.ref!==undefined){this.activeSession=this.refs.session(opts.ref);return this.call(this.refs.get(opts.ref),fn,[opts.kind]);}
    this.activeSession=undefined;
    const expression=`(()=>{const e=document.querySelector(${JSON.stringify(opts.selector??(opts.kind==='table'?'table,[role="table"],[role="grid"]':'ul,ol,[role="list"]'))});if(!e)throw new Error('未找到抽取目标');return (${fn}).call(e,${JSON.stringify(opts.kind)})})()`;
    const result=await this.send('Runtime.evaluate',{expression,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'抽取失败');return result.result.value;
  }

}
