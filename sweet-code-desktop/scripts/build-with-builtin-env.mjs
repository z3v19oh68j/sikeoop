// Read only build variables from the external secrets file. Never source a shell file.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function parseBuiltinEnv(text, log = message => console.warn(message)) {
  const out = {};
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?(SIKEOOP_BUILTIN_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) return;
    let value = match[2];
    if (value.startsWith("'") || value.startsWith('"')) {
      const quote = value[0];
      const end = value.lastIndexOf(quote);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
        log(`[builtin-env] ignored line ${index + 1}: invalid quoting`); return;
      }
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([\\"nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" }[c] ?? c));
    } else value = value.replace(/\s+#.*$/, "").trim();
    out[match[1]] = value;
  });
  return out;
}

export function loadBuiltinEnv(file, inherited = process.env, read = readFileSync) {
  let content;
  try { content = read(file, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { ...inherited };
    // A sanitized error only: paths/content/OS error messages may expose secrets.
    throw new Error("Unable to read external builtin build environment");
  }
  return { ...parseBuiltinEnv(content), ...inherited };
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) {
  const root = resolve(dirname(script), "..");
  try {
    const env = loadBuiltinEnv(resolve(root, "../.secrets/sikeoop-builtin.env"));
    const manifest = JSON.parse(readFileSync(resolve(root, "node_modules/electron-vite/package.json"), "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["electron-vite"];
    // `dev` runs the app with the same free providers the build ships; anything else builds.
    const command = process.argv[2] === "dev" ? "dev" : "build";
    const child = spawnSync(process.execPath, [resolve(root, "node_modules/electron-vite", bin), command],
      { cwd: root, env, stdio: "inherit" });
    if (child.error) throw new Error(`Unable to start ${command}`);
    process.exitCode = child.status ?? 1;
  } catch {
    console.error("[builtin-env] build failed before completion");
    process.exitCode = 1;
  }
}
