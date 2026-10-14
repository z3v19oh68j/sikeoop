import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PvAsset, PvStoryboard } from "../../shared/types.ts";
import { safePath } from "./store.ts";
import { assetKind, MAX_ASSET_BYTES } from "./media.ts";

export async function assetPath(root: string, id: string, file: string): Promise<string> {
  if (typeof file !== "string" || /\p{Cc}/u.test(file)) throw new Error("路径越界");
  assetKind(file);
  const target = await safePath(root, id, "assets/" + file);
  const st = await fs.lstat(target);
  if (!st.isFile() || st.size > MAX_ASSET_BYTES) throw new Error("素材不是普通文件或超过 512 MB");
  return target;
}
export async function listAssets(root: string, id: string): Promise<PvAsset[]> {
  const assets = await safePath(root, id, "assets");
  const out: PvAsset[] = [];
  async function walk(relative: string) {
    const dir = relative ? await safePath(root, id, "assets/" + relative) : assets;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("路径越界：不允许符号链接");
      const file = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        let kind: PvAsset["kind"];
        try { kind = assetKind(file); } catch { continue; }
        const target = await assetPath(root, id, file);
        out.push({ file, kind, bytes: (await fs.stat(target)).size });
      }
      if (out.length > 1000) throw new Error("素材过多（最多 1000 个）");
    }
  }
  try { await walk(""); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Uses opened descriptors and an exclusive destination; no arbitrary renderer paths reach here. */
export async function copyMedia(source: string, destination: string, signal?: AbortSignal): Promise<number> {
  if ((await fs.lstat(source)).isSymbolicLink()) throw new Error("路径越界：不允许符号链接");
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false, bytes = 0;
  try {
    const st = await input.stat();
    if (!st.isFile() || st.size > MAX_ASSET_BYTES) throw new Error("素材不是普通文件或超过 512 MB");
    output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > MAX_ASSET_BYTES ? new Error("素材超过 512 MB") : null, chunk);
    } });
    await pipeline(input.createReadStream(), limit, output.createWriteStream(), { signal });
    return bytes;
  } catch (e) {
    if (created) { await output?.close(); output = undefined; await fs.rm(destination, { force: true }); }
    throw e;
  } finally { await input.close(); await output?.close(); }
}

export async function importAssets(root: string, id: string, sources: string[]): Promise<PvAsset[]> {
  if (!Array.isArray(sources) || sources.length > 100 || sources.some(file => typeof file !== "string" || !path.isAbsolute(file)))
    throw new Error("导入素材参数无效（最多 100 个文件）");
  // Validate the whole selection before copying any of it.
  for (const file of sources) {
    assetKind(file);
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) throw new Error("路径越界：不允许符号链接");
    if (!st.isFile() || st.size > MAX_ASSET_BYTES) throw new Error("素材不是普通文件或超过 512 MB");
  }
  await fs.mkdir(await safePath(root, id, "assets"), { recursive: true });
  await safePath(root, id, "assets");
  const imported: PvAsset[] = [];
  for (const source of sources) {
    const ext = path.extname(source).toLowerCase();
    const stem = path.basename(source, path.extname(source)).normalize("NFC")
      .replace(/[^\p{L}\p{N}_ -]/gu, "-").replace(/^[. -]+|[. -]+$/g, "").slice(0, 64) || "asset";
    for (let index = 1; ; index++) {
      const file = `${stem}${index === 1 ? "" : "-" + index}${ext}`;
      const target = await safePath(root, id, "assets/" + file);
      try {
        const bytes = await copyMedia(source, target);
        imported.push({ file, kind: assetKind(file), bytes });
        break;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
  }
  return imported;
}

export async function validateShotAssets(root: string, id: string, sb: PvStoryboard): Promise<void> {
  const missing: string[] = [];
  for (const shot of sb.shots) if (shot.source === "file" || shot.source === "screen") {
    try {
      if (!shot.asset || assetKind(shot.asset) === "audio") throw new Error("缺素材");
      await assetPath(root, id, shot.asset);
    } catch { missing.push(shot.id); }
  }
  if (missing.length) throw new Error("镜头缺少有效图片/视频素材：" + missing.join("、"));
}
