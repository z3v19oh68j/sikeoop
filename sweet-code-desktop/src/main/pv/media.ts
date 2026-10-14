import path from "node:path";
import type { PvAsset } from "../../shared/types.ts";

export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
export const assetMedia: Record<string, { kind: PvAsset["kind"]; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" }, ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" }, ".webp": { kind: "image", mime: "image/webp" },
  ".gif": { kind: "image", mime: "image/gif" }, ".avif": { kind: "image", mime: "image/avif" },
  ".bmp": { kind: "image", mime: "image/bmp" }, ".mp4": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" }, ".mov": { kind: "video", mime: "video/quicktime" },
  ".m4v": { kind: "video", mime: "video/mp4" }, ".mkv": { kind: "video", mime: "video/x-matroska" },
  ".avi": { kind: "video", mime: "video/x-msvideo" }, ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" }, ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" }, ".aac": { kind: "audio", mime: "audio/aac" },
  ".flac": { kind: "audio", mime: "audio/flac" }, ".opus": { kind: "audio", mime: "audio/ogg" },
};
export const assetExtensions = Object.keys(assetMedia).map(ext => ext.slice(1));
export function assetKind(file: string): PvAsset["kind"] {
  const info = typeof file === "string" ? assetMedia[path.extname(file).toLowerCase()] : undefined;
  if (!info) throw new Error("仅接受常见图片、视频或音频素材（不支持此扩展名）");
  return info.kind;
}
