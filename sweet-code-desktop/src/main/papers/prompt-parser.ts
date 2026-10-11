import type { PromptPreset } from '../../shared/types.ts';
interface Token { kind: 'string' | 'symbol'; value: string }
/** Tokenize only, never evaluate Python. Non-string expressions are deliberately refused. */
function tokenize(source: string): Token[] {
  const out: Token[] = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (source[i] === '\\' && source[i+1] === '\n') { i += 2; continue; }
    const prefix = source.slice(i).match(/^([rRuUbBfF]{0,2})(['"])/);
    if (prefix) {
      const flags = prefix[1].toLowerCase(); i += flags.length;
      const q = source[i]; const delim = source.slice(i,i+3) === q.repeat(3) ? q.repeat(3) : q; i += delim.length;
      let value = ''; let closed = false;
      while (i < source.length) {
        if (source.slice(i,i+delim.length) === delim) { i += delim.length; closed = true; break; }
        if (source[i] !== '\\') { value += source[i++]; continue; }
        const next = source[i+1];
        if (next === undefined) { i++; break; }
        if (flags.includes('r')) { value += source.slice(i,i+2); i += 2; continue; }
        i += 2;
        const escapes: Record<string,string> = {n:'\n',r:'\r',t:'\t',a:'\x07',b:'\b',f:'\f',v:'\v', '\\':'\\', "'":"'", '"':'"', '\n':''};
        if (next in escapes) value += escapes[next];
        else if (/[0-7]/.test(next)) { const digits = (next + source.slice(i)).match(/^[0-7]{1,3}/)![0]; value += String.fromCodePoint(parseInt(digits,8)); i += digits.length-1; }
        else if (/[xuU]/.test(next)) { const len = next === 'x' ? 2 : next === 'u' ? 4 : 8; const hex = source.slice(i,i+len); if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex) || parseInt(hex,16) > 0x10ffff) throw new Error('提示词文件含无效转义'); value += String.fromCodePoint(parseInt(hex,16)); i += len; }
        else value += '\\' + next;
      }
      if (!closed) throw new Error('提示词文件的字符串不完整');
      out.push({kind: flags.includes('f') || flags.includes('b') ? 'symbol' : 'string', value});
    } else { out.push({kind:'symbol',value:source[i++]}); }
  }
  return out;
}
function literal(tokens: Token[]): string | undefined {
  let i = 0;
  function expr(): string | undefined {
    let result = ''; let has = false; let need = false;
    while (i < tokens.length && !(tokens[i].kind === 'symbol' && tokens[i].value === ')')) {
      const t = tokens[i++];
      if (t.kind === 'string') { result += t.value; has = true; need = false; }
      else if (t.value === '(') { const inner = expr(); if (inner === undefined || tokens[i++]?.value !== ')') return; result += inner; has = true; need = false; }
      else if (t.value === '+' && has && !need) need = true;
      else return;
    }
    return has && !need ? result : undefined;
  }
  const value = expr(); return i === tokens.length ? value : undefined;
}
export function parsePromptPack(source: string): PromptPreset[] {
  if (source.length > 2000000) throw new Error('提示词文件太大');
  const t = tokenize(source); const presets: PromptPreset[] = [];
  for (let i = 0; i < t.length-2; i++) {
    if (t[i].kind !== 'string' || t[i+1].kind !== 'symbol' || t[i+1].value !== ':' || t[i+2].kind !== 'symbol' || t[i+2].value !== '{') continue;
    const name = t[i].value; let depth = 1; let end = i+3;
    for (; end < t.length && depth; end++) { if (t[end].kind === 'symbol' && t[end].value === '{') depth++; if (t[end].kind === 'symbol' && t[end].value === '}') depth--; }
    if (depth) continue;
    const fields: Record<string,string|undefined> = {}; let level = 0;
    for (let j = i+3; j < end-1; j++) {
      if (t[j].kind === 'symbol' && ['{','[','('].includes(t[j].value)) level++;
      if (t[j].kind === 'symbol' && ['}',']',')'].includes(t[j].value)) level--;
      if (level !== 0 || t[j].kind !== 'string' || !['Prefix','Suffix'].includes(t[j].value) || t[j+1]?.value !== ':') continue;
      let k = j+2; let nesting = 0;
      for (; k < end-1; k++) { const v = t[k]; if (v.kind === 'symbol' && nesting === 0 && v.value === ',') break; if (v.kind === 'symbol' && ['(','[','{'].includes(v.value)) nesting++; if (v.kind === 'symbol' && [')',']','}'].includes(v.value)) nesting--; }
      fields[t[j].value] = literal(t.slice(j+2,k)); j = k;
    }
    if (typeof fields.Prefix === 'string' && (!('Suffix' in fields) || typeof fields.Suffix === 'string')) presets.push({ id: `gpt_academic:${presets.length+1}`, name, prefix: fields.Prefix, suffix: fields.Suffix ?? '', origin: 'gpt_academic' });
  }
  return presets;
}
