import { type WriteStream, createReadStream, createWriteStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { ArchiveProgress, ArchiveResult } from "@shared/types";
import { IGNORED_DIRS } from "../workspace";

// Archives a finished project into one .zip in the archive folder (Documents/sikeoop 归档 by
// default): the project's files, plus a _sikeoop/ folder with its conversations, wiki and a
// manifest. The zip is streamed to disk file by file, so large projects don't sit in memory.

/** fflate writes classic zip (no ZIP64): stay clear of its 4 GB and 65535-entry limits. */
const MAX_TOTAL_BYTES = 3.5 * 1024 ** 3;
const MAX_ENTRIES = 60_000;
/** Bigger files (videos, other archives) are left out and listed in the manifest. */
const MAX_FILE_BYTES = 200 * 1024 ** 2;
/** Already compressed: stored as they are instead of deflated again. */
const STORED = /\.(zip|7z|rar|gz|tgz|bz2|xz|png|jpe?g|gif|webp|avif|mp[34]|m4a|mov|webm|ogg|woff2?|pdf|docx|xlsx|pptx|apk|jar)$/i;

interface Entry {
  abs: string;
  /** Path inside the zip, "/"-separated. */
  name: string;
  size: number;
}

export class ArchiveService {
  private running: AbortController | null = null;

  constructor(
    private readonly opts: {
      /** The archive folder. */
      dir(): Promise<string>;
      /** Conversation files and the wiki file of a project, for _sikeoop/. */
      records(root: string): Promise<{ sessions: string[]; wiki: string | null }>;
      onProgress(p: ArchiveProgress): void;
    },
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  cancel(): void {
    this.running?.abort();
  }

  async archive(root: string, note?: string): Promise<ArchiveResult> {
    if (this.running) throw new Error("正在归档，请等这一次完成");
    const controller = new AbortController();
    this.running = controller;
    const { signal } = controller;
    const name = path.basename(root);
    let target = "";
    let part = "";
    let out: WriteStream | null = null;
    try {
      const dir = await this.opts.dir();
      target = path.join(dir, `${safeName(name)}_${stamp(new Date())}.zip`);
      // The zip is written to a file of its own and only gets its final name once complete.
      part = `${target}.${process.pid}-${Date.now()}.part`;
      this.opts.onProgress({ phase: "scan", done: 0, total: 0, label: "正在清点文件" });
      const { entries, skipped } = await collect(root, target, signal);
      const records = await this.opts.records(root);
      const total = entries.reduce((n, e) => n + e.size, 0);
      if (total > MAX_TOTAL_BYTES || entries.length + records.sessions.length > MAX_ENTRIES) {
        throw new Error(`项目太大了（${fmt(total)}、${entries.length} 个文件），超出了归档能处理的范围（3.5 GB、6 万个文件）`);
      }

      await fs.mkdir(dir, { recursive: true });
      const stream = createWriteStream(part, { flags: "wx" });
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
      // Only now is the file ours to clean up.
      out = stream;
      let failed: Error | null = null;
      stream.on("error", (e) => (failed = e));
      const finished = new Promise<void>((resolve, reject) => {
        stream.once("finish", resolve);
        stream.once("error", reject);
      });
      const zip = new Zip((err, data, final) => {
        if (err) failed = err;
        else stream.write(data);
        if (final) stream.end();
      });
      const drain = async () => {
        if (stream.writableLength > 32 * 1024 ** 2) await new Promise((r) => stream.once("drain", r));
        if (failed) throw failed;
        if (signal.aborted) throw new Error("已取消归档");
      };

      let done = 0;
      for (const [i, e] of entries.entries()) {
        const file = STORED.test(e.name) ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 6 });
        zip.add(file);
        let pushed = false;
        for await (const chunk of createReadStream(e.abs, { highWaterMark: 1024 ** 2 })) {
          file.push(chunk as Uint8Array);
          pushed = true;
          await drain();
        }
        file.push(new Uint8Array(0), true);
        if (!pushed) await drain();
        done += e.size;
        if (i % 20 === 0 || i === entries.length - 1) {
          this.opts.onProgress({ phase: "zip", done, total, label: e.name });
        }
      }

      // The work records: conversations, wiki, and what's in (and left out of) this archive.
      const addText = (n: string, text: string) => {
        const f = new ZipDeflate(n, { level: 6 });
        zip.add(f);
        f.push(new TextEncoder().encode(text), true);
      };
      for (const s of records.sessions) addText(`_sikeoop/sessions/${path.basename(s)}`, await fs.readFile(s, "utf8"));
      if (records.wiki) {
        const wiki = await fs.readFile(records.wiki, "utf8").catch(() => null);
        if (wiki) addText("_sikeoop/wiki.json", wiki);
      }
      addText(
        "_sikeoop/manifest.json",
        JSON.stringify(
          { app: "sikeoop", version: 1, project: name, root, createdAt: new Date().toISOString(), note, files: entries.length, bytes: total, skipped },
          null,
          2,
        ),
      );
      zip.end();
      await finished;
      if (failed) throw failed;
      target = await commit(part, target);
      const size = (await fs.stat(target)).size;
      this.opts.onProgress({ phase: "done", done: total, total, label: target });
      return { file: target, files: entries.length, bytes: size, skipped };
    } catch (err) {
      // Never leave half a zip behind; only the part file this call created is removed.
      if (out) {
        out.destroy();
        await fs.rm(part, { force: true }).catch(() => {});
      }
      this.opts.onProgress({ phase: "error", done: 0, total: 0, label: (err as Error).message });
      throw err;
    } finally {
      this.running = null;
    }
  }
}

/** link() errors that mean "this drive has no hard links", not "something is wrong". */
const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"]);

/**
 * Give the finished part file its final name without ever replacing an earlier archive:
 * link() fails if the name is taken, so a second archive in the same second gets "_2", "_3"…
 */
async function commit(part: string, target: string): Promise<string> {
  const base = target.slice(0, -".zip".length);
  for (let n = 1; ; n++) {
    const name = n === 1 ? target : `${base}_${n}.zip`;
    try {
      await fs.link(part, name);
      await fs.rm(part, { force: true }).catch(() => {});
      return name;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && n < 100) continue;
      if (!NO_HARD_LINKS.has(code ?? "")) throw err;
    }
    // No hard links on this drive (FAT/exFAT, some network shares): create the name exclusively
    // and copy into it, so nothing that exists under that name is ever replaced.
    let fh: FileHandle;
    try {
      fh = await fs.open(name, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && n < 100) continue;
      throw err;
    }
    await copyInto(fh, part, name);
    await fs.rm(part, { force: true }).catch(() => {});
    return name;
  }
}

/**
 * Copy `part` into the file this call just created as `name`. On any failure (closing included)
 * the copy is removed again, but only if `name` is still that same file and not a replacement.
 */
async function copyInto(fh: FileHandle, part: string, name: string): Promise<void> {
  const mine = await fh.stat().catch(() => null);
  let closed = false;
  try {
    await fh.writeFile(createReadStream(part));
    await fh.sync();
    closed = true;
    await fh.close();
  } catch (err) {
    if (!closed) await fh.close().catch(() => {});
    const now = await fs.lstat(name).catch(() => null);
    if (mine && now && now.ino === mine.ino && now.dev === mine.dev) await fs.rm(name, { force: true }).catch(() => {});
    throw err;
  }
}

/** Project files to archive: skips ignored folders, symlinks and the archive itself. */
async function collect(root: string, target: string, signal: AbortSignal) {
  const entries: Entry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (signal.aborted) throw new Error("已取消归档");
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: rel || ".", reason: "无法读取" });
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const r = rel ? `${rel}/${it.name}` : it.name;
      // Symlinks could point anywhere on the disk; they are not followed.
      if (it.isSymbolicLink()) {
        skipped.push({ path: r, reason: "快捷方式（软链接）" });
        continue;
      }
      if (it.isDirectory()) {
        if (!IGNORED_DIRS.has(it.name)) await walk(abs, r);
        continue;
      }
      if (!it.isFile() || abs === target || it.name === ".DS_Store") continue;
      const st = await fs.stat(abs);
      if (st.size > MAX_FILE_BYTES) skipped.push({ path: r, reason: `文件太大（${fmt(st.size)}）` });
      else entries.push({ abs, name: r, size: st.size });
    }
  }
  await walk(root, "");
  return { entries, skipped };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "project";
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export function fmt(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
