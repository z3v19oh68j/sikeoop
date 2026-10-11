import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

// Unpacking a downloaded .tar.gz or .zip into a new, empty folder, with nothing able to land
// outside it: no absolute names, no "..", nothing written through a link the archive itself made.
// (The archive has passed its checksum before it gets here; this is the second line of defence.)

/**
 * An entry's name as the folders and file it stands for, or [] for the archive's own root ("./").
 * Throws when the name could reach outside the folder being unpacked into.
 */
export function safeEntryPath(name: string, windows = false): string[] {
  if (!name || name.includes("\0")) throw new Error("压缩包里有名字不正常的文件");
  const unified = windows ? name.replace(/\\/g, "/") : name;
  if (unified.startsWith("/") || (windows && /^[A-Za-z]:/.test(unified))) throw new Error(`压缩包里有绝对路径（${name.slice(0, 80)}），没有解压`);
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error(`压缩包里有指向上级文件夹的路径（${name.slice(0, 80)}），没有解压`);
    // On Windows "a:b" writes to another stream of a, and names ending in a dot or space are trimmed.
    if (windows && (part.includes(":") || /[. ]$/.test(part))) throw new Error(`压缩包里有 Windows 不能安全处理的文件名（${name.slice(0, 80)}），没有解压`);
    parts.push(part);
  }
  return parts;
}

/**
 * Whether a link at `entry` pointing to `target` stays inside the folder, going only by the text
 * of the paths. (Nothing is ever written through a link, so this guards what is read afterwards.)
 */
export function linkStaysInside(entry: string[], target: string): boolean {
  if (!target || target.includes("\0") || target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.includes("\\")) return false;
  let depth = entry.length - 1;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Apply Windows' rules for file names. Default: tar on Windows only; zip always. */
  windows?: boolean;
  /** Stops an archive that unpacks into far more than expected. */
  maxBytes?: number;
  maxEntries?: number;
}

export interface Extracted {
  files: number;
  bytes: number;
}

const MAX_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 400_000;

/** Keeps track of what has been put into the folder, so nothing goes through a link or outside. */
class Target {
  private readonly root: string;
  private readonly dirs = new Set<string>();
  private readonly files = new Set<string>();
  private readonly links = new Set<string>();
  private readonly limits: { bytes: number; entries: number };
  private readonly signal?: AbortSignal;
  count = 0;
  bytes = 0;

  constructor(root: string, o: ExtractOptions) {
    this.root = root;
    this.limits = { bytes: o.maxBytes ?? MAX_BYTES, entries: o.maxEntries ?? MAX_ENTRIES };
    this.signal = o.signal;
  }

  /** Called for every entry: the place to stop. */
  next(): void {
    if (this.signal?.aborted) throw new Error("已取消");
    if (++this.count > this.limits.entries) throw new Error("压缩包里的文件多得不正常，没有继续解压");
  }

  add(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.limits.bytes) throw new Error("压缩包解开后大得不正常，没有继续解压");
  }

  /** The place on disk for these path parts; refuses when a folder on the way is a link from the archive. */
  private at(parts: string[]): string {
    for (let i = 1; i < parts.length; i++) if (this.links.has(parts.slice(0, i).join("/"))) throw new Error(`压缩包想通过链接写文件（${parts.join("/").slice(0, 80)}），没有解压`);
    return path.join(this.root, ...parts);
  }

  async dir(parts: string[]): Promise<void> {
    const key = parts.join("/");
    if (!parts.length || this.dirs.has(key)) return;
    if (this.links.has(key) || this.files.has(key)) throw new Error(`压缩包里同一个名字既是文件又是文件夹（${key.slice(0, 80)}）`);
    await fs.mkdir(this.at(parts), { recursive: true, mode: 0o755 });
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }

  /** Where a file goes: its folder is made, and an earlier entry of the same name gives way. */
  async file(parts: string[]): Promise<string> {
    if (!parts.length) throw new Error("压缩包里有没有名字的文件");
    const key = parts.join("/");
    if (this.dirs.has(key)) throw new Error(`压缩包里同一个名字既是文件又是文件夹（${key.slice(0, 80)}）`);
    const to = this.at(parts);
    await this.dir(parts.slice(0, -1));
    if (this.files.has(key) || this.links.has(key)) await fs.rm(to, { force: true });
    this.links.delete(key);
    this.files.add(key);
    return to;
  }

  async symlink(parts: string[], target: string): Promise<void> {
    if (!linkStaysInside(parts, target)) throw new Error(`压缩包里有指向外面的链接（${parts.join("/").slice(0, 80)}），没有解压`);
    const to = await this.file(parts);
    this.files.delete(parts.join("/"));
    this.links.add(parts.join("/"));
    await fs.symlink(target, to);
  }

  /** Another name for a file the archive already gave us. */
  async hardlink(parts: string[], existing: string[]): Promise<void> {
    if (!this.files.has(existing.join("/"))) throw new Error(`压缩包里有指向不存在文件的链接（${parts.join("/").slice(0, 80)}），没有解压`);
    const from = this.at(existing);
    const to = await this.file(parts);
    await fs.link(from, to);
  }
}

/** Owner can always read and write; run bits are kept; nothing else (no set-user-id). */
const fileMode = (mode: number): number => (mode & 0o777) | 0o600;

// ---- tar.gz ----

/** Hands out exact amounts of bytes from a stream. */
class Bytes {
  private readonly it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);

  constructor(stream: AsyncIterable<Buffer>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    const next = await this.it.next();
    if (next.done) return false;
    this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    return true;
  }

  /** Exactly n bytes; null when the stream ended before any of them. */
  async take(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (!(await this.more())) {
        if (this.buf.length === 0) return null;
        throw new Error("压缩包不完整");
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** The next n bytes, piece by piece, without holding them all. */
  async each(n: number, use: (piece: Buffer) => Promise<void> | void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.more())) throw new Error("压缩包不完整");
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      await use(piece);
    }
  }
}

const text = (b: Buffer): string => {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString("utf8");
};

/** A number field: octal text, or (GNU, for big files) binary with the top bit set. */
function tarNumber(b: Buffer): number {
  if (b[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
    return n;
  }
  const s = text(b).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === tarNumber(h.subarray(148, 156));
}

/** "30 path=some/long/name\n" records of a pax header. */
function paxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at);
    if (space < 0) break;
    const len = Number(body.subarray(at, space).toString("latin1"));
    if (!Number.isInteger(len) || len <= space - at + 1 || at + len > body.length) break;
    const record = body.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

const HEADER_LIMIT = 1024 * 1024;
const padded = (size: number) => Math.ceil(size / 512) * 512;

/** Unpacks a .tar.gz into `dest`, which must be a new, empty folder. */
export async function extractTarGz(archive: string, dest: string, o: ExtractOptions = {}): Promise<Extracted> {
  const target = new Target(dest, o);
  const windows = o.windows ?? process.platform === "win32";
  const source = createReadStream(archive);
  const gunzip = zlib.createGunzip();
  // Errors of the file reach the reader through the gunzip stream.
  source.on("error", (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  const bytes = new Bytes(gunzip as AsyncIterable<Buffer>);
  let files = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  try {
    for (;;) {
      const h = await bytes.take(512);
      // The end is a block of zeros (or just the end of the stream).
      if (!h || h.every((b) => b === 0)) break;
      if (!checksumOk(h)) throw new Error("压缩包损坏（文件头校验不对）");
      const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
      let size = tarNumber(h.subarray(124, 136));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("压缩包损坏（文件大小不对）");

      // Entries that only describe the next one.
      if (type === "L" || type === "K" || type === "x" || type === "g") {
        if (size > HEADER_LIMIT) throw new Error("压缩包损坏（说明信息太大）");
        const body = (await bytes.take(padded(size)))?.subarray(0, size) ?? Buffer.alloc(0);
        if (type === "L") longName = text(body);
        else if (type === "K") longLink = text(body);
        else if (type === "x") pax = paxRecords(body);
        continue;
      }

      const prefix = h.subarray(257, 262).toString("latin1") === "ustar" ? text(h.subarray(345, 500)) : "";
      const name = pax.path ?? longName ?? (prefix ? `${prefix}/` : "") + text(h.subarray(0, 100));
      const link = pax.linkpath ?? longLink ?? text(h.subarray(157, 257));
      if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size);
      const mode = tarNumber(h.subarray(100, 108));
      longName = longLink = undefined;
      pax = {};

      target.next();
      const parts = safeEntryPath(name, windows);
      if (type === "5") {
        await target.dir(parts);
      } else if (type === "0" || type === "7") {
        target.add(size);
        if (!parts.length) throw new Error("压缩包里有没有名字的文件");
        const file = await fs.open(await target.file(parts), "wx", fileMode(mode));
        try {
          await bytes.each(size, async (piece) => void (await file.write(piece)));
        } finally {
          await file.close();
        }
        if (padded(size) > size) await bytes.take(padded(size) - size);
        files++;
        continue;
      } else if (type === "2") {
        await target.symlink(parts, link);
      } else if (type === "1") {
        await target.hardlink(parts, safeEntryPath(link, windows));
      } else {
        throw new Error(`压缩包里有不该出现的内容（类型 ${type}：${name.slice(0, 80)}），没有解压`);
      }
      // Links and folders carry no data, but skip any they claim to have.
      if (size > 0) await bytes.each(padded(size), () => undefined);
    }
    return { files, bytes: target.bytes };
  } catch (err) {
    // zlib's own words ("unexpected end of file") mean the download is not whole.
    if (typeof (err as NodeJS.ErrnoException).code === "string" && (err as NodeJS.ErrnoException).code!.startsWith("Z_")) throw new Error("压缩包不完整或已损坏");
    throw err;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

// ---- zip ----

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  /** Unix file type and permissions, when the archive was made on a Unix system. */
  unixMode: number;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DIRECTORY_LIMIT = 128 * 1024 * 1024;

const u64 = (b: Buffer, at: number): number => {
  const n = b.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("压缩包损坏（数字太大）");
  return Number(n);
};

async function readAt(file: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await file.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error("压缩包不完整");
  return buf;
}

/** The list of what a zip holds, from the directory at its end. */
export async function readZipDirectory(file: fs.FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailSize = Math.min(fileSize, 22 + 65535);
  const tail = await readAt(file, fileSize - tailSize, tailSize);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("这不是一个完整的 zip 文件");
  let count = tail.readUInt16LE(at + 10);
  let dirSize = tail.readUInt32LE(at + 12);
  let dirOffset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const locatorAt = fileSize - tailSize + at - 20;
    const locator = locatorAt >= 0 ? await readAt(file, locatorAt, 20) : null;
    if (!locator || locator.readUInt32LE(0) !== LOCATOR64) throw new Error("压缩包损坏（找不到目录）");
    const end = await readAt(file, u64(locator, 8), 56);
    if (end.readUInt32LE(0) !== EOCD64) throw new Error("压缩包损坏（找不到目录）");
    count = u64(end, 32);
    dirSize = u64(end, 40);
    dirOffset = u64(end, 48);
  }
  if (dirSize > DIRECTORY_LIMIT || dirOffset + dirSize > fileSize) throw new Error("压缩包损坏（目录的位置不对）");
  const dir = await readAt(file, dirOffset, dirSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw new Error("压缩包损坏（目录读不通）");
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > dir.length) throw new Error("压缩包损坏（目录读不通）");
    const entry: ZipEntry = {
      name: dir.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      flags: dir.readUInt16LE(p + 8),
      method: dir.readUInt16LE(p + 10),
      crc: dir.readUInt32LE(p + 16),
      compressed: dir.readUInt32LE(p + 20),
      size: dir.readUInt32LE(p + 24),
      offset: dir.readUInt32LE(p + 42),
      unixMode: dir[p + 5] === 3 ? dir.readUInt32LE(p + 38) >>> 16 : 0,
    };
    // Sizes too big for the usual fields are in the "zip64" extra, in this order.
    const extra = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        const next = () => {
          if (q + 8 > e + 4 + len || q + 8 > extra.length) throw new Error("压缩包损坏（目录读不通）");
          const n = u64(extra, q);
          q += 8;
          return n;
        };
        if (entry.size === 0xffffffff) entry.size = next();
        if (entry.compressed === 0xffffffff) entry.compressed = next();
        if (entry.offset === 0xffffffff) entry.offset = next();
      }
      e += 4 + len;
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Unpacks a .zip into `dest`, which must be a new, empty folder. */
export async function extractZip(archive: string, dest: string, o: ExtractOptions = {}): Promise<Extracted> {
  const target = new Target(dest, o);
  const file = await fs.open(archive, "r");
  let files = 0;
  try {
    const fileSize = (await file.stat()).size;
    for (const entry of await readZipDirectory(file, fileSize)) {
      target.next();
      // Windows tools sometimes write "\" between folders.
      const parts = safeEntryPath(entry.name, o.windows ?? true);
      const type = entry.unixMode & 0o170000;
      if (/[/\\]$/.test(entry.name) || type === 0o040000) {
        await target.dir(parts);
        continue;
      }
      if (entry.flags & 1) throw new Error("压缩包是加密的，没有解压");
      if (type === 0o120000) throw new Error(`压缩包里有链接（${entry.name.slice(0, 80)}），没有解压`);
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`压缩包用了不认识的压缩方式（${entry.method}）`);
      target.add(entry.size);
      const to = await target.file(parts);
      const local = await readAt(file, entry.offset, 30);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error("压缩包损坏（文件的位置不对）");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.compressed > fileSize) throw new Error("压缩包不完整");
      const mode = entry.unixMode ? fileMode(entry.unixMode) : 0o644;
      let written = 0;
      let crc = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          written += chunk.length;
          if (written > entry.size) return done(new Error("压缩包损坏（文件比目录里写的大）"));
          crc = zlib.crc32(chunk, crc);
          done(null, chunk);
        },
      });
      const out = createWriteStream(to, { flags: "wx", mode });
      if (entry.compressed === 0) {
        await new Promise<void>((resolve, reject) => out.on("error", reject).end(resolve));
      } else {
        const data = createReadStream(archive, { start, end: start + entry.compressed - 1 });
        await (entry.method === 8 ? pipeline(data, zlib.createInflateRaw(), count, out, { signal: o.signal }) : pipeline(data, count, out, { signal: o.signal }));
      }
      if (written !== entry.size || crc !== entry.crc) throw new Error(`压缩包损坏（${entry.name.slice(0, 80)} 解出来和记录的不一样）`);
      files++;
    }
    return { files, bytes: target.bytes };
  } catch (err) {
    if (o.signal?.aborted) throw new Error("已取消");
    throw err;
  } finally {
    await file.close();
  }
}
