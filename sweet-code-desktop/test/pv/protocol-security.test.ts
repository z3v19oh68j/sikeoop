import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { servePvMedia } from "../../src/main/pv/protocol.ts";

test("PV media has no wildcard CORS on GET/HEAD/range/errors and is not registered in browser partition", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pv-cors-"));
  try {
    await fs.mkdir(path.join(root, "pv", "id", "out"), { recursive: true });
    await fs.writeFile(path.join(root, "pv", "id", "out", "video.mp4"), "123456");
    for (const init of [{}, { method: "HEAD" }, { headers: { Range: "bytes=0-1" } }, { headers: { Range: "bytes=99-" } }, { method: "POST" }]) {
      const response = await servePvMedia(new Request("sikeoop-pv://id/video.mp4", init), () => root);
      assert.equal(response.headers.has("Access-Control-Allow-Origin"), false); await response.arrayBuffer();
    }
    // Static registration evidence without loading Electron or launching the app.
    const index = await fs.readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    assert.match(index, /protocol\.handle\(PV_SCHEME/);
    const browser = await fs.readFile(new URL("../../src/main/browser/service.ts", import.meta.url), "utf8");
    assert.match(browser, /persist:sikeoop-browser/); assert.doesNotMatch(browser, /sikeoop-pv|PV_SCHEME|servePvMedia/);
    assert.doesNotMatch(index, /fromPartition\([^)]*sikeoop-browser[^)]*\)[\s\S]{0,100}handle\(PV_SCHEME/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
