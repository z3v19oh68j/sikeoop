// Small .tar.gz and .zip archives built byte by byte, for the tests of unpacking and installing.
import zlib from "node:zlib";

export interface TarEntry {
  name: string;
  /** "0" file (default), "5" folder, "2" link, "1" hard link, "L" GNU long name, "x" pax header… */
  type?: string;
  data?: string | Buffer;
  mode?: number;
  link?: string;
  prefix?: string;
  /** Leaves the header's checksum wrong. */
  badChecksum?: boolean;
}

function field(block: Buffer, at: number, length: number, value: string): void {
  block.write(value, at, length, "utf8");
}

function tarEntry(e: TarEntry): Buffer {
  const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
  const type = e.type ?? "0";
  const h = Buffer.alloc(512);
  field(h, 0, 100, e.name);
  field(h, 100, 8, (e.mode ?? (type === "5" ? 0o755 : 0o644)).toString(8).padStart(7, "0") + "\0");
  field(h, 108, 8, "0000000\0");
  field(h, 116, 8, "0000000\0");
  field(h, 124, 12, data.length.toString(8).padStart(11, "0") + "\0");
  field(h, 136, 12, "00000000000\0");
  field(h, 156, 1, type);
  if (e.link) field(h, 157, 100, e.link);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  if (e.prefix) field(h, 345, 155, e.prefix);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, (e.badChecksum ? sum + 1 : sum).toString(8).padStart(6, "0") + "\0 ");
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(body);
  return Buffer.concat([h, body]);
}

/** An uncompressed tar: the entries, then the two empty blocks that end it. */
export const tar = (entries: TarEntry[]): Buffer => Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
export const tgz = (entries: TarEntry[]): Buffer => zlib.gzipSync(tar(entries));

/** GNU tar's way of giving the next entry a name longer than 100 bytes. */
export const gnuLongName = (name: string): TarEntry => ({ name: "././@LongLink", type: "L", data: name + "\0" });

/** A pax header for the next entry. */
export function pax(records: Record<string, string>): TarEntry {
  const lines = Object.entries(records).map(([k, v]) => {
    const rest = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(rest) + 1;
    while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
    return `${len}${rest}`;
  });
  return { name: "PaxHeader/next", type: "x", data: lines.join("") };
}

export interface ZipItem {
  name: string;
  data?: string | Buffer;
  /** Stored as it is instead of deflated. */
  store?: boolean;
  /** Unix file type and permissions (0o100755, 0o120777 for a link). */
  unixMode?: number;
  /** Records a wrong checksum. */
  badCrc?: boolean;
  flags?: number;
}

export function zip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? "");
    const method = item.store || raw.length === 0 ? 0 : 8;
    const packed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = (zlib.crc32(raw) + (item.badCrc ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(item.unixMode ? (3 << 8) | 20 : 20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(item.flags ?? 0, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((item.unixMode ?? 0) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    central.push(head, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
