import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getRoot, isInside, resolveSafe } from "../workspace";
import { insideDir, load, realDir } from "../prototypes/store";
import { isTextAsset, listSiteFiles, localReference, rewriteReferences } from "./scan";

type Bundle = { dir: string; files: string[] };

/** Snapshot a workspace folder; callers own and must remove the returned temporary directory. */
export async function collectDir(input: string): Promise<Bundle> {
  const lexical = path.resolve(getRoot(), input);
  const source = await resolveSafe(input);
  if (!isInside(getRoot(), lexical)) throw new Error("发布文件夹必须在当前项目里面");
  // Reject even in-workspace symlinks, including the selected folder's parents.
  let current = lexical;
  for (;;) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("发布文件夹不能经过符号链接，请选择实际文件夹");
    if (current === getRoot()) break;
    current = path.dirname(current);
  }
  if (!(await fs.stat(source)).isDirectory()) throw new Error("请选择一个文件夹来发布");
  const files = await listSiteFiles(source);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sikeoop-publish-"));
  try {
    for (const file of files) {
      const abs = await resolveSafe(path.relative(getRoot(), path.join(source, file)));
      if (!isInside(source, abs) || (await fs.lstat(path.join(source, file))).isSymbolicLink()) throw new Error("文件位置发生变化，请重新发布");
      const out = path.join(dir, file);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.copyFile(abs, out);
    }
    return { dir, files };
  } catch (err) { await fs.rm(dir, { recursive: true, force: true }); throw err; }
}

/** Export the canvas entry screen to index.html and relocate its static dependencies. */
export async function bundleProto(name: string): Promise<Bundle> {
  const source = await realDir(name);
  const doc = await load(name);
  const screens = doc.canvas.screens;
  if (!screens.length) throw new Error("这个原型还没有页面，先添加页面再发布");
  const start = doc.canvas.start ?? screens[0].id;
  const outputs = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const screen of screens) {
    if (!/^[\p{L}\p{N}_-]+$/u.test(screen.id)) throw new Error(`页面编号「${screen.id}」不能用作网页文件名`);
    const output = screen.id === start ? "index.html" : `${screen.id}.html`;
    if ([...ids.values()].includes(output)) throw new Error("页面文件名重复，请修改页面编号");
    ids.set(screen.id, output);
    const input = path.relative(source, await insideDir(source, screen.file)).split(path.sep).join("/");
    if (outputs.has(input)) throw new Error("多个页面使用了同一个文件，请分开后再发布");
    outputs.set(input, output);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sikeoop-publish-"));
  const written = new Set<string>();
  const queued = new Set<string>();
  const queue = [...outputs.keys(), "tokens.css"];
  const htmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  try {
    while (queue.length) {
      const rel = queue.shift()!;
      if (queued.has(rel)) continue;
      queued.add(rel);
      const abs = await insideDir(source, rel);
      const output = outputs.get(rel) ?? rel;
      if (written.has(output)) throw new Error(`资源「${output}」与导出的页面重名，请修改名字`);
      let data: Buffer | string;
      try { data = await fs.readFile(abs); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && !outputs.has(rel) && rel !== "tokens.css") continue;
        throw err;
      }
      if (isTextAsset(rel)) {
        let text = data.toString("utf8");
        const transformed = rewriteReferences(text, (url) => {
          const ref = localReference(url);
          if (!ref || !ref.pathname) return url;
          const target = path.resolve(ref.pathname.startsWith("/") ? source : path.dirname(abs), ref.pathname.replace(/^\/+/, ""));
          if (!isInside(source, target) || target === source) throw new Error(`资源地址「${url}」离开了原型文件夹`);
          const resource = path.relative(source, target).split(path.sep).join("/");
          queue.push(resource);
          const relocated = outputs.get(resource) ?? resource;
          return path.posix.relative(path.posix.dirname(output), relocated).split("/").map(encodeURIComponent).join("/") + ref.suffix;
        });
        // Preserve tokens.css byte-for-byte, while still collecting its dependencies.
        if (rel !== "tokens.css") text = transformed;
        if (outputs.has(rel)) {
          text = text.replace(/<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (tag, element: string, attrs: string) => {
            const goto = /\bdata-goto\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
            if (!goto) return tag;
            const id = goto[1] ?? goto[2] ?? goto[3];
            const destination = ids.get(id);
            if (!destination) throw new Error(`跳转目标「${id}」不存在，请先改对页面编号`);
            const clean = attrs.replace(/\s+onclick\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
            if (element.toLowerCase() === "a") return `<${element}${clean.replace(/\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")} href="${htmlEscape(encodeURI(destination))}">`;
            return `<${element}${clean} onclick="${htmlEscape(`window.location.href=${JSON.stringify(encodeURI(destination))};return false;`)}">`;
          });
          const link = '<link rel="stylesheet" href="tokens.css">';
          text = /<\/head\s*>/i.test(text) ? text.replace(/<\/head\s*>/i, link + "\n</head>") : link + "\n" + text;
        }
        data = rel === "tokens.css" ? data : text;
      }
      const out = path.join(dir, output);
      if (!isInside(dir, out)) throw new Error("导出文件路径无效");
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
      written.add(output);
    }
    return { dir, files: [...written].sort() };
  } catch (err) { await fs.rm(dir, { recursive: true, force: true }); throw err; }
}
