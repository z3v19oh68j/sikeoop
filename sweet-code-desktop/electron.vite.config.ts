import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

import { parseBuiltinFreeProviders } from "./src/main/providers/builtin-free.ts";

const shared = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    // The built-in TokenDance (Jev) key everyone uses for the decision model, set at build time:
    // SIKEOOP_BUILTIN_JEV_KEY=… npm run build. Never put the key itself in the source.
    define: {
      __SIKEOOP_JEV_KEY__: JSON.stringify(process.env.SIKEOOP_BUILTIN_JEV_KEY ?? ""),
      __SIKEOOP_BUILTIN_FREE_PROVIDERS__: JSON.stringify(JSON.stringify(parseBuiltinFreeProviders(process.env.SIKEOOP_BUILTIN_FREE_PROVIDERS ?? "[]"))),
      __SIKEOOP_BUILTIN_FREE_BASE_URL__: JSON.stringify(process.env.SIKEOOP_BUILTIN_FREE_BASE_URL ?? ""),
      __SIKEOOP_BUILTIN_FREE_KEY__: JSON.stringify(process.env.SIKEOOP_BUILTIN_FREE_KEY ?? ""),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts"), island: resolve(__dirname, "src/preload/island.ts"), snip: resolve(__dirname, "src/preload/snip.ts"), dictation: resolve(__dirname, "src/preload/dictation.ts"), browser: resolve(__dirname, "src/preload/browser.ts") },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
    // onig.wasm (TextMate highlighting for editor extensions) is inlined with ?inline: the window
    // loads from file://, where fetch() can't read a separate .wasm file.
    assetsInclude: ["**/*.wasm"],
    build: {
      rollupOptions: {
        // The main window, the Dynamic Island's own small window, the screenshot overlay, and the dictation bubble.
        input: { index: resolve(__dirname, "src/renderer/index.html"), island: resolve(__dirname, "src/renderer/island.html"), snip: resolve(__dirname, "src/renderer/snip.html"), dictation: resolve(__dirname, "src/renderer/dictation.html") },
      },
    },
  },
});
