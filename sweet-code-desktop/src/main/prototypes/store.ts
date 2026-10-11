import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProtoCanvas, ProtoDevice, ProtoDoc, ProtoScreen, ProtoSummary } from "@shared/types";
import { getRoot, isInside, realpathOfNew } from "../workspace";

// Prototypes live in the project, as plain files the agent can edit with its normal tools:
//   prototypes/<name>/canvas.json      where each screen sits on the canvas
//   prototypes/<name>/tokens.css       design tokens (CSS variables) shared by all screens
//   prototypes/<name>/screens/*.html   one full HTML page per screen
// A [data-goto="<screen id>"] element jumps to that screen in the demo.

export const PROTO_DIR = "prototypes";
export const DEVICES: Record<ProtoDevice, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};
const GAP = 120;

export function protoRoot(): string {
  return path.join(getRoot(), PROTO_DIR);
}

/** Folder of one prototype; refuses names that would leave prototypes/. */
export function protoDir(name: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 40 || /[\\/:*?"<>|]/.test(clean) || clean.startsWith(".")) {
    throw new Error("原型名字不能为空，不能超过 40 个字，也不能有 / \\ : * ? \" < > | 这些符号");
  }
  return path.join(protoRoot(), clean);
}

/**
 * The real folder of one prototype, refusing symlinks (of prototypes/ or of the prototype
 * itself) that lead outside the project. Every read and write here goes through it.
 */
export async function realDir(name: string): Promise<string> {
  const top = await realpathOfNew(protoRoot());
  const dir = await realpathOfNew(protoDir(name));
  if (!isInside(getRoot(), top) || top === dir || !isInside(top, dir)) {
    throw new Error(`原型「${name}」的文件夹在项目外面，不能访问`);
  }
  return dir;
}

export async function list(): Promise<ProtoSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(protoRoot(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: ProtoSummary[] = [];
  for (const name of names) {
    try {
      const file = await insideDir(await realDir(name), "canvas.json");
      const [st, text] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
      const canvas = JSON.parse(text) as Partial<ProtoCanvas>;
      out.push({ name, screens: Array.isArray(canvas.screens) ? canvas.screens.length : 0, updatedAt: st.mtimeMs });
    } catch {
      // Not a prototype folder.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function load(name: string): Promise<ProtoDoc> {
  const dir = await realDir(name);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(await insideDir(dir, "canvas.json"), "utf8"));
  } catch (err) {
    throw new Error(`读不了原型「${name}」的 canvas.json：${(err as Error).message}`);
  }
  const { canvas, warnings } = normalize(raw);
  const sources: Record<string, string> = {};
  for (const s of canvas.screens) {
    try {
      sources[s.id] = await fs.readFile(await insideDir(dir, s.file), "utf8");
    } catch {
      warnings.push(`页面「${s.title}」的文件 ${s.file} 不存在`);
      sources[s.id] = "";
    }
  }
  return { name, canvas, sources, warnings };
}

/** Accept a hand- or AI-edited canvas.json: fill in what's missing instead of failing. */
function normalize(raw: unknown): { canvas: ProtoCanvas; warnings: string[] } {
  const warnings: string[] = [];
  const obj = (raw && typeof raw === "object" ? raw : {}) as Partial<ProtoCanvas>;
  const screens: ProtoScreen[] = [];
  const ids = new Set<string>();
  let nextX = 0;
  for (const s of Array.isArray(obj.screens) ? obj.screens : []) {
    if (!s || typeof s !== "object" || typeof s.file !== "string") {
      warnings.push("canvas.json 里有一个页面缺少 file，已跳过");
      continue;
    }
    const device: ProtoDevice = s.device === "tablet" || s.device === "desktop" ? s.device : "phone";
    const size = DEVICES[device];
    let id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : path.basename(s.file, ".html");
    while (ids.has(id)) id += "-2";
    ids.add(id);
    const width = num(s.width, size.width);
    const screen: ProtoScreen = {
      id,
      title: typeof s.title === "string" && s.title.trim() ? s.title : id,
      file: s.file,
      device,
      width,
      height: num(s.height, size.height),
      x: num(s.x, nextX),
      y: num(s.y, 0),
    };
    screens.push(screen);
    nextX = Math.max(nextX, screen.x + screen.width + GAP);
  }
  const start = typeof obj.start === "string" && ids.has(obj.start) ? obj.start : screens[0]?.id;
  return { canvas: { version: 1, start, screens }, warnings };
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);

/** `rel` inside the (real) prototype folder `dir`, also after following symlinks. */
export async function insideDir(dir: string, rel: string): Promise<string> {
  const abs = path.resolve(dir, rel);
  const real = await realpathOfNew(abs);
  if (abs === dir || !isInside(dir, abs) || real === dir || !isInside(dir, real)) throw new Error(`文件 ${rel} 不在原型文件夹里`);
  return real;
}

export async function saveCanvas(name: string, canvas: ProtoCanvas): Promise<void> {
  const dir = await realDir(name);
  const { canvas: clean } = normalize(canvas);
  const file = await insideDir(dir, "canvas.json");
  // The temp file is checked too and created exclusively ("wx" never follows a planted link).
  const tmp = await insideDir(dir, `canvas.json.${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function create(name: string): Promise<ProtoDoc> {
  const dir = await realDir(name);
  try {
    await fs.access(dir);
    throw new Error(`已经有一个叫「${name}」的原型了`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.join(dir, "screens"), { recursive: true });
  await fs.writeFile(await insideDir(dir, "tokens.css"), TOKENS, "utf8");
  await fs.writeFile(await insideDir(dir, "screens/welcome.html"), welcomeScreen(name), "utf8");
  await fs.writeFile(await insideDir(dir, "screens/home.html"), homeScreen(), "utf8");
  const phone = DEVICES.phone;
  await saveCanvas(name, {
    version: 1,
    start: "welcome",
    screens: [
      { id: "welcome", title: "欢迎", file: "screens/welcome.html", device: "phone", ...phone, x: 0, y: 0 },
      { id: "home", title: "首页", file: "screens/home.html", device: "phone", ...phone, x: phone.width + GAP, y: 0 },
    ],
  });
  return load(name);
}

export async function addScreen(name: string, input: { title: string; device: ProtoDevice }): Promise<ProtoDoc> {
  const dir = await realDir(name);
  const doc = await load(name);
  const title = input.title.trim() || "新页面";
  // A readable, unique id: the title when it's ASCII, else screen-N.
  const base = /^[a-z0-9-]+$/i.test(title) ? title.toLowerCase() : "screen";
  let id = base;
  for (let n = 2; doc.canvas.screens.some((s) => s.id === id); n++) id = `${base}-${n}`;
  const file = `screens/${id}.html`;
  await fs.writeFile(await insideDir(dir, file), blankScreen(title), "utf8");
  const size = DEVICES[input.device];
  const right = Math.max(0, ...doc.canvas.screens.map((s) => s.x + s.width + GAP));
  doc.canvas.screens.push({ id, title, file, device: input.device, ...size, x: doc.canvas.screens.length ? right : 0, y: 0 });
  await saveCanvas(name, doc.canvas);
  return load(name);
}

// ---- starter files ------------------------------------------------------------------------

const TOKENS = `/* 设计令牌：所有页面共用。改这里，所有页面一起变。 */
:root {
  --color-bg: #fbf7f2;
  --color-surface: #ffffff;
  --color-ink: #2a2420;
  --color-muted: #7a6f66;
  --color-line: #efe7de;
  --color-primary: #e8553f;
  --color-on-primary: #ffffff;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  --font-sans: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --text-title: 700 24px/1.3 var(--font-sans);
  --text-body: 400 15px/1.6 var(--font-sans);
  --text-caption: 400 12px/1.5 var(--font-sans);
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: var(--color-bg); color: var(--color-ink); font: var(--text-body); -webkit-font-smoothing: antialiased; }
button { font: inherit; cursor: pointer; }
`;

const page = (title: string, body: string, style = "") => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="../tokens.css">
  <style>
${style}
  </style>
</head>
<body>
${body}
</body>
</html>
`;

const welcomeScreen = (name: string) =>
  page(
    "欢迎",
    `  <main class="welcome">
    <div class="logo">${name.slice(0, 1)}</div>
    <h1>${name}</h1>
    <p>一句话说清楚这个 App 是做什么的。</p>
    <span class="spacer"></span>
    <button class="primary" data-goto="home">开始使用</button>
  </main>`,
    `    .welcome { min-height: 100vh; display: flex; flex-direction: column; gap: 12px; padding: 96px 28px 40px; }
    .logo { width: 56px; height: 56px; border-radius: var(--radius-lg); background: var(--color-primary); color: var(--color-on-primary); display: grid; place-items: center; font: var(--text-title); }
    h1 { margin: 12px 0 0; font: var(--text-title); }
    p { margin: 0; color: var(--color-muted); }
    .spacer { flex: 1; }
    .primary { height: 52px; border: 0; border-radius: var(--radius-lg); background: var(--color-primary); color: var(--color-on-primary); font-weight: 600; }`,
  );

const homeScreen = () =>
  page(
    "首页",
    `  <main class="home">
    <header>
      <button class="back" data-goto="welcome" aria-label="返回">‹</button>
      <h1>首页</h1>
    </header>
    <ul class="list">
      <li class="card">第一项</li>
      <li class="card">第二项</li>
      <li class="card">第三项</li>
    </ul>
  </main>`,
    `    .home { padding: 56px 20px 24px; display: flex; flex-direction: column; gap: 16px; }
    header { display: flex; align-items: center; gap: 8px; }
    .back { width: 36px; height: 36px; border: 0; border-radius: var(--radius-md); background: var(--color-surface); font-size: 22px; line-height: 1; }
    h1 { margin: 0; font: var(--text-title); }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .card { padding: 16px; border-radius: var(--radius-md); background: var(--color-surface); border: 1px solid var(--color-line); }`,
  );

const blankScreen = (title: string) =>
  page(
    title,
    `  <main class="screen">
    <h1>${title.replace(/</g, "&lt;")}</h1>
  </main>`,
    `    .screen { padding: 56px 24px 24px; }
    h1 { margin: 0; font: var(--text-title); }`,
  );
