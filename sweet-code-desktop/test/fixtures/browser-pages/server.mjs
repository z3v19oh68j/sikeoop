// 零依赖的本地静态服务，用来托管自动化浏览器的测试页面集。
// 只用 node 内置模块，不装任何依赖，不连网。
//
//   node server.mjs                 # 默认同时起 127.0.0.1:7331 和 127.0.0.1:7332
//   PORT=8080 PORT2=8081 node server.mjs
//   node server.mjs --once          # 只起主端口（跨源 iframe 的那一页会连不上副端口，属正常）
//
// 为什么要两个端口：跨源 iframe 测试页（iframe.html）需要一个与自己不同源的子帧。
// 同一台机器上，不同端口即不同源，所以主页面放主端口、跨源子帧从副端口加载。
// 两个端口服务的是同一个目录，内容完全一样，区别只在「源」。

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PRIMARY = Number(process.env.PORT || 7331);
const SECONDARY = Number(process.env.PORT2 || 7332);
const ONCE = process.argv.includes("--once");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ico": "image/x-icon"
};

// 把请求路径限制在本目录内，挡掉 ../ 之类的穿越。
function resolveSafe(urlPath) {
  const raw = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(raw).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + "/")) return null;
  return full;
}

async function handle(req, res) {
  try {
    let full = resolveSafe(req.url === "/" ? "/index.html" : req.url);
    if (!full) {
      res.writeHead(403).end("403");
      return;
    }
    let info;
    try {
      info = await stat(full);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found: " + req.url);
      return;
    }
    if (info.isDirectory()) full = join(full, "index.html");
    const body = await readFile(full);
    const type = TYPES[extname(full).toLowerCase()] || "application/octet-stream";
    // 关键：不设 X-Frame-Options / CSP frame-ancestors，这样这些页面可以被 iframe 内嵌。
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }).end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("500 " + String(err?.message || err));
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle);
    srv.on("error", reject);
    srv.listen(port, HOST, () => resolve(srv));
  });
}

const servers = [];
try {
  servers.push(await listen(PRIMARY));
  console.log(`browser-pages: http://${HOST}:${PRIMARY}/  (主端口)`);
  if (!ONCE) {
    servers.push(await listen(SECONDARY));
    console.log(`browser-pages: http://${HOST}:${SECONDARY}/  (副端口，供跨源 iframe 用)`);
  }
  console.log("Ctrl+C 停止。");
} catch (err) {
  console.error("启动失败：", err?.message || err);
  process.exit(1);
}

function shutdown() {
  for (const s of servers) s.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
