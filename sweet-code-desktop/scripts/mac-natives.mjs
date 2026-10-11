// npm only installs native binaries for the machine it runs on. The macOS build is made for both
// Apple silicon and Intel on one Mac, so the binaries of the other chip are fetched from the
// registry into node_modules here (the same way win-natives.mjs does it for Windows). Without
// them what needs these modules (the ArkTS check) fails on the chip the build machine doesn't have.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Packages whose binary comes as one optional dependency per platform ("<name>-darwin-x64").
const PARENTS = ["@arkts/project-detector", "@ohos-rs/oxk", "@napi-rs/canvas"];
const ARCHS = ["arm64", "x64"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const dirOf = (name) => path.join("node_modules", ...name.split("/"));
const manifest = (name) => {
  const file = path.join(dirOf(name), "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

for (const parent of PARENTS) {
  const wanted = manifest(parent)?.optionalDependencies;
  // Not installed (or it no longer ships per-platform binaries): nothing to add.
  if (!wanted) continue;
  for (const arch of ARCHS) {
    const name = `${parent}-darwin-${arch}`;
    // The version the installed parent asks for, so the binary always matches its JavaScript.
    const version = wanted[name];
    if (!version) throw new Error(`mac-natives: ${parent} has no ${name} to install`);
    const target = dirOf(name);
    // These packages pin an exact version; with a range, whatever copy is there is taken.
    const exact = /^\d/.test(version);
    const have = manifest(name)?.version;
    if (exact ? have === version : have) continue;
    const spec = `${name}@${version}`;
    const tmp = mkdtempSync(path.join(tmpdir(), "mac-natives-"));
    try {
      const file = execFileSync(npm, ["pack", spec, "--silent", "--pack-destination", tmp], { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
      // A copy of another version is replaced, not mixed with.
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      execFileSync("tar", ["-xzf", path.join(tmp, file), "-C", target, "--strip-components=1"]);
      const got = manifest(name);
      if (got?.name !== name || (exact && got.version !== version) || !readdirSync(target).some((f) => f.endsWith(".node"))) {
        // Nothing half-right is left for the packager to pick up.
        rmSync(target, { recursive: true, force: true });
        throw new Error(`mac-natives: ${spec} did not unpack into a native package`);
      }
      console.log(`mac-natives: ${spec}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
