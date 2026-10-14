import type { DiskCard } from '../../src/main/image-prompts/schema.ts';
export function matchesWord(text:string,word:string):boolean {
 const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp((/^[\x00-\x7f]+$/.test(word)?'(?<![a-z0-9])':'')+escaped+(/^[\x00-\x7f]+$/.test(word)?'(?![a-z0-9])':''),'iu').test(text);
}
// Context gates intentionally favor precision over recall; camera manufacturers are not brand rules.
const exclusions=['mona lisa','蒙娜丽莎','麝香','eva foam','eva material','eva copolymer','eva 泡棉','EVA材质'];
const fictional=/(?:虚构|虚拟|杜撰|架空).{0,12}(?:品牌|商标)|(?:fictional|fictitious|imaginary|invented|made[- ]up)\s+(?:brand|company|logo)/iu;
const subject=/(?:logo|logotype|wordmark|trademark|branding|branded|brand|advert|product|packaging|bottle|can\b|sneaker|shoe|store|car\b|vehicle|phone|iphone|macbook|ipad|商标|标志|品牌|标识|海报|广告|产品|包装|瓶|罐|球鞋|运动鞋|汽车|跑车|手机|门店|饮料)/iu;
export function flagHits(text:string,rules:Record<string,string[]>,source?:string):Record<string,string[]> {
 let corpus=text.normalize('NFKC');
 for(const phrase of exclusions)corpus=corpus.replace(new RegExp(phrase,'gi'),'');
 corpus=corpus.replace(/Google Fonts?|\-apple-system|Apple Pay|Apple Color Emoji|SF Pro/gi,'');
 const hits:Record<string,string[]>={};
 for(const [flag,words] of Object.entries(rules)){
  if(flag==='brand'&&(fictional.test(corpus)))continue;
  const found=words.filter(word=>{
   if(!matchesWord(corpus,word))return false;
   if(flag==='suggestive')return matchesWord(sexualCorpus(corpus),word);
   if(flag==='real-person'&&word==='Musk')return /\bMusk\b/.test(corpus)&&!/(?:perfume|fragrance|scent|香水|香氛|麝香)/iu.test(corpus);
   if(flag!=='brand')return true;
   // A real brand needs nearby visual-subject context, never just a lens/style citation.
   const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const re=new RegExp((/^[\x00-\x7f]+$/.test(word)?'(?<![a-z0-9])':'')+escaped+(/^[\x00-\x7f]+$/.test(word)?'(?![a-z0-9])':''),'giu');
   return [...corpus.matchAll(re)].some(m=>{
    const context=corpus.slice(Math.max(0,m.index!-70),m.index!+word.length+70);
    if(/(?:shot (?:on|with)|camera|lens|\d+mm|摄影参数|镜头|拍摄参数)/iu.test(context)&&!/(?:logo|wordmark|trademark|商标|标志)/iu.test(context))return false;
    if(/^(?:youtube|instagram|amazon|chatgpt|google|microsoft|spotify|netflix|tiktok|facebook)$/iu.test(word)&&!/(?:logo|wordmark|trademark|商标|标志|标识|界面|截图|interface|screenshot)/iu.test(context))return false;
    if(new RegExp(escaped+'\\s*(?:style|aesthetic|风格|美学)','iu').test(corpus.slice(m.index!,m.index!+word.length+20))&&!/(?:logo|wordmark|trademark|商标|标志|标识)/iu.test(context))return false;
    if(word.toLowerCase()==='apple'&&/apple (?:fruit|pie|tree|orchard)|green apple|red apple/iu.test(context))return false;
    if(word==='LV'&&/\b(?:lv\.?\s*\d|level|left ventricle)\b/iu.test(context))return false;
    return subject.test(context)||/^(?:Xiaomi|iPhone|Samsung|Huawei|MacBook|iPad)$/iu.test(word)&&/^\s+\d/.test(corpus.slice(m.index!+word.length));
   });
  });
  if(found.length)hits[flag]=found;
 }
 return hits;
}
export function matchFlags(text:string,rules:Record<string,string[]>,source?:string):DiskCard['flags'] {
 return Object.keys(flagHits(text,rules,source)) as DiskCard['flags'];
}
export function sexualCorpus(text:string):string {
 return text.replace(/\bnude\b(?=\s*,?\s*(?:and\s+)?monochrome\s+palettes?)/giu,'').replace(/\b(?:no\s+|not\s+|without\s+|non[- ])(?:explicitly\s+|overtly\s+)?(?:nudity|nude|naked|lingerie|sexualized|sexual|sexy|sensual|erotic|cleavage|bikini)\b/giu,'').replace(/(?:不要|不含|禁止|没有|避免|无|非)\s*(?:性感|裸露|裸体|性化|内衣|色情|诱惑)/gu,'').replace(/\b(?:nude|naked)\s+(?:colou?rs?|tones?|palette|layout|design|interface|UI|glyphs?|chevron|SVGs?|inline)\b/giu,'').replace(/\b(?:nude|naked)\b(?=\s*[-–:]?\s*(?:色|配色|布局))/giu,'');
}
export const minorWords=['teen','teenage','teenager','preteen','mid-teens','early teens','late teens','minor','underage','kid','child','children','little girl','little boy','young girl','schoolgirl','schoolboy','loli','lolita','shota','未成年','小学生','初中生','高中生','中学生','初中女生','高中女生','女童','男童','幼女','儿童','孩童','萝莉','正太'];
export const sexualWords=['裸露','裸体','全裸','半裸','性感','泳装','泳衣','比基尼','内衣','丝袜','过膝袜','吊带','湿身','透视','大腿','胸部','臀部','曲线','诱惑','撩人','性化','色情','lingerie','bikini','swimsuit','swimwear','underwear','stockings','thigh','thighs','cleavage','seductive','sensual','erotic','provocative','revealing','nude','naked','nudity','sexy','sexual','sexualized','topless','nipples','panties','thong','breasts','buttocks'];
export function minorHits(text:string):{minor:string[];sexual:string[]} {
 const corpus=text.normalize('NFKC'),minor=minorWords.filter(w=>matchesWord(corpus,w));
 const ages=/(?<![\d])(?:[0-9]|1[0-7])\s*(?:[- ]?years?[- ]?old\b|y\s*\/\s*o\b|yo\b|岁|歲)|\b(?:aged?|age\s*:)\s*(?:[0-9]|1[0-7])(?!\d)|年龄\s*[:：]\s*(?:[0-9]|1[0-7])(?!\d)|(?<![零一二三四五六七八九十百])(?:十[一二三四五六七]?|[一二三四五六七八九])\s*[岁歲]/giu;
 minor.push(...[...corpus.matchAll(ages)].map(m=>m[0]));
 if(/\bJK\b.{0,15}(?:制服|uniform|schoolgirl|高中)|(?:制服|uniform|高中).{0,15}\bJK\b/iu.test(corpus))minor.push('JK');
 return {minor:[...new Set(minor)],sexual:sexualWords.filter(w=>matchesWord(sexualCorpus(corpus),w))};
}
export function minorSexualized(text:string,_flags?:DiskCard['flags']):boolean {const h=minorHits(text);return !!(h.minor.length&&h.sexual.length);}
