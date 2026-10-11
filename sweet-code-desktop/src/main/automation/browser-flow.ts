import { flowName } from '../browser/flows.ts';
/** browser_flow nodes keep the existing text field; no old graph fields change. */
export function parseBrowserFlowNode(text:string):{name:string;vars:Record<string,string>} {
  const raw=JSON.parse(text);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('浏览器脚本节点需 JSON {name, vars?}');
  flowName(raw.name);
  if(raw.vars!==undefined&&(!raw.vars||typeof raw.vars!=='object'||Array.isArray(raw.vars)||Object.values(raw.vars).some(v=>typeof v!=='string')))throw new Error('脚本变量必须是字符串字典');
  return {name:raw.name,vars:raw.vars??{}};
}
