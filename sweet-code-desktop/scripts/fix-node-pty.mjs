// node-pty ships its macOS spawn-helper without the executable bit, which makes
// every terminal fail with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "node_modules", "node-pty", "prebuilds");
if (existsSync(root)) {
  for (const dir of readdirSync(root)) {
    const helper = join(root, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
