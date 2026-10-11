/// <reference types="vite/client" />
import { promises as fs } from "node:fs";
import path from "node:path";
import { protocol } from "electron";
import runtime from "../../renderer/public/proto-runtime.js?raw";
import { hasRoot } from "../workspace";
import { insideDir, realDir } from "./store";

// sweetproto://p/<prototype>/<file> serves a prototype's files to the studio's artboards.
// Its own origin keeps prototype pages away from the app, and the CSP below lets them run
// their own scripts and styles but reach nothing outside the prototype (no network at all).

export const SCHEME = "sweetproto";
const RUNTIME_PATH = "/__sweet/runtime.js";

const CSP = [
  // Sandboxed frames have an opaque origin, so the scheme is named as well as 'self'.
  "default-src 'self' sweetproto:",
  "script-src 'self' sweetproto: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' sweetproto: 'unsafe-inline'",
  "img-src 'self' sweetproto: data: blob:",
  "font-src 'self' sweetproto: data:",
  "media-src 'self' sweetproto: data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

/** Must run before the app is ready. */
export function registerProtoScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

const reply = (status: number, body: string | Buffer, type = "text/plain; charset=utf-8") =>
  new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store" } });

export function handleProtoScheme(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === RUNTIME_PATH) return reply(200, runtime, TYPES[".js"]);
    if (!hasRoot()) return reply(404, "没有打开项目");
    const [name, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!name || !rest.length) return reply(404, "Not found");
    let file: string;
    try {
      // Same boundary as the store: symlinks are followed only if they stay inside the prototype.
      file = await insideDir(await realDir(name), path.join(...rest));
    } catch {
      return reply(403, "Forbidden");
    }
    const ext = path.extname(file).toLowerCase();
    let data: Buffer;
    try {
      data = await fs.readFile(file);
    } catch {
      return reply(404, "Not found");
    }
    if (ext !== ".html" && ext !== ".htm") return reply(200, data, TYPES[ext] ?? "application/octet-stream");
    // Every page gets the small studio runtime (demo navigation, error reports).
    const html = data.toString("utf8");
    const tag = `<script src="${RUNTIME_PATH}"></script>`;
    // First thing in <head>, so it also catches errors thrown by the page's own scripts.
    const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
    return reply(200, injected, TYPES[".html"]);
  });
}
