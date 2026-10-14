import { resolve } from "node:path";
import web from "../../vite.web.config";

// The renderer as it ships (production React, minified), with the dev mock in place of the main
// process, so scripts/perf/run.mjs can drive it in a plain Chromium. main.tsx installs the mock
// only when import.meta.env.DEV, hence the define.
export default {
  ...web,
  define: { "import.meta.env.DEV": "true" },
  build: { outDir: resolve(__dirname, "../../out/perf-web"), emptyOutDir: true, reportCompressedSize: false },
};
