import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProtoCanvas } from "@shared/types";
import { DEVICES, PROTO_DIR } from "./prototypes/store";

/** Create files only; the caller owns IPC registration and workspace switching. */
export async function createWebStarter(title: string): Promise<{ root: string }> {
  // Same validation as protoDir; calling protoDir itself requires an open workspace.
  const name = title.trim();
  if (!name || name.length > 40 || /[\\/:*?"<>|]/.test(name) || name.startsWith(".")) {
    throw new Error("原型名字不能为空，不能超过 40 个字，也不能有 / \\ : * ? \" < > | 这些符号");
  }
  const parent = path.join(os.homedir(), "sikeoop 作品");
  await fs.mkdir(parent, { recursive: true });

  let root: string;
  for (let suffix = 1; ; suffix++) {
    root = path.join(parent, suffix === 1 ? name : `${name}-${suffix}`);
    try {
      // Exclusive directory creation handles both existing paths and concurrent calls.
      await fs.mkdir(root);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  // Keep the prototype name unchanged even when the project folder has a suffix.
  const dir = path.join(root, PROTO_DIR, name);
  await fs.mkdir(path.join(root, PROTO_DIR));
  await fs.mkdir(dir);
  await fs.mkdir(path.join(dir, "screens"));
  const canvas: ProtoCanvas = {
    version: 1,
    start: "home",
    screens: [
      { id: "home", title: "首页", file: "screens/home.html", device: "phone", ...DEVICES.phone, x: 0, y: 0 },
    ],
  };
  await fs.writeFile(path.join(dir, "tokens.css"), TOKENS, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(path.join(dir, "screens/home.html"), homePage(name), { encoding: "utf8", flag: "wx" });
  // Write the manifest last so incomplete starters are not listed as prototypes.
  await fs.writeFile(path.join(dir, "canvas.json"), JSON.stringify(canvas, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return { root };
}

const TOKENS = `:root {
  --color-bg: #fff0f6;
  --color-surface: #ffffff;
  --color-ink: #702745;
  --color-muted: #a25e7b;
  --color-primary: #ec6b9c;
  --color-on-primary: #ffffff;
  --radius-lg: 24px;
  --font-sans: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: var(--color-bg); color: var(--color-ink); font: 16px/1.6 var(--font-sans); }
`;

function homePage(title: string): string {
  const escaped = title.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escaped}</title>
  <link rel="stylesheet" href="../tokens.css">
  <style>
    main { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 32px 24px; text-align: center; }
    .card { padding: 40px 24px; border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: 0 16px 48px #ec6b9c20; }
    .mark { font-size: 48px; color: var(--color-primary); }
    h1 { margin: 16px 0; font-size: 28px; overflow-wrap: anywhere; }
    p { margin: 0; color: var(--color-muted); }
    .badge { display: inline-block; margin-top: 28px; padding: 10px 24px; border-radius: 999px; background: var(--color-primary); color: var(--color-on-primary); }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="mark" aria-hidden="true">✿</div>
      <h1>欢迎来到 ${escaped}</h1>
      <p>你的新作品，从这里开始。<br>把灵感变成喜欢的模样。</p>
      <span class="badge">你好，新世界</span>
    </section>
  </main>
</body>
</html>
`;
}
