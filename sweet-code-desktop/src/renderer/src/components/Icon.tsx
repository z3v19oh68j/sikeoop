import { useSkin } from "../skin";
// Inline SVG icons from assets/icons. Inlined (not <img>) so UI icons inherit the text color via currentColor.
const files = import.meta.glob<string>("../assets/icons/*.svg", { eager: true, query: "?raw", import: "default" });

const icons: Record<string, string> = {};
for (const [p, svg] of Object.entries(files)) icons[p.slice(p.lastIndexOf("/") + 1, -4)] = svg;

export function Icon({ name, className }: { name: string; className?: string }) {
  // A skin (skin.ts) may bring its own drawing of the same icon.
  const skin = useSkin();
  const svg = skin.icons?.[name] ?? icons[name] ?? icons["ft-file"];
  return <span className={className ? `icon ${className}` : "icon"} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const EXT_ICONS: Record<string, string> = {
  js: "ft-js", mjs: "ft-js", cjs: "ft-js", jsx: "ft-js",
  ts: "ft-ts", tsx: "ft-ts",
  html: "ft-html",
  css: "ft-css", scss: "ft-css", less: "ft-css",
  json: "ft-json",
  md: "ft-md", mdc: "ft-md",
  py: "ft-py",
  png: "ft-image", jpg: "ft-image", jpeg: "ft-image", webp: "ft-image", gif: "ft-image", svg: "ft-image",
  env: "ft-config", yml: "ft-config", yaml: "ft-config", toml: "ft-config",
  // Drawn later (ICONS.md); until then they fall back to ft-file.
  c: "ft-c", h: "ft-c",
  cpp: "ft-cpp", cc: "ft-cpp", cxx: "ft-cpp", hpp: "ft-cpp", hh: "ft-cpp", ino: "ft-cpp",
  cs: "ft-csharp", java: "ft-java", kt: "ft-kotlin", go: "ft-go", rs: "ft-rust", swift: "ft-swift",
  php: "ft-php", rb: "ft-ruby", lua: "ft-lua", dart: "ft-dart", sql: "ft-sql",
  sh: "ft-shell", bash: "ft-shell", zsh: "ft-shell", ps1: "ft-shell", bat: "ft-shell",
  vue: "ft-vue", nvue: "ft-vue", svelte: "ft-svelte", wxml: "ft-html", wxss: "ft-css",
  xml: "ft-xml", ets: "ft-ts",
};

export function fileIconName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (EXT_ICONS[ext]) return EXT_ICONS[ext];
  if (fileName.startsWith(".")) return "ft-config";
  return "ft-file";
}
