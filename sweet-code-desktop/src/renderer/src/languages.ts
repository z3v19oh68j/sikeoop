import { monaco } from "./monaco";

// One highlighting system for the whole app: the editor, code blocks in chat and the diffs in
// approval cards all use Monaco's tokenizers (about 80 languages built in) and the sweet-dark
// theme, so the same code looks the same everywhere.

// ---- Files Monaco doesn't know by itself -------------------------------------------------
// Close-enough tokenizers for popular formats without a grammar of their own.
const EXTRA: { id: string; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[] }[] = [
  // Single-file components and templates: HTML with <script> and <style> inside.
  { id: "html", extensions: [".vue", ".nvue", ".uvue", ".svelte", ".astro", ".wxml", ".axml", ".swan", ".ejs", ".njk"] },
  { id: "css", extensions: [".wxss", ".acss", ".pcss", ".postcss"] },
  { id: "typescript", extensions: [".ets"] }, // ArkTS (HarmonyOS)
  { id: "javascript", extensions: [".json5", ".wxs", ".sjs"] },
  { id: "cpp", extensions: [".ino", ".cu", ".cuh", ".ipp", ".tpp", ".c++", ".h++"] },
  { id: "python", extensions: [".pyi", ".ipy"], filenames: ["SConstruct", "SConscript"] },
  { id: "shell", extensions: [".zsh", ".fish", ".ksh", ".command"], filenames: ["Makefile", "makefile", "GNUmakefile", ".bashrc", ".zshrc", ".profile", ".bash_profile"] },
  { id: "ini", extensions: [".toml", ".cfg", ".conf", ".editorconfig", ".npmrc", ".env"], filenames: [".editorconfig", ".npmrc", ".yarnrc", ".gitattributes", ".gitmodules"], filenamePatterns: [".env.*"] },
  { id: "json", extensions: [".jsonc", ".webmanifest", ".har"], filenames: [".prettierrc", ".babelrc", ".eslintrc", ".swcrc", "composer.lock"] },
  { id: "yaml", filenames: [".clang-format", ".clangd"] },
  { id: "xml", extensions: [".svg", ".plist", ".csproj", ".xaml", ".storyboard"] },
  { id: "dockerfile", filenamePatterns: ["Dockerfile.*", "*.dockerfile", "Containerfile"] },
  { id: "markdown", extensions: [".markdown", ".mdown"] },
];
for (const l of EXTRA) monaco.languages.register(l);

// ---- Names people write after ``` -------------------------------------------------------
const ALIASES: Record<string, string> = {
  "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", h: "c", arduino: "cpp", cuda: "cpp",
  "c#": "csharp", cs: "csharp", "f#": "fsharp", fs: "fsharp",
  objc: "objective-c", "obj-c": "objective-c", objectivec: "objective-c",
  js: "javascript", jsx: "javascript", node: "javascript", mjs: "javascript", cjs: "javascript", json5: "javascript",
  ts: "typescript", tsx: "typescript", arkts: "typescript", ets: "typescript",
  h5: "html", html5: "html", vue: "html", svelte: "html", xhtml: "html", wxml: "html",
  wxss: "css", sass: "scss", styl: "css", stylus: "css",
  py: "python", python3: "python", py3: "python", ipython: "python",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", terminal: "shell", fish: "shell", makefile: "shell", make: "shell",
  ps: "powershell", ps1: "powershell", pwsh: "powershell", cmd: "bat", batch: "bat",
  yml: "yaml", toml: "ini", env: "ini", dotenv: "ini", conf: "ini", properties: "ini",
  jsonc: "json", rs: "rust", golang: "go", kt: "kotlin", kts: "kotlin", rb: "ruby", pl: "perl",
  md: "markdown", mdx: "mdx", docker: "dockerfile", gql: "graphql", proto: "protobuf",
  svg: "xml", plist: "xml", vb: "vb", vbnet: "vb", psql: "pgsql", postgres: "pgsql", postgresql: "pgsql",
  sol: "solidity", tex: "plaintext", text: "plaintext", txt: "plaintext", plain: "plaintext", diff: "plaintext",
};

const known = () => monaco.languages.getLanguages();

/** The Monaco language for a code-fence tag ("ts", "c++", "h5", "Python"…); plaintext if unknown. */
export function languageForTag(tag: string): string {
  const t = tag.trim().toLowerCase().split(/[\s{]/)[0];
  if (!t) return "plaintext";
  if (ALIASES[t]) return ALIASES[t];
  const langs = known();
  const hit =
    langs.find((l) => l.id === t) ??
    langs.find((l) => l.aliases?.some((a) => a.toLowerCase() === t)) ??
    langs.find((l) => l.extensions?.includes(`.${t}`));
  return hit?.id ?? "plaintext";
}

// Languages from installed editor extensions (extensions.ts) beat sikeoop's stand-ins.
let overrideExt = new Map<string, string>();
let overrideName = new Map<string, string>();

export function setLanguageOverrides(byExtension: Map<string, string>, byFilename: Map<string, string>): void {
  overrideExt = byExtension;
  overrideName = byFilename;
}

/** The Monaco language for a file path, by exact file name, then pattern, then the longest extension. */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const lower = name.toLowerCase();
  const fromExt = overrideName.get(name) ?? [...overrideExt].filter(([e]) => lower.endsWith(e)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (fromExt) return fromExt;
  const langs = known();
  const byName = langs.find((l) => l.filenames?.includes(name));
  if (byName) return byName.id;
  const byPattern = langs.find((l) => l.filenamePatterns?.some((p) => globMatch(p, name)));
  if (byPattern) return byPattern.id;
  let best = { id: "plaintext", len: 0 };
  for (const l of langs) {
    for (const ext of l.extensions ?? []) {
      if (lower.endsWith(ext.toLowerCase()) && ext.length > best.len) best = { id: l.id, len: ext.length };
    }
  }
  return best.id;
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(name);
}

const NAMES: Record<string, string> = {
  plaintext: "纯文本", cpp: "C++", c: "C", csharp: "C#", fsharp: "F#", "objective-c": "Objective-C", javascript: "JavaScript",
  typescript: "TypeScript", html: "HTML", css: "CSS", scss: "SCSS", less: "Less", json: "JSON", python: "Python", shell: "Shell",
  powershell: "PowerShell", bat: "Batch", ini: "INI / TOML", yaml: "YAML", xml: "XML", markdown: "Markdown", mdx: "MDX",
  dockerfile: "Dockerfile", sql: "SQL", mysql: "MySQL", pgsql: "PostgreSQL", go: "Go", rust: "Rust", java: "Java", kotlin: "Kotlin",
  swift: "Swift", php: "PHP", ruby: "Ruby", lua: "Lua", dart: "Dart", r: "R", scala: "Scala", graphql: "GraphQL", protobuf: "Protobuf",
  solidity: "Solidity", vb: "Visual Basic", perl: "Perl", julia: "Julia",
};

/** A readable name for a language id, for the status bar and code block headers. */
export function languageName(id: string): string {
  if (NAMES[id]) return NAMES[id];
  return known().find((l) => l.id === id)?.aliases?.[0] ?? id;
}

/** Formats that borrow another language's tokenizer still show their own name. */
const FILE_LABELS: Record<string, string> = {
  vue: "Vue", nvue: "Vue", uvue: "Vue", svelte: "Svelte", astro: "Astro", wxml: "WXML", wxss: "WXSS", wxs: "WXS",
  ets: "ArkTS", json5: "JSON5", jsonc: "JSON with Comments", toml: "TOML", env: "Env", ino: "Arduino", cu: "CUDA",
  tsx: "TypeScript React", jsx: "JavaScript React", h: "C / C++ 头文件", svg: "SVG",
};

/** The status-bar name for a file: its own format's name, else its language's. */
export function fileLanguageLabel(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name === "makefile" || name === "gnumakefile") return "Makefile";
  if (name === ".env" || name.startsWith(".env.")) return "Env";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return FILE_LABELS[ext] ?? languageName(languageForPath(path));
}

/** The header name for a code fence tag ("vue" → Vue, "c++" → C++, unknown → the tag itself). */
export function tagLabel(tag: string): string {
  const t = tag.trim().toLowerCase().split(/[\s{]/)[0];
  if (FILE_LABELS[t]) return FILE_LABELS[t];
  const id = languageForTag(t);
  return id === "plaintext" ? tag.trim() : languageName(id);
}

// ---- Colorizing outside the editor -------------------------------------------------------

const cache = new Map<string, string[]>();
const CACHE_MAX = 200;

/**
 * Highlight code and return one HTML string per line (Monaco escapes the text, so model output
 * can't inject markup). Unknown languages come back as plain, escaped lines.
 */
export async function colorizeLines(code: string, language: string): Promise<string[]> {
  const key = `${language}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const html = await monaco.editor.colorize(code, language, { tabSize: 2 });
  const lines = html.split("<br/>");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, lines);
  return lines;
}
