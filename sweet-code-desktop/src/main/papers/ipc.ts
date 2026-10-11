import type { PaperService } from './service.ts';
export function registerPaperIpc(handle: (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => void, service: PaperService, pickPdf: () => Promise<string[]>) {
  const methods: Record<string,(...args: unknown[]) => unknown> = {
    'paper:list':()=>service.list(), 'paper:pickPdf':async()=>{const out=[];for(const file of await pickPdf()) out.push(await service.import({kind:'file',path:file}));return out;},
    'paper:import':s=>service.import(s), 'paper:get':id=>service.get(id), 'paper:delete':id=>service.delete(id),
    'paper:summarize':id=>service.start('summarize',[id]), 'paper:translate':(id,lang)=>service.start('translate',[id],lang), 'paper:extract':ids=>service.start('extract',ids), 'paper:cancel':id=>service.cancel(id), 'paper:tasks':()=>service.taskList(),
    'evidence:save':(name,records)=>service.evidenceSave(name,records), 'evidence:list':()=>service.evidenceList(), 'evidence:load':file=>service.evidenceLoad(file), 'paper:export':id=>service.export(id), 'writing:run':req=>service.writingRun(req),
    'arxiv:lookup':id=>{if(typeof id!=='string')throw new Error('请填写 arXiv 编号或链接');return service.arxiv.lookup(id);}, 'arxiv:search':(q,start)=>{if(typeof q!=='string'||(start!==undefined&&typeof start!=='number'))throw new Error('检索词或起始位置不正确');return service.arxiv.search(q,start as number|undefined);}, 'arxiv:consent':()=>service.consent(), 'arxiv:grantConsent':()=>service.grantConsent(),
    'prompts:list':()=>service.presets(), 'prompts:save':p=>service.savePreset(p), 'prompts:delete':id=>service.deletePreset(id), 'prompts:packState':()=>service.packState(), 'prompts:packImport':()=>service.packImport(), 'prompts:packRemove':()=>service.packRemove(),
  };
  for(const [channel,method] of Object.entries(methods)) handle(channel,async(_event,...args)=>{try{return await method(...args);}catch(e){throw new Error(`论文工坊：${e instanceof Error ? e.message : '处理失败，请重试'}`);}});
}
