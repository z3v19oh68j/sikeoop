import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolFixtures } from "../protocol/fixtures.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../protocol/fixtures");
mkdirSync(root, { recursive: true });
for (const { name, frame } of protocolFixtures) {
  const path = resolve(root, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(frame, null, 2)}\n`, "utf8");
}
process.stdout.write(`Exported ${protocolFixtures.length} typed protocol fixtures to ${root}\n`);
