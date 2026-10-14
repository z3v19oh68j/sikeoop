export function blocks(s:string):string[]{return [...s.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1\s*$/gm)].map(m=>m[2].trim());}
export function sections(s:string,re:RegExp):{heading:string;text:string}[]{const matches=[...s.matchAll(re)];return matches.map((m,i)=>({heading:m[1],text:s.slice(m.index!+m[0].length,matches[i+1]?.index??s.length)}));}
