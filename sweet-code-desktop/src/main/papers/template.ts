import type { CslStyleId, PaperTemplateRequest } from "@shared/types";

// The new-paper template: a Quarto document with title, authors, abstract, a references.bib and a
// citation style. Text only; writing the files is the service's job.

/**
 * The two default citation styles. The files come from the official CSL style repository
 * (github.com/citation-style-language/styles), which is licensed CC BY-SA 3.0; each file names
 * its authors and the licence in its own <info> block. sikeoop does not ship them: a file is
 * fetched the first time it is used, after the user has been told where it comes from, and is
 * saved unchanged, so the attribution travels with it.
 */
export const CSL_STYLES: Record<CslStyleId, { title: string; file: string; url: string; license: string; /** Typst's own name for the style, used for PDF when the file isn't there. */ typst: string }> = {
  gbt7714: {
    title: "GB/T 7714-2015（顺序编码制）",
    file: "china-national-standard-gb-t-7714-2015-numeric.csl",
    url: "https://raw.githubusercontent.com/citation-style-language/styles/master/china-national-standard-gb-t-7714-2015-numeric.csl",
    license: "CC BY-SA 3.0",
    typst: "gb-7714-2015-numeric",
  },
  apa: {
    title: "APA 第 7 版",
    file: "apa.csl",
    url: "https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl",
    license: "CC BY-SA 3.0",
    typst: "apa",
  },
};

/** A fetched style file is what it should be: CSL XML that names its licence. */
export function looksLikeCsl(text: string): boolean {
  return text.length > 500 && text.length < 2_000_000 && /<style\b[^>]*xmlns="http:\/\/purl\.org\/net\/xbiblio\/csl"/.test(text) && /<rights\b/.test(text);
}

/** A YAML double-quoted string. */
const quoted = (s: string) => `"${s.replace(/[\r\n\t]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim()}"`;

/** A font for the body that has Chinese characters, per system. */
export function cjkFont(platform: NodeJS.Platform): string {
  return platform === "win32" ? "SimSun" : platform === "darwin" ? "Songti SC" : "Noto Serif CJK SC";
}

/**
 * The document. `cslFile`: the style file beside the document, when there is one; all three
 * outputs then use it. Without it, PDF uses Typst's built-in style of the same standard, and
 * Word / HTML fall back to Pandoc's default until a style file is added.
 */
export function paperTemplate(req: Pick<PaperTemplateRequest, "title" | "authors" | "abstract" | "lang" | "csl">, opts: { cslFile?: string; platform: NodeJS.Platform }): string {
  const zh = req.lang === "zh";
  const style = CSL_STYLES[req.csl];
  const authors = req.authors.map((a) => a.trim()).filter(Boolean);
  const abstract = req.abstract.trim() || (zh ? "在这里写摘要。" : "Write the abstract here.");
  const head = [
    "---",
    `title: ${quoted(req.title)}`,
    ...(authors.length ? ["author:", ...authors.map((a) => `  - name: ${quoted(a)}`)] : []),
    "abstract: |",
    ...abstract.split(/\r?\n/).map((l) => `  ${l.trimEnd()}`),
    `lang: ${zh ? "zh" : "en"}`,
    "bibliography: references.bib",
    ...(opts.cslFile ? [`csl: ${quoted(opts.cslFile)}`] : []),
    "number-sections: true",
    "format:",
    "  typst:",
    ...(opts.cslFile ? [] : [`    csl: ${style.typst}`]),
    ...(zh ? [`    mainfont: ${quoted(cjkFont(opts.platform))}`] : []),
    "    papersize: a4",
    "  docx: default",
    "  html:",
    "    embed-resources: true",
    "---",
  ];
  const body = zh
    ? [
        "# 引言",
        "",
        "在这里写正文。引用文献写成 `[@citekey]`，多篇写成 `[@key1; @key2]`；在 sikeoop 的「引用与排版」里可以直接从 Zotero 插入。",
        "",
        "# 方法",
        "",
        "# 结果",
        "",
        "# 讨论",
        "",
        "# 参考文献",
        "",
        "::: {#refs}",
        ":::",
      ]
    : [
        "# Introduction",
        "",
        "Write here. Cite as `[@citekey]`, several as `[@key1; @key2]`; sikeoop can insert citations from Zotero.",
        "",
        "# Methods",
        "",
        "# Results",
        "",
        "# Discussion",
        "",
        "# References",
        "",
        "::: {#refs}",
        ":::",
      ];
  return [...head, "", ...body, ""].join("\n");
}

/** A references.bib to start from: empty apart from a line saying where entries come from. */
export function emptyBib(): string {
  return "% 这个文件由 sikeoop 的「引用与排版」从 Zotero 同步；手动加的条目会保留。\n";
}

/** The request as the service uses it; throws what is wrong in plain words. */
export function checkTemplateRequest(input: unknown): PaperTemplateRequest {
  if (!input || typeof input !== "object") throw new Error("新建论文的请求格式不正确");
  const r = input as PaperTemplateRequest;
  const dir = typeof r.dir === "string" ? r.dir.trim().replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, "") : "";
  if (dir.length > 200 || dir.split("/").some((p) => p === ".." || /[<>:"|?*\u0000-\u001f]/.test(p)) || dir.startsWith("/")) throw new Error("文件夹要写成项目里的相对路径");
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,79}$/u.test(name) || /[. ]$/.test(name)) throw new Error("文件名只能用文字、数字、空格、点、横线和下划线");
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 300) throw new Error("请填写论文标题（300 字以内）");
  if (!Array.isArray(r.authors) || r.authors.length > 30 || !r.authors.every((a) => typeof a === "string" && a.length <= 100)) throw new Error("作者最多 30 位");
  if (typeof r.abstract !== "string" || r.abstract.length > 5000) throw new Error("摘要请控制在 5000 字以内");
  if (r.lang !== "zh" && r.lang !== "en") throw new Error("语言只能是中文或英文");
  if (!(r.csl in CSL_STYLES)) throw new Error("引用格式不正确");
  return { dir, name, title: r.title.trim(), authors: r.authors.map((a) => a.trim()).filter(Boolean), abstract: r.abstract, lang: r.lang, csl: r.csl, downloadCsl: r.downloadCsl === true };
}
