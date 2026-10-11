import type { FileInput } from "@shared/types";

/** Text kept per file: roughly 30K tokens, so a couple of files still leave room for the conversation. */
const MAX_CHARS = 100_000;
/** Bigger files aren't read at all; they are almost never something to paste into a chat. */
const MAX_BYTES = 20 * 1024 * 1024;

export interface FileAttachment {
  id: string;
  file: FileInput;
}

/** Read a picked, pasted or dropped non-image file: plain text and code as is, PDFs by their text layer. */
export async function prepareFile(blob: File): Promise<FileAttachment> {
  const name = blob.name || "文件";
  if (blob.size > MAX_BYTES) throw new Error(`${name} 太大了（超过 20 MB）`);
  const isPdf = blob.type === "application/pdf" || /\.pdf$/i.test(name);
  const raw = isPdf ? await pdfText(blob, name) : await plainText(blob, name);
  const text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
  return {
    id: crypto.randomUUID(),
    file: { name, text, size: blob.size, ...(raw.length > MAX_CHARS ? { truncated: true } : {}) },
  };
}

async function plainText(blob: Blob, name: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // A NUL byte near the start means a binary file (zip, exe, Word…), not text.
  if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${name} 不是文本文件，暂时只能读代码、文本和 PDF`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Older Chinese text files are often GBK.
    return new TextDecoder("gbk").decode(bytes);
  }
}

async function pdfText(blob: Blob, name: string): Promise<string> {
  // Loaded on first use: pdf.js is large and most chats never see a PDF.
  const pdfjs = await import("pdfjs-dist");
  const { default: workerSrc } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new Error((e as Error).name === "PasswordException" ? `${name} 有密码，打不开` : `${name} 打不开，可能已损坏`);
  }
  const pages: string[] = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total <= MAX_CHARS; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
    pages.push(`--- 第 ${i} 页 ---\n${text.trim()}`);
    total += text.length;
  }
  void task.destroy();
  if (!pages.some((p) => p.split("\n").slice(1).join("").trim()))
    throw new Error(`${name} 里没有可以读取的文字（可能是扫描件），可以截图发给我`);
  return pages.join("\n\n");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
