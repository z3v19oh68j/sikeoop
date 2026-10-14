import { safeUrl, type DiskBody } from '../../src/main/image-prompts/schema.ts';
export const forbiddenCharacters=/[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFFF9-\uFFFB\u{E0100}-\u{E01EF}\uFEFF\u00AD\u061C\u115F\u1160\u180E\u3164\uFFA0\u0080-\u009F\u{E0000}-\u{E007F}\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u;
export function cleanText(s:string):string{return s.normalize('NFKC').replace(new RegExp(forbiddenCharacters.source,'gu'),'').trim();}
export function cleanUrl(s:unknown):string|undefined{if(typeof s!=='string')return;const raw=safeUrl(cleanText(s));if(!raw||!raw.startsWith('https:'))return;const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(k.toLowerCase().startsWith('utm_')||['ref','via','ref_src','ref_url','s','t','fbclid','gclid','aff','invite','share'].includes(k.toLowerCase()))u.searchParams.delete(k);return u.href;}
export function language(s:string):'zh'|'en'|'other'{return /[\u3040-\u30ff\uac00-\ud7af]/.test(s)?'other':/[\u3400-\u9fff]/.test(s)?'zh':/[a-zA-Z]/.test(s)?'en':'other';}
export function cleanVariants(input:DiskBody['variants']):{variants:DiskBody['variants'];hasVars:boolean}{let hasVars=false;const variants:DiskBody['variants']=[];for(const v of input){if(!v||!Array.isArray(v.steps)||v.steps.some(s=>typeof s?.text!=='string'))continue;const steps=v.steps.map(s=>({...s,label:s.label?cleanText(s.label):undefined,text:cleanText(s.text).replace(/\{argument[^}]*\}/g,m=>m.replaceAll('\\"','"')).replace(/\{argument\s+name="([^"]+)"(?:\s+default="([^"]*)")?\s*\}/g,(_,name,def)=>{hasVars=true;return '['+(def??name)+']';})}));if(steps.some(s=>substantiveText(s.text).length<20||s.text.length>20000||s.text.includes('原文未公开')))continue;const split=steps.length===1&&steps[0].text.match(/\[中文\]([\s\S]*?)\[English\]([\s\S]*)/i);if(split){for(const [lang,text] of [['zh',split[1]],['en',split[2]]] as const)if(text.trim().length>=20)variants.push({lang,steps:[{text:text.trim()}]});}else variants.push({lang:v.lang,steps});}if(variants.flatMap(v=>v.steps).reduce((n,s)=>n+s.text.length,0)>20000)return {variants:[],hasVars};return {variants,hasVars:hasVars||variants.some(v=>v.steps.some(s=>/\[[^\]]+\]/.test(s.text)))};}

export function substantiveText(s:string):string{return s.replace(/https?:\/\/[^\s<>]+/gi,'').replace(/(?:原文链接|原帖链接|原文|链接|source\s*link|original\s*(?:post|link)|source)\s*[:：]?/gi,'').replace(/[\s:：()[\]<>]/g,'');}
export function cleanAuthor(raw:unknown):string|undefined {
 if(typeof raw!=='string')return;
 let s=cleanText(raw).replace(/\\/g,'');
 s=s.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'');
 s=s.replace(/(?:微信|VX|wx|QQ群)\s*[:：]?\s*[^，,;；)\n]*/gi,'')
 .replace(/(?:小红书|抖音|微博)(?:号|账号|ID)\s*[:：]?\s*[^\s，,;；)]+/gi,m=>m.match(/^(小红书|抖音|微博)/)![0])
 .replace(/(?:原创实测|原创|公众号文章|关注|加微信|联系我|商务合作|扫码)[\s\S]*$/,'').trim();
 for(const re of [/^\*\*(.*?)\*\*$/s,/^_(.*?)_$/s,/^\*(.*?)\*$/s])s=s.replace(re,'$1');
 s=s.replace(/\(([^()]*)\)/g,'$1').replace(/（([^（）]*)）/g,'$1').replace(/[()[\]<>]/g,'').trim();
 return !s||/^(?:小红书|公众号|微博|抖音|X|Twitter|微信)$/i.test(s)?undefined:s;
}
