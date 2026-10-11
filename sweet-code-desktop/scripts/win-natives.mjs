// npm only installs native binaries for the machine it runs on. Packaging the Windows build on a
// Mac still needs the Windows ones, so they are fetched from the registry into node_modules here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGES = ["@ohos-rs/oxk-win32-x64-msvc@0.2.2", "@arkts/project-detector-win32-x64-msvc@1.1.3-alpha.29"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const spec of PACKAGES) {
  const name = spec.slice(0, spec.lastIndexOf("@"));
  const target = path.join("node_modules", ...name.split("/"));
  if (existsSync(path.join(target, "package.json"))) continue;
  const tmp = mkdtempSync(path.join(tmpdir(), "win-natives-"));
  try {
    const file = execFileSync(npm, ["pack", spec, "--silent", "--pack-destination", tmp], { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(tmp, file), "-C", target, "--strip-components=1"]);
    console.log(`win-natives: ${spec}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
