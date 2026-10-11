import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";
import type { ModManifest, ModPermission, ModPreview, ModView } from "@shared/types";
import type { ExtraHook } from "../hooks/bus";
import { defineTool, type ToolSpec } from "../tools/registry";
import { API_VERSION, type ModHookEvent, type ModHookInput, type ModHookResult, type ModModule, type ModTool, type SikeoopModApi } from "./api";

// Mods: third-party JavaScript loaded into the main process. Each lives in a folder with a
// mod.json (manifest) and an entry file exporting activate(api). What a mod can reach through
// `api` is gated by the permissions in its manifest, which the user sees before installing.
// That gate is a contract, not a sandbox: the code runs with the app's full rights. So trust is
// pinned to content — a mod whose files changed since the user accepted it is not loaded again
// until they accept it again. Dev mods (linked folders) skip that check: the user is their author.

const MOD_FILE = "mod.json";
const MAX_FILES = 4000;
const MAX_BYTES = 50 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const PERMISSIONS: ModPermission[] = ["tools", "hooks", "model", "notify", "network", "fs", "shell"];
const EVENTS: ModHookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

interface Meta {
  enabled: boolean;
  dev: boolean;
  dir: string;
  /** Content hash the user accepted. */
  hash: string;
  installedAt: number;
}

interface Running {
  tools: ModTool[];
  hooks: { event: ModHookEvent; handler: Parameters<SikeoopModApi["hooks"]["on"]>[1] }[];
  disposers: (() => void | Promise<void>)[];
  module: ModModule;
}

type Files = Map<string, Uint8Array>;

export interface ModDeps {
  /** <userData>/mods: installed copies. */
  dir: string;
  metaFile: string;
  dataDir: string;
  appVersion: string;
  root(): string;
  complete(system: string, user: string, opts: { maxTokens: number; signal?: AbortSignal }): Promise<string>;
  notify(text: string, detail: string): void;
}

export class ModManager {
  private meta: Record<string, Meta> = {};
  private running = new Map<string, Running>();
  private errors = new Map<string, string>();
  private changed = new Set<string>();
  private previews = new Map<string, { manifest: ModManifest; files: Files; source: string }>();
  private storage = new Map<string, Record<string, unknown>>();

  constructor(private readonly deps: ModDeps) {}

  // ---- startup --------------------------------------------------------------

  async load(): Promise<void> {
    try {
      this.meta = JSON.parse(await fs.readFile(this.deps.metaFile, "utf8")) as Record<string, Meta>;
    } catch {
      // No mods yet.
    }
    await this.refreshNames();
    for (const [id, m] of Object.entries(this.meta)) if (m.enabled) await this.start(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id);
  }

  // ---- what the rest of the app uses ---------------------------------------

  /** Tools of all running mods, for new conversations. */
  tools(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [id, r] of this.running) {
      for (const t of r.tools) out.push(this.wrapTool(id, t));
    }
    return out;
  }

  /** Hooks of running mods for one event (the hook bus asks each time an event fires). */
  hooks(event: string): ExtraHook[] {
    const out: ExtraHook[] = [];
    for (const [id, r] of this.running) {
      const name = `Mod ${this.manifestName(id)}`;
      for (const h of r.hooks) {
        if (h.event !== event) continue;
        out.push({ name, run: async (input, ctx) => (await h.handler(input as ModHookInput, { root: ctx.root, sessionId: ctx.sessionId, signal: ctx.signal })) ?? undefined });
      }
    }
    return out;
  }

  // ---- list / install / remove --------------------------------------------

  async list(): Promise<ModView[]> {
    const out: ModView[] = [];
    for (const [id, m] of Object.entries(this.meta)) {
      const manifest = await readManifest(m.dir).catch(() => null);
      const r = this.running.get(id);
      out.push({
        ...(manifest ?? { id, name: id, version: "?", description: "找不到 mod.json", permissions: [] }),
        id,
        enabled: m.enabled,
        dev: m.dev,
        dir: m.dir,
        status: this.changed.has(id) ? "changed" : r ? "running" : this.errors.has(id) ? "error" : "off",
        error: this.errors.get(id),
        tools: r?.tools.map((t) => `mod__${id}__${t.name}`) ?? [],
        hooks: r?.hooks.map((h) => h.event) ?? [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async previewFolder(dir: string): Promise<ModPreview> {
    return this.preview(await readFolder(dir), dir);
  }

  async previewZip(file: string): Promise<ModPreview> {
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_BYTES) throw new Error("文件太大了（超过 50MB）");
    return this.preview(stripTopFolder(unzipSync(new Uint8Array(bytes))), file);
  }

  private preview(files: Files, source: string): ModPreview {
    const errors: string[] = [];
    const raw = files.get(MOD_FILE);
    if (!raw) throw new Error("这里没有 mod.json，不是 sikeoop 的 mod");
    let manifest: ModManifest;
    try {
      manifest = validate(JSON.parse(Buffer.from(raw).toString("utf8")), errors);
    } catch (err) {
      throw new Error(`mod.json 读不了：${(err as Error).message}`);
    }
    if (manifest.minAppVersion && newer(manifest.minAppVersion, this.deps.appVersion)) {
      errors.push(`需要 sikeoop ${manifest.minAppVersion} 以上，你的是 ${this.deps.appVersion}`);
    }
    if (!files.has(manifest.main ?? "index.js")) errors.push(`找不到入口文件 ${manifest.main ?? "index.js"}`);
    const id = randomUUID();
    this.previews.set(id, { manifest, files, source });
    return { id, manifest, exists: !!this.meta[manifest.id], files: files.size, errors };
  }

  /** dev: link the source folder in place (folders only) instead of copying it. */
  async install(previewId: string, dev: boolean): Promise<void> {
    const p = this.previews.get(previewId);
    if (!p) throw new Error("预览过期了，重新选一次");
    const errors: string[] = [];
    validate(p.manifest, errors);
    if (errors.length) throw new Error(errors.join("；"));
    const id = p.manifest.id;
    await this.stop(id);
    let dir: string;
    if (dev) {
      if (p.source.toLowerCase().endsWith(".zip")) throw new Error("开发模式只能链接文件夹");
      dir = p.source;
    } else {
      dir = path.join(this.deps.dir, id);
      await fs.rm(dir, { recursive: true, force: true });
      for (const [rel, data] of p.files) {
        const to = path.join(dir, rel);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.writeFile(to, data);
      }
    }
    this.meta[id] = { enabled: true, dev, dir, hash: hashFiles(p.files), installedAt: Date.now() };
    this.previews.delete(previewId);
    this.changed.delete(id);
    await this.save();
    await this.start(id);
  }

  async remove(id: string): Promise<void> {
    const m = this.meta[id];
    if (!m) return;
    await this.stop(id);
    if (!m.dev) await fs.rm(m.dir, { recursive: true, force: true });
    await fs.rm(path.join(this.deps.dataDir, `${id}.json`), { force: true });
    delete this.meta[id];
    this.errors.delete(id);
    this.changed.delete(id);
    await this.save();
  }

  /** Turning on a "changed" mod is the user accepting its new content. */
  async setEnabled(id: string, on: boolean): Promise<void> {
    const m = this.meta[id];
    if (!m) return;
    m.enabled = on;
    if (on && this.changed.has(id)) {
      m.hash = hashFiles(await readFolder(m.dir));
      this.changed.delete(id);
    }
    await this.save();
    if (on) await this.start(id);
    else await this.stop(id);
  }

  async reload(id: string): Promise<void> {
    await this.stop(id);
    if (this.meta[id]?.enabled) await this.start(id);
  }

  // ---- running --------------------------------------------------------------

  private async start(id: string): Promise<void> {
    const m = this.meta[id];
    if (!m || this.running.has(id)) return;
    this.errors.delete(id);
    try {
      const files = await readFolder(m.dir);
      if (!m.dev && hashFiles(files) !== m.hash) {
        this.changed.add(id);
        return;
      }
      const manifest = await readManifest(m.dir);
      const entry = path.join(m.dir, manifest.main ?? "index.js");
      // A fresh copy of the mod's own files on every start, so reload picks up edits.
      const req = createRequire(entry);
      for (const key of Object.keys(req.cache)) if (key.startsWith(m.dir + path.sep)) delete req.cache[key];
      const mod = req(entry) as ModModule & { default?: ModModule };
      const module = typeof mod.activate === "function" ? mod : mod.default;
      if (!module || typeof module.activate !== "function") throw new Error("入口文件没有导出 activate(api)");
      const running: Running = { tools: [], hooks: [], disposers: [], module };
      this.running.set(id, running);
      await module.activate(this.api(id, manifest, running));
    } catch (err) {
      this.running.delete(id);
      this.errors.set(id, (err as Error).message);
      console.error(`[mod ${id}]`, err);
    }
  }

  private async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    for (const fn of r.disposers.reverse()) await Promise.resolve().then(fn).catch((err) => console.error(`[mod ${id}] dispose:`, err));
    await Promise.resolve()
      .then(() => r.module.deactivate?.())
      .catch((err) => console.error(`[mod ${id}] deactivate:`, err));
  }

  private api(id: string, manifest: ModManifest, running: Running): SikeoopModApi {
    const need = (p: ModPermission) => {
      if (!manifest.permissions.includes(p)) throw new Error(`mod ${id} 没有声明 "${p}" 权限（在 mod.json 的 permissions 里加上）`);
    };
    const live = () => {
      if (this.running.get(id) !== running) throw new Error(`mod ${id} 已停止`);
    };
    return {
      apiVersion: API_VERSION,
      appVersion: this.deps.appVersion,
      mod: { id, version: manifest.version, dir: this.meta[id].dir },
      tools: {
        register: (tool) => {
          need("tools");
          live();
          if (!TOOL_NAME.test(tool?.name ?? "")) throw new Error(`工具名不合法：${tool?.name}`);
          if (running.tools.some((t) => t.name === tool.name)) throw new Error(`工具 ${tool.name} 注册过了`);
          running.tools.push(tool);
        },
      },
      hooks: {
        on: (event, handler) => {
          need("hooks");
          live();
          if (!EVENTS.includes(event)) throw new Error(`不支持的事件：${event}`);
          running.hooks.push({ event, handler });
        },
      },
      model: {
        complete: (system, user, opts) => {
          need("model");
          live();
          return this.deps.complete(system, user, { maxTokens: Math.min(opts?.maxTokens ?? 2000, 8000), signal: opts?.signal });
        },
      },
      notify: (text, detail) => {
        need("notify");
        live();
        this.deps.notify(String(text).slice(0, 60), String(detail ?? "").slice(0, 200));
      },
      storage: {
        get: <T>(key: string) => this.store(id)[key] as T | undefined,
        set: async (key, value) => {
          const s = this.store(id);
          s[key] = value;
          await fs.mkdir(this.deps.dataDir, { recursive: true });
          await fs.writeFile(path.join(this.deps.dataDir, `${id}.json`), JSON.stringify(s), "utf8");
        },
      },
      workspace: { root: () => this.deps.root() },
      log: (...args) => console.log(`[mod ${id}]`, ...args),
      onDispose: (fn) => running.disposers.push(fn),
    };
  }

  private store(id: string): Record<string, unknown> {
    let s = this.storage.get(id);
    if (!s) {
      try {
        s = JSON.parse(readFileSync(path.join(this.deps.dataDir, `${id}.json`), "utf8")) as Record<string, unknown>;
      } catch {
        s = {};
      }
      this.storage.set(id, s);
    }
    return s;
  }

  private wrapTool(id: string, t: ModTool): ToolSpec {
    const name = `mod__${id}__${t.name}`.slice(0, 64);
    const label = this.manifestName(id);
    return defineTool({
      name,
      description: `[Mod ${label}] ${t.description}`,
      schema: { parse: (v: unknown) => v } as never,
      inputSchema: (t.inputSchema?.type === "object" ? t.inputSchema : { type: "object", properties: {} }) as ToolSpec["inputSchema"],
      permission: t.permission === "auto" ? "auto" : "confirm",
      parallelSafe: t.permission === "auto",
      summarize: (input) => {
        try {
          return t.summary?.(input as Record<string, unknown>) ?? `${label}：${t.name}`;
        } catch {
          return `${label}：${t.name}`;
        }
      },
      run: async (input, ctx) => {
        const args = (input ?? {}) as Record<string, unknown>;
        if (t.permission !== "auto") {
          const outcome = await ctx.requestApproval({ kind: "tool", server: `Mod ${label}`, tool: t.name, description: t.description, args: JSON.stringify(args, null, 2) });
          if (!outcome.approved) {
            return outcome.feedback?.trim()
              ? `The user declined this tool call and said: "${outcome.feedback.trim()}".`
              : "The user declined this tool call. Ask what they would like instead.";
          }
        }
        if (!this.running.has(id)) throw new Error(`Mod ${label} is turned off.`);
        const out = await t.run(args, { root: this.deps.root(), signal: ctx.signal });
        return typeof out === "string" ? out.slice(0, 100_000) : JSON.stringify(out ?? "(no output)").slice(0, 100_000);
      },
    });
  }

  private names = new Map<string, string>();
  private manifestName(id: string): string {
    return this.names.get(id) ?? id;
  }

  private async refreshNames(): Promise<void> {
    for (const [id, m] of Object.entries(this.meta)) {
      const manifest = await readManifest(m.dir).catch(() => null);
      if (manifest) this.names.set(id, manifest.name);
    }
  }

  private async save(): Promise<void> {
    await this.refreshNames();
    await fs.mkdir(path.dirname(this.deps.metaFile), { recursive: true });
    await fs.writeFile(this.deps.metaFile, JSON.stringify(this.meta, null, 2), "utf8");
  }
}

// ---- helpers ------------------------------------------------------------------

async function readManifest(dir: string): Promise<ModManifest> {
  const errors: string[] = [];
  const m = validate(JSON.parse(await fs.readFile(path.join(dir, MOD_FILE), "utf8")), errors);
  if (errors.length) throw new Error(errors.join("；"));
  return m;
}

function validate(raw: unknown, errors: string[]): ModManifest {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const id = str("id");
  if (!ID.test(id)) errors.push("id 只能用小写字母、数字和 -（2-41 个字符）");
  if (!str("name")) errors.push("缺少 name");
  if (!/^\d+\.\d+\.\d+/.test(str("version"))) errors.push("version 要像 1.0.0 这样");
  const perms = Array.isArray(o.permissions) ? (o.permissions as unknown[]) : [];
  const bad = perms.filter((p) => !PERMISSIONS.includes(p as ModPermission));
  if (bad.length) errors.push(`不认识的权限：${bad.join("、")}`);
  const main = str("main") || undefined;
  if (main && (path.isAbsolute(main) || main.split(/[\\/]/).includes(".."))) errors.push("main 必须是 mod 文件夹里的文件");
  return {
    id,
    name: str("name") || id,
    version: str("version"),
    description: str("description"),
    author: str("author") || undefined,
    homepage: str("homepage") || undefined,
    main,
    permissions: perms.filter((p): p is ModPermission => PERMISSIONS.includes(p as ModPermission)),
    minAppVersion: str("minAppVersion") || undefined,
  };
}

async function readFolder(dir: string, base = "", out: Files = new Map(), size = { n: 0 }): Promise<Files> {
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".DS_Store") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) await readFolder(dir, rel, out, size);
    else if (e.isFile()) {
      const data = await fs.readFile(path.join(dir, rel));
      size.n += data.length;
      out.set(rel, new Uint8Array(data));
    }
    if (out.size > MAX_FILES) throw new Error(`文件太多了（超过 ${MAX_FILES} 个）`);
    if (size.n > MAX_BYTES) throw new Error("文件太大了（超过 50MB）");
  }
  return out;
}

/** Zips usually wrap everything in one folder: drop it. Rejects paths that climb out. */
function stripTopFolder(entries: Record<string, Uint8Array>): Files {
  const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/") && !n.endsWith(".DS_Store"));
  if (names.length > MAX_FILES) throw new Error(`文件太多了（超过 ${MAX_FILES} 个）`);
  const top = names[0]?.split("/")[0];
  const strip = !!top && names.every((n) => n.startsWith(`${top}/`)) && !names.includes(MOD_FILE);
  const out: Files = new Map();
  for (const n of names) {
    const rel = strip ? n.slice(top.length + 1) : n;
    if (rel.split("/").includes("..") || path.isAbsolute(rel)) throw new Error(`压缩包里有不安全的路径：${n}`);
    out.set(rel, entries[n]);
  }
  return out;
}

function hashFiles(files: Files): string {
  const h = createHash("sha256");
  for (const rel of [...files.keys()].sort()) {
    h.update(rel).update("\0").update(files.get(rel)!).update("\0");
  }
  return h.digest("hex");
}

/** a > b, comparing x.y.z numerically. */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
