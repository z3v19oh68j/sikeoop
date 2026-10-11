import { promises as fs } from "node:fs";
import path from "node:path";
import type { PublishScanResult, PublishWarning } from "@shared/types";
import { isInside } from "../workspace";

const ALLOWED = new Set("html css js mjs json txt svg png jpg jpeg gif webp avif ico woff woff2 ttf mp3 mp4 webm".split(" "));
const TEXT = new Set(["html", "css", "js", "mjs", "json", "txt", "svg"]);
export const isTextAsset = (file: string): boolean => TEXT.has(path.extname(file).slice(1).toLowerCase());

/** Static references only; dynamic JavaScript expressions cannot be resolved here. */
export function rewriteReferences(text: string, replace: (url: string) => string): string {
  text = text.replace(/\b(src|href|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_all, key: string, a: string | undefined, b: string | undefined, c: string | undefined) => `${key}="${replace(a ?? b ?? c ?? "").replace(/"/g, "&quot;")}"`);
  text = text.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (_all, quote: string, value: string) =>
    `srcset=${quote}${value.split(/,\s+(?![^()]*\))/).map((entry) => entry.replace(/^(\s*)(\S+)/, (_m, space: string, url: string) => space + replace(url))).join(", ")}${quote}`);
  text = text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
    (_all, a: string | undefined, b: string | undefined, c: string | undefined) => `url("${replace(a ?? b ?? c ?? "").replace(/"/g, "%22")}")`);
  text = text.replace(/(@import\s*|\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\bimport\s*\(\s*|\b(?:fetch|Worker)\s*\(\s*)(["'])([^"']+)\2/g,
    (_all, prefix: string, quote: string, url: string) => prefix + quote + replace(url) + quote);
  return text;
}

export function localReference(url: string): { pathname: string; suffix: string } | null {
  const clean = url.trim().replace(/&amp;/g, "&");
  if (!clean || clean.startsWith("#") || clean.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(clean)) return null;
  const match = /^([^?#]*)(.*)$/.exec(clean)!;
  try { return { pathname: decodeURIComponent(match[1]), suffix: match[2] }; } catch { return { pathname: match[1], suffix: match[2] }; }
}

/** Never follow links while enumerating publishable files. */
export async function listSiteFiles(dir: string): Promise<string[]> {
  const root = await fs.realpath(dir);
  const files: string[] = [];
  async function walk(folder: string): Promise<void> {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(folder, entry.name);
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) throw new Error(`「${entry.name}」是符号链接，请换成实际文件后再发布`);
      if (!isInside(root, await fs.realpath(abs))) throw new Error("文件跑到了发布文件夹外面，不能发布");
      if (st.isDirectory()) await walk(abs);
      else if (st.isFile()) files.push(path.relative(root, abs).split(path.sep).join("/"));
      else throw new Error(`「${entry.name}」不是普通文件，不能发布`);
    }
  }
  await walk(root);
  return files;
}

export async function scanSite(dir: string): Promise<PublishScanResult> {
  const root = await fs.realpath(dir);
  const files = await listSiteFiles(root);
  const known = new Set(files);
  const warnings: PublishWarning[] = [];
  let bytes = 0;
  const warn = (file: string, reason: PublishWarning["reason"], message: string, blocking = false) => {
    if (!warnings.some((w) => w.file === file && w.reason === reason && w.message === message)) warnings.push({ file, reason, message, blocking });
  };
  for (const file of files) {
    const abs = path.join(root, file);
    const size = (await fs.stat(abs)).size;
    bytes += size;
    if (!ALLOWED.has(path.extname(file).slice(1).toLowerCase())) warn(file, "blocked_type", "这种文件格式不支持发布，请移走它或换成网页支持的格式。");
    if (size > 5 * 1024 * 1024) warn(file, "too_big", "这个文件超过 5MB，请压缩或缩小后再发布。", true);
    // Inspect all bytes, including unknown formats, without retaining the entire site in memory.
    const content = (await fs.readFile(abs)).toString("utf8");
    if (/(?:\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\bghp_[A-Za-z0-9]{20,}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{24,}=*)/i.test(content)) {
      warn(file, "secret", "这个文件可能藏着密钥或登录凭证。发布后别人能看到，请先删除或换成不含密钥的版本。", true);
    }
    if (/(?:file:\/\/|\/Users\/|\bC:[\\/])/i.test(content)) warn(file, "absolute_path", "这里用了你电脑上的文件地址，别人打开网站时找不到，请改成网站里的相对地址。");
    if (!isTextAsset(file)) continue;
    rewriteReferences(content, (url) => {
      const ref = localReference(url);
      if (!ref || !ref.pathname) return url;
      const target = path.resolve(ref.pathname.startsWith("/") ? root : path.dirname(abs), ref.pathname.replace(/^\/+/, ""));
      const rel = path.relative(root, target).split(path.sep).join("/");
      const found = isInside(root, target) && (known.has(rel) || known.has(path.posix.join(rel, "index.html")));
      if (!found) warn(file, "missing_asset", `页面引用的「${url}」找不到，请补上文件或改对地址。`);
      return url;
    });
  }
  if (bytes > 10 * 1024 * 1024) warn("", "too_big", "网站全部文件加起来超过 10MB，请删掉不需要的文件或压缩图片和视频。", true);
  return { files: files.length, bytes, warnings };
}
