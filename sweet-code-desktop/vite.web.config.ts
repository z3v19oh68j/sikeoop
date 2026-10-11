import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

/**
 * The browser has no sweetproto:// scheme, so this serves the sample prototypes in
 * src/renderer/dev-proto the same way main/prototypes/protocol.ts does: at /__proto/<name>/<file>,
 * with the studio runtime added to each page and a no-network CSP.
 */
function devPrototypes(): Plugin {
  const base = resolve(__dirname, "src/renderer/dev-proto");
  return {
    name: "dev-prototypes",
    configureServer(server) {
      server.middlewares.use("/__proto/", async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = resolve(base, rel);
        if (!file.startsWith(base)) return next();
        try {
          let body: Buffer | string = await fs.readFile(file);
          const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json" : "application/octet-stream";
          if (type === "text/html") body = body.toString("utf8").replace(/<head[^>]*>/i, (m) => `${m}<script src="/proto-runtime.js"></script>`);
          res.setHeader("content-type", `${type}; charset=utf-8`);
          // Sandboxed frames have an opaque origin, where 'self' matches nothing: name the dev server too.
          const self = `'self' http://${req.headers.host}`;
          res.setHeader("content-security-policy", `default-src ${self}; script-src ${self} 'unsafe-inline'; style-src ${self} 'unsafe-inline'; img-src ${self} data:; connect-src 'none'`);
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

// Renderer only, in a normal browser with the dev mock (see src/renderer/src/dev-mock.ts).
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react(), devPrototypes()],
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  // As in electron.vite.config.ts: onig.wasm (editor extensions' highlighting) is imported with ?inline.
  assetsInclude: ["**/*.wasm"],
  server: { port: 5199, strictPort: true },
});
