import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { sha } from "../wiki/store";

// Plain text out of the documents a graph can be built from: Markdown and text as they are,
// Word (.docx) from its document.xml, PDF from its text layer.

export const DOC_EXT = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".pdf", ".docx"]);
const MAX_BYTES = 30 * 1024 * 1024;

export interface DocText {
  text: string;
  /** sha256 of the file's bytes, to tell when it changed. */
  hash: string;
  /** Text is the file itself (Markdown, txt), so a quote's position is a real line number. */
  lineExact: boolean;
}

export async function readDocument(abs: string): Promise<DocText> {
  const name = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();
  if (!DOC_EXT.has(ext)) throw new Error(`${name} 不是支持的文档格式（支持 .md .txt .pdf .docx）`);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_BYTES) throw new Error(`${name} 太大了（超过 30 MB）`);
  const bytes = new Uint8Array(await fs.readFile(abs));
  const hash = sha(Buffer.from(bytes).toString("base64"));
  let text: string;
  if (ext === ".pdf") text = await pdfText(bytes, name);
  else if (ext === ".docx") text = docxText(bytes, name);
  else text = decode(bytes);
  if (!text.trim()) throw new Error(`${name} 里没有可以读取的文字`);
  return { text, hash, lineExact: ext !== ".pdf" && ext !== ".docx" };
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Older Chinese text files are often GBK.
    return new TextDecoder("gbk").decode(bytes);
  }
}

/** Paragraphs of word/document.xml, with Word's headings turned into Markdown ones. */
function docxText(bytes: Uint8Array, name: string): string {
  let xml: string;
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
    xml = new TextDecoder().decode(files["word/document.xml"]);
  } catch {
    throw new Error(`${name} 打不开，可能已损坏，或者是旧版 .doc 格式（请另存为 .docx）`);
  }
  if (!xml) throw new Error(`${name} 不是有效的 Word 文档`);
  const out: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const style = para.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? "";
    // "Heading2", "2", "标题 2" depending on the Word language.
    const level = /heading|标题|^\d$/i.test(style) ? Number(style.match(/\d/)?.[0] ?? 0) : 0;
    const text = para
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<[^>]+>/g, (_m, t: string | undefined) => t ?? "")
      .replace(/&(lt|gt|amp|quot|apos);/g, (_m, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]!)
      .trim();
    if (text) out.push(level > 0 && level < 7 ? `${"#".repeat(level)} ${text}` : text);
  }
  return out.join("\n\n");
}

async function pdfText(bytes: Uint8Array, name: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new Error((e as Error).name === "PasswordException" ? `${name} 有密码，打不开` : `${name} 打不开，可能已损坏`);
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      pages.push(`--- 第 ${i} 页 ---\n${text.trim()}`);
    }
    if (!pages.some((p) => p.split("\n").slice(1).join("").trim())) throw new Error(`${name} 里没有可以读取的文字（可能是扫描件）`);
    return pages.join("\n\n");
  } finally {
    void task.destroy();
  }
}
