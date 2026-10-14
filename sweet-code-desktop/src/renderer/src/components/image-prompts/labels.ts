import type { ImagePromptCategory, ImagePromptFlag, ImagePromptLang, ImagePromptLicense, ImagePromptModel } from "@shared/types";

// 提示词库里用到的中文叫法。数据一律当纯文本用，这里只是把代号翻成大白话。

export const CATEGORY_LABEL: Record<ImagePromptCategory, string> = {
  portrait: "人像写真", poster: "海报与排版", product: "产品与电商", ui: "界面与网页", infographic: "信息图与图表",
  illustration: "插画与艺术", character: "角色与 IP", photo: "摄影与写实", brand: "品牌与标志", space: "建筑与空间",
  edit: "改图与参考图", fun: "创意玩法", other: "其他",
};

export const LANG_LABEL: Record<ImagePromptLang, string> = { zh: "中文", en: "English", other: "其他语言" };

export const MODEL_LABEL: Record<ImagePromptModel, string> = { "gpt-image-2": "GPT Image 2", "gpt-image-2.5": "GPT Image 2.5", other: "其他模型" };

export const FLAG_LABEL: Record<ImagePromptFlag, { label: string; hint: string }> = {
  "real-person": { label: "涉及真人", hint: "提示词里提到了真实人物，生成前请留意肖像相关的规定。" },
  ip: { label: "涉及知名角色", hint: "提示词里提到了受版权保护的角色或作品。" },
  brand: { label: "涉及品牌", hint: "提示词里提到了真实品牌或商标。" },
  suggestive: { label: "画面偏暴露", hint: "画面可能有偏暴露的内容，公开场合使用前请先看一眼。" },
};

export const LICENSE_LABEL: Record<ImagePromptLicense, { label: string; hint: string; warn: boolean }> = {
  MIT: { label: "MIT", hint: "MIT 许可：可以自由使用，保留来源声明即可。", warn: false },
  "CC-BY-4.0": { label: "CC BY 4.0", hint: "CC BY 4.0 许可：可以使用，但需要按要求署名。", warn: false },
  none: { label: "没写许可证", hint: "来源库没有写许可证，个人参考没问题，商用前请先联系作者。", warn: true },
  unclear: { label: "许可不清楚", hint: "来源库对许可的说法前后不一致，商用前请先确认。", warn: true },
  reserved: { label: "保留权利", hint: "来源明确不授权使用正文，只适合自己看，不要转用。", warn: true },
};

// 下面几个取叫法的小函数：先用本地中文映射，映射不到（后端多给了新代号）再用后端给的文字，都没有就写「其他」。
// 永远不会把英文代号原样摆给用户（后端给的 label 如果和 id 一样，也当作没有）。
const pick = (map: Record<string, string>, id: string, fallback: string | undefined, other: string) =>
  map[id] ?? (fallback && fallback !== id ? fallback : other);

export const categoryName = (id: string, fallback?: string) => pick(CATEGORY_LABEL, id, fallback, "其他分类");
export const modelName = (id: string, fallback?: string) => pick(MODEL_LABEL, id, fallback, "其他模型");
export const langName = (id: string, fallback?: string) => pick(LANG_LABEL, id, fallback, "其他语言");

const UNKNOWN_FLAG = { label: "需要留意", hint: "这条提示词带有一个需要留意的内容标记，使用前请先看一眼。" };
export const flagInfo = (id: string): { label: string; hint: string } => (FLAG_LABEL as Record<string, { label: string; hint: string }>)[id] ?? UNKNOWN_FLAG;

const UNKNOWN_LICENSE = { label: "许可不清楚", hint: "没有拿到这个来源的许可信息，商用前请先确认。", warn: true };
export const licenseInfo = (id: string): { label: string; hint: string; warn: boolean } => (LICENSE_LABEL as Record<string, { label: string; hint: string; warn: boolean }>)[id] ?? UNKNOWN_LICENSE;

/** 只放行 http / https 链接；其他协议（javascript:、data: 等）一律不渲染成链接。 */
export function safeHref(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 把「[占位内容]」从正文里切出来，供界面高亮。只切字符串，结果仍按纯文本渲染。 */
export function splitVars(text: string): { text: string; v: boolean }[] {
  const out: { text: string; v: boolean }[] = [];
  const re = /\[[^\]\n]{1,80}\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), v: false });
    out.push({ text: m[0], v: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), v: false });
  return out;
}
