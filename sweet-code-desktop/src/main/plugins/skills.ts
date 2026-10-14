import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import YAML from "yaml";
import type { SkillAudit, SkillCandidate, SkillFormat, SkillInfo, SkillPreview, SkillSource } from "@shared/types";
import { auditSkill, levelOf } from "./skill-audit";
import { aiReview, type Complete } from "./skill-review";
import { SLUG, skillHubDownloadUrl, skillHubLabel } from "./skillhub";

// Skills are installed under <userData>/skills/<name>/ in the standard Agent Skills layout:
// a SKILL.md with `name` and `description` frontmatter, plus any reference files or scripts.
// Anything else (a Markdown file, Cursor rules, a Claude Code command…) is converted into
// that layout on install, so the agent only ever deals with one format.

const MAX_ZIP_BYTES = 40 * 1024 * 1024;
/** Above this (GitHub's repo size, in KB) picked skills are fetched one by one instead of as a zip. */
const BIG_REPO_KB = 30_000;
/** File count limit when a big repo's skills are fetched one by one. */
const MAX_TREE_FILES = 600;

class NoMatch extends Error {
  constructor() {
    super("这个仓库里没找到要装的技能");
  }
}

class RateLimited extends Error {
  constructor() {
    super("GitHub 暂时限制了请求次数，过一小时再试");
  }
}

class TooBig extends Error {
  constructor() {
    super("文件太大了（超过 40MB）");
  }
}
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_CANDIDATES = 60;
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/i;
const META = ".sweet.json";
/** Content hashes of the built-in skills as last installed, so updates never clobber a user's edits. */
const BUILTIN_RECORD = ".builtin.json";
export const BUILTIN_SOURCE = "sikeoop 内置";
/** Builtin skills installed before the rename to sikeoop carry the old source name. */
const LEGACY_BUILTIN_SOURCE = "甜心代码屋内置";
const isBuiltin = (source: string) => source === BUILTIN_SOURCE || source === LEGACY_BUILTIN_SOURCE;

/**
 * 强制预设 · hack 专用模块。名单里的技能：
 * - 随 App 内置（hack-preset 总入口）或开机从 opencode 技能目录自动导入（zhenxin-* 链）；
 * - 永远启用：不能关闭、不能删除，syncBuiltin 总是重装并启用；
 * - 在对话开头的 skills 列表里单独置顶。
 */
export const FORCED_SOURCE = "强制预设 · hack专用";
export const FORCED_SKILL_NAMES = [
  "hack-preset",
  "zhenxin-recon",
  "zhenxin-web-attack",
  "zhenxin-exploit-dev",
  "zhenxin-windows-ad",
  "zhenxin-linux-privesc",
  "zhenxin-mobile-attack",
  "zhenxin-reverse",
  "zhenxin-evasion",
  "zhenxin-phishing",
  "zhenxin-mitm",
  "zhenxin-brute-crack",
  "zhenxin-cloud-attack",
  "zhenxin-exfiltration",
  "zhenxin-framework",
  "zhenxin-lab-env",
  "zhenxin-methodology",
  "zhenxin-vuln-db",
];
export const isForcedSkill = (name: string) => FORCED_SKILL_NAMES.includes(name);

type Files = Map<string, Uint8Array>;

interface Meta {
  format: SkillFormat;
  origin: string;
  source: string;
  enabled: boolean;
  installedAt: number;
  /** 强制预设标记：为 true 时拒绝关闭与删除。 */
  forced?: boolean;
}

interface Prepared extends Omit<SkillCandidate, "audit"> {
  /** Files to write, relative to the skill folder. */
  content: Files;
  /** Set by preview(): the rule scan, later the AI review too. */
  audit?: SkillAudit;
}

/** Install refused because a picked skill failed the security review and the user didn't accept the risk. */
export class RiskNotAccepted extends Error {}

export type Fetcher = (url: string) => Promise<Response>;

export interface BuiltinSkill {
  name: string;
  /** Files relative to the skill folder, SKILL.md included. */
  files: Files;
}

export class SkillStore {
  private previews = new Map<string, { source: string; candidates: Prepared[] }>();

  constructor(
    private readonly root: string,
    private readonly fetcher: Fetcher,
  ) {}

  // ---- reading installed skills ------------------------------------------

  async list(): Promise<SkillInfo[]> {
    await fs.mkdir(this.root, { recursive: true });
    const out: SkillInfo[] = [];
    for (const name of (await fs.readdir(this.root)).sort()) {
      const dir = path.join(this.root, name);
      try {
        const md = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
        const { data } = splitFrontmatter(md);
        const meta = await this.meta(name);
        const files = await walk(dir);
        const forced = meta.forced === true || isForcedSkill(name);
        out.push({
          name,
          description: String(data.description ?? ""),
          format: meta.format,
          origin: meta.origin,
          source: meta.source,
          enabled: forced ? true : meta.enabled,
          builtin: isBuiltin(meta.source),
          forced,
          files: files.filter((f) => f !== META).length,
          hasScripts: files.some(isScript),
        });
      } catch {
        // Not a skill folder (or a broken one); leave it out.
      }
    }
    return out;
  }

  /** Enabled skills for the agent: what to list in the conversation and where each one lives. */
  async enabled(): Promise<{ name: string; description: string; dir: string; forced: boolean }[]> {
    return (await this.list()).filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, dir: path.join(this.root, s.name), forced: s.forced }));
  }

  dirOf(name: string): string {
    // Installed folders may have Unicode names; only accept a single, non-hidden component.
    if (typeof name !== "string" || !name || name.startsWith(".") || /[/\\\p{Cc}]/u.test(name))
      throw new Error(`Unknown skill: ${name}`);
    const root = path.resolve(this.root);
    const dir = path.resolve(path.join(root, name));
    const relative = path.relative(root, dir);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Unknown skill: ${name}`);
    return dir;
  }

  private async meta(name: string): Promise<Meta> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, name, META), "utf8")) as Meta;
    } catch {
      // Skills copied in by hand were never reviewed: standard, and off until the user turns them on.
      // (Built-in and installed skills always have a meta file, so this is never one of them.)
      return { format: "standard", origin: "标准 Skill", source: "本地", enabled: false, installedAt: 0 };
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!enabled && (isForcedSkill(name) || (await this.meta(name)).forced === true)) {
      throw new Error(`「${name}」是强制预设 · hack专用模块，不能关闭`);
    }
    const meta = { ...(await this.meta(name)), enabled };
    await fs.writeFile(path.join(this.dirOf(name), META), JSON.stringify(meta, null, 2));
  }

  async remove(name: string): Promise<void> {
    if (isForcedSkill(name) || (await this.meta(name)).forced === true) {
      throw new Error(`「${name}」是强制预设 · hack专用模块，不能删除`);
    }
    await fs.rm(this.dirOf(name), { recursive: true, force: true });
  }

  /**
   * 把外部目录（如 ~/.config/opencode/skills/zhenxin-*）原样导入为强制预设技能。
   * 只读外部目录、不写外部；安装时跳过安全审核（用户已明确把该系列设为强制预设）。
   * 已存在的同名强制技能会被覆盖为外部最新内容；用户自改的同名非强制技能不会被碰。
   */
  async importForced(externalDir: string, name: string): Promise<boolean> {
    const mdPath = path.join(externalDir, "SKILL.md");
    let md: string;
    try {
      md = await fs.readFile(mdPath, "utf8");
    } catch {
      return false;
    }
    const { data } = splitFrontmatter(md);
    if (typeof data.name === "string" && data.name !== name) return false;
    const dir = this.dirOf(name);
    const exists = await fs.stat(path.join(dir, "SKILL.md")).then(() => true, () => false);
    if (exists) {
      const meta = await this.meta(name);
      if (!isForcedSkill(name) && meta.forced !== true && !isBuiltin(meta.source)) return false;
    }
    const files = await walk(externalDir);
    await fs.rm(dir, { recursive: true, force: true });
    for (const rel of files) {
      if (/(^|\/)(\.git|node_modules)\//.test(rel)) continue;
      const abs = path.join(externalDir, rel);
      if ((await fs.stat(abs)).size > MAX_FILE_BYTES) continue;
      const target = path.join(dir, rel);
      if (!target.startsWith(dir + path.sep)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await fs.readFile(abs));
    }
    const meta: Meta = { format: "standard", origin: "标准 Skill", source: FORCED_SOURCE, enabled: true, installedAt: Date.now(), forced: true };
    await fs.writeFile(path.join(dir, META), JSON.stringify(meta, null, 2));
    return true;
  }

  // ---- built-in skills -------------------------------------------------------

  /**
   * Install the built-in skills that ship with the app. A built-in the user deleted stays
   * deleted (unless `restore`), and one the user edited isn't overwritten by a newer version.
   * A user skill that happens to share a built-in's name is never touched.
   */
  async syncBuiltin(pack: BuiltinSkill[], restore = false): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const recordPath = path.join(this.root, BUILTIN_RECORD);
    let record: Record<string, string> = {};
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    } catch {
      // First run.
    }
    for (const skill of pack) {
      const dir = this.dirOf(skill.name);
      const hash = hashFiles(skill.files);
      const exists = await fs.stat(path.join(dir, "SKILL.md")).then(() => true, () => false);
      const forced = isForcedSkill(skill.name);
      let enabled = true;
      if (!exists) {
        // 强制预设被删掉也会重装；普通内置技能默认不打扰用户。
        if (record[skill.name] && !restore && !forced) continue;
      } else {
        const meta = await this.meta(skill.name);
        if (!isBuiltin(meta.source) || record[skill.name] === hash) continue;
        const current = new Map<string, Uint8Array>();
        for (const rel of await walk(dir)) if (rel !== META) current.set(rel, await fs.readFile(path.join(dir, rel)));
        if (hashFiles(current) !== record[skill.name]) continue; // the user edited it
        enabled = forced ? true : meta.enabled;
      }
      await fs.rm(dir, { recursive: true, force: true });
      for (const [rel, bytes] of skill.files) {
        const target = path.join(dir, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
      const meta: Meta = { format: "standard", origin: "内置技能", source: forced ? FORCED_SOURCE : BUILTIN_SOURCE, enabled, installedAt: Date.now(), ...(forced ? { forced: true as const } : {}) };
      await fs.writeFile(path.join(dir, META), JSON.stringify(meta, null, 2));
      record[skill.name] = hash;
    }
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2));
  }

  // ---- preview + install ---------------------------------------------------

  async preview(source: SkillSource): Promise<SkillPreview> {
    const { label, files, single, subdir } = await this.load(source);
    const installed = new Set((await this.list()).map((s) => s.name));
    const candidates = discover(files, single, subdir, source.kind === "text" ? source.name : undefined);
    if (!candidates.length) {
      throw new Error("这里面没有找到技能：既没有 SKILL.md，也没有能转换的 Markdown / 规则文件。");
    }
    // Two candidates can't share a folder name.
    const used = new Set<string>();
    for (const c of candidates) {
      let name = c.name;
      for (let i = 2; used.has(name); i++) name = `${c.name}-${i}`;
      if (name !== c.name) {
        c.name = name;
        if (c.format === "converted") c.content.set("SKILL.md", encode(withName(decode(c.content.get("SKILL.md")!), name)));
      }
      used.add(name);
      c.exists = installed.has(name);
      c.audit = auditSkill(c.content);
    }
    const previewId = randomUUID();
    this.previews.set(previewId, { source: label, candidates });
    return this.previewView(previewId);
  }

  /** The preview as the renderer sees it (no file contents). */
  previewView(previewId: string): SkillPreview {
    const p = this.previews.get(previewId);
    if (!p) throw new Error("预览已经过期了，请重新预览一次。");
    return {
      previewId,
      source: p.source,
      candidates: p.candidates.map(({ content: _content, audit, ...c }) => ({ ...c, audit: audit ?? auditSkill(_content) })),
    };
  }

  /** Have a model read each previewed skill (all of them, or just `ids`) for malicious instructions. */
  async aiReview(previewId: string, complete: Complete, signal: AbortSignal, ids?: string[]): Promise<SkillPreview> {
    const p = this.previews.get(previewId);
    if (!p) throw new Error("预览已经过期了，请重新预览一次。");
    await Promise.all(
      p.candidates
        .filter((c) => !ids || ids.includes(c.id))
        .map(async (c) => {
          const audit = c.audit ?? auditSkill(c.content);
          try {
            const ai = await aiReview(complete, { name: c.name, description: c.description, files: c.content, findings: audit.findings }, signal);
            c.audit = { ...audit, ai, level: levelOf(audit.findings, ai.verdict) };
          } catch (e) {
            if (signal.aborted) throw e;
            c.audit = { ...audit, ai: { error: (e as Error).message.slice(0, 200) } };
          }
        }),
    );
    return this.previewView(previewId);
  }

  /**
   * Install the picked candidates. Any whose review came out "danger" needs acceptRisk: the user
   * saw the findings and chose to install anyway. Enforced here, so no caller can skip it.
   */
  async install(previewId: string, ids: string[], acceptRisk = false): Promise<void> {
    const p = this.previews.get(previewId);
    if (!p) throw new Error("预览已经过期了，请重新预览一次。");
    const picked = p.candidates.filter((x) => ids.includes(x.id));
    const risky = picked.filter((c) => (c.audit ?? auditSkill(c.content)).level === "danger");
    if (risky.length && !acceptRisk) {
      throw new RiskNotAccepted(`安全审核发现 ${risky.map((c) => c.name).join("、")} 有高风险内容。确认了解风险后才能安装。`);
    }
    for (const c of picked) {
      const dir = path.join(this.root, c.name);
      await fs.rm(dir, { recursive: true, force: true });
      for (const [rel, bytes] of c.content) {
        const target = path.join(dir, rel);
        if (!target.startsWith(dir + path.sep)) continue; // never write outside the skill folder
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
      const meta: Meta = { format: c.format, origin: c.origin, source: p.source, enabled: true, installedAt: Date.now() };
      await fs.writeFile(path.join(dir, META), JSON.stringify(meta, null, 2));
    }
    this.previews.delete(previewId);
  }

  // ---- loading sources -------------------------------------------------------

  private async load(source: SkillSource): Promise<{ label: string; files: Files; single: boolean; subdir: string }> {
    if (source.kind === "text") {
      if (!source.text.trim()) throw new Error("粘贴的内容是空的");
      return { label: "粘贴的文本", files: new Map([["pasted.md", encode(source.text)]]), single: true, subdir: "" };
    }
    if (source.kind === "local") return { label: source.path, ...(await loadLocal(source.path)) };
    if (source.kind === "skillhub") {
      const slug = source.slug.trim();
      if (!SLUG.test(slug)) throw new Error(`SkillHub 技能名不对：${slug}`);
      const bytes = await this.download(skillHubDownloadUrl(slug)).catch((e: Error) => {
        throw /404/.test(e.message) ? new Error(`SkillHub 上没有「${slug}」这个技能`) : e;
      });
      if (!isZip(bytes)) throw new Error("SkillHub 返回的不是压缩包");
      const files = unzip(bytes, false);
      files.delete("_meta.json"); // the store's bookkeeping, not part of the skill
      return { label: skillHubLabel(slug), files, single: false, subdir: "" };
    }

    const url = source.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("链接要以 http:// 或 https:// 开头");
    const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[#?].*)?$/i);
    if (gh) {
      const [, owner, repo, kind, ref = "HEAD", sub = ""] = gh;
      if (kind === "blob") {
        const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${sub}`;
        const bytes = await this.download(raw);
        return { label: url, files: new Map([[path.posix.basename(sub), bytes]]), single: true, subdir: "" };
      }
      const subdir = sub.replace(/\/$/, "");
      // A huge repo with only some skills wanted: fetch just those folders instead of the whole zip.
      if (source.only?.length && (await this.repoSizeKb(owner, repo)) > BIG_REPO_KB) {
        try {
          return { label: url, files: await this.loadGithubSkillsOnly(owner, repo, ref, subdir, source.only), single: false, subdir };
        } catch (err) {
          if (!(err instanceof RateLimited) && !(err instanceof NoMatch)) throw err;
          // API limit hit, or none of the names exist: the whole repo shows what's really there.
        }
      }
      try {
        const zip = await this.download(`https://github.com/${owner}/${repo}/archive/${ref}.zip`);
        return { label: url, files: unzip(zip, true), single: false, subdir };
      } catch (err) {
        // Big repos (videos, demos…): fetch only the folders that hold skills, file by file.
        if (!(err instanceof TooBig)) throw err;
        return { label: url, files: await this.loadGithubSkillsOnly(owner, repo, ref, subdir, source.only), single: false, subdir };
      }
    }
    const bytes = await this.download(url);
    if (isZip(bytes)) return { label: url, files: unzip(bytes, false), single: false, subdir: "" };
    const name = path.posix.basename(new URL(url).pathname) || "skill.md";
    return { label: url, files: new Map([[name, bytes]]), single: true, subdir: "" };
  }

  /** The repo's size from the GitHub API (0 when unknown, which means "try the zip"). */
  private async repoSizeKb(owner: string, repo: string): Promise<number> {
    try {
      const res = await this.fetcher(`https://api.github.com/repos/${owner}/${repo}`);
      return res.ok ? (((await res.json()) as { size?: number }).size ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * For repos too big to download whole: list the tree with the GitHub API and fetch just the
   * files inside folders that contain a SKILL.md (under `subdir` when given).
   */
  private async loadGithubSkillsOnly(owner: string, repo: string, ref: string, subdir: string, only?: string[]): Promise<Files> {
    let res: Response;
    try {
      res = await this.fetcher(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    } catch (err) {
      throw new Error(`下载失败，检查一下网络或代理：${(err as Error).message}`);
    }
    if (res.status === 403 || res.status === 429) throw new RateLimited();
    if (!res.ok) throw new Error(`读取仓库目录失败（${res.status}）`);
    const tree = (await res.json()) as { tree?: { path: string; type: string; size?: number }[] };
    const blobs = (tree.tree ?? []).filter((t) => t.type === "blob" && (!subdir || t.path === subdir || t.path.startsWith(subdir + "/")));
    const wantedNames = only?.length ? new Set(only.map((n) => n.toLowerCase())) : null;
    const skillDirs = blobs
      .filter((b) => path.posix.basename(b.path).toLowerCase() === "skill.md")
      .map((b) => path.posix.dirname(b.path))
      .filter((d) => !wantedNames || wantedNames.has(path.posix.basename(d).toLowerCase()));
    if (!skillDirs.length) throw wantedNames ? new NoMatch() : new Error("这个仓库太大，而且里面没找到 SKILL.md");
    const wanted = blobs.filter((b) => skillDirs.some((d) => d === "." || b.path.startsWith(d + "/")));
    const total = wanted.reduce((n, b) => n + (b.size ?? 0), 0);
    if (wanted.length > MAX_TREE_FILES || total > MAX_ZIP_BYTES) {
      throw new Error(wantedNames ? "要装的技能文件太多太大" : "仓库太大，一次装不下全部技能：说清楚要装哪几个再试");
    }
    const files: Files = new Map();
    // A few at a time: fast enough, and polite to GitHub.
    for (let i = 0; i < wanted.length; i += 16) {
      await Promise.all(
        wanted.slice(i, i + 16).map(async (b) => {
          const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${b.path.split("/").map(encodeURIComponent).join("/")}`;
          files.set(b.path, await this.download(raw));
        }),
      );
    }
    return files;
  }

  private async download(url: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetcher(url);
    } catch (err) {
      throw new Error(`下载失败，检查一下网络或代理：${(err as Error).message}`);
    }
    if (res.status === 404) throw new Error("链接打不开（404）：地址不对，或者是私有仓库。");
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_ZIP_BYTES) throw new TooBig();
    // Read as a stream and give up as soon as it's too big (GitHub zips have no length header).
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array(await res.arrayBuffer());
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ZIP_BYTES) {
        void reader.cancel();
        throw new TooBig();
      }
      parts.push(value);
    }
    const buf = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.length;
    }
    return buf;
  }
}

// ---- discovery ---------------------------------------------------------------

function discover(all: Files, single: boolean, subdir: string, pastedName?: string): Prepared[] {
  let files = all;
  if (subdir) {
    const prefix = subdir + "/";
    files = new Map([...all].filter(([p]) => p === subdir || p.startsWith(prefix)).map(([p, b]) => [p === subdir ? path.posix.basename(p) : p.slice(prefix.length), b]));
  }

  // Standard skills: every folder with a SKILL.md, without the files of skills nested inside it.
  const skillDirs = [...files.keys()]
    .filter((p) => path.posix.basename(p).toLowerCase() === "skill.md")
    .map((p) => path.posix.dirname(p))
    .map((d) => (d === "." ? "" : d));
  if (skillDirs.length) {
    return skillDirs.slice(0, MAX_CANDIDATES).map((dir) => {
      const inner = skillDirs.filter((d) => d !== dir && (dir === "" || d.startsWith(dir + "/")));
      const content: Files = new Map();
      let total = 0;
      for (const [p, b] of files) {
        if (dir && !p.startsWith(dir + "/")) continue;
        const rel = dir ? p.slice(dir.length + 1) : p;
        if (inner.some((d) => p.startsWith(d + "/"))) continue;
        total += b.length;
        content.set(rel.toLowerCase() === "skill.md" ? "SKILL.md" : rel, b);
      }
      const md = decode(content.get("SKILL.md")!);
      const { data } = splitFrontmatter(md);
      const warnings: string[] = [];
      let name = typeof data.name === "string" ? data.name : "";
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        const fixed = slug(name || path.posix.basename(dir) || "skill");
        warnings.push(name ? `名字「${name}」不符合规范，安装为「${fixed}」` : `没有写名字，用文件夹名「${fixed}」`);
        name = fixed;
      }
      const description = typeof data.description === "string" ? data.description.trim() : "";
      if (!description) warnings.push("没有写 description，AI 可能不知道什么时候该用它");
      if (total > MAX_SKILL_BYTES) warnings.push("这个技能文件很多，安装后会占用较多空间");
      return {
        id: randomUUID(),
        name,
        description: description.slice(0, 1024),
        format: "standard",
        origin: "标准 Skill",
        files: [...content.keys()].sort(),
        hasScripts: [...content.keys()].some(isScript),
        exists: false,
        warnings,
        content,
      };
    });
  }

  // Non-standard: rule and prompt files from other tools, or a single document.
  const picks = [...files.keys()].filter((p) => single || originOf(p) !== null).slice(0, MAX_CANDIDATES);
  return picks.map((p) => convert(p, decode(files.get(p)!), single && pastedName ? pastedName : undefined));
}

/** What kind of non-standard file this is, or null if it isn't one worth offering. */
function originOf(p: string): string | null {
  const base = path.posix.basename(p).toLowerCase();
  if (base.endsWith(".mdc") || base === ".cursorrules") return "Cursor 规则";
  if (/(^|\/)\.claude\/commands\/.+\.md$/i.test(p)) return "Claude Code 命令";
  if (/(^|\/)\.claude\/agents\/.+\.md$/i.test(p)) return "Claude Code 子代理";
  if (base.endsWith(".prompt.md") || base.endsWith(".instructions.md")) return "Copilot 提示词";
  if (base === ".windsurfrules" || /(^|\/)\.windsurf\/rules\//.test(p)) return "Windsurf 规则";
  if (["agents.md", "claude.md", "gemini.md"].includes(base)) return "项目说明";
  return null;
}

function convert(p: string, text: string, preferredName?: string): Prepared {
  const origin = p === "pasted.md" ? "粘贴的文本" : (originOf(p) ?? "Markdown 文档");
  const { data, body } = splitFrontmatter(text);
  const heading = body.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const base = path.posix.basename(p).replace(/\.(prompt|instructions)?\.?(md|mdc|txt|markdown)$/i, "").replace(/^\./, "");
  const name = slug(preferredName || (typeof data.name === "string" && data.name) || heading || base || "skill");
  const firstPara = body
    .split(/\n\s*\n/)
    .map((x) => x.replace(/^#+\s.*$/gm, "").replace(/[*_`>#-]/g, "").trim())
    .find((x) => x.length > 10);
  let description =
    (typeof data.description === "string" && data.description.trim()) || firstPara?.slice(0, 200) || `从${origin}转换的技能`;
  // Cursor rules apply to file patterns; keep that as a hint for when to use the skill.
  const globs = Array.isArray(data.globs) ? data.globs.join(", ") : typeof data.globs === "string" ? data.globs : "";
  if (globs) description += `（适用于 ${globs}）`;
  const header = YAML.stringify({ name, description: description.slice(0, 1024) }).trim();
  const md = `---\n${header}\n---\n\n<!-- 由 sikeoop 从${origin}（${path.posix.basename(p)}）转换 -->\n\n${body.trim()}\n`;
  return {
    id: randomUUID(),
    name,
    description: description.slice(0, 1024),
    format: "converted",
    origin,
    files: ["SKILL.md"],
    hasScripts: false,
    exists: false,
    warnings: [],
    content: new Map([["SKILL.md", encode(md)]]),
  };
}

// ---- helpers -------------------------------------------------------------------

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  try {
    const data = YAML.parse(m[1]);
    return { data: data && typeof data === "object" ? data : {}, body: m[2] };
  } catch {
    return { data: {}, body: m[2] };
  }
}

function withName(md: string, name: string): string {
  const { data, body } = splitFrontmatter(md);
  return `---\n${YAML.stringify({ ...data, name }).trim()}\n---\n${body}`;
}

/** Skill names are lowercase letters, digits and hyphens. Chinese titles fall back to a short hash. */
function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return out || `skill-${createHash("sha1").update(s).digest("hex").slice(0, 6)}`;
}

function hashFiles(files: Files): string {
  const h = createHash("sha1");
  for (const [rel, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(rel).update("\0").update(bytes).update("\0");
  return h.digest("hex");
}

const isScript = (p: string) => SCRIPT_EXT.test(p) || /(^|\/)scripts\//.test(p);
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

/** Unzip in memory, skipping junk and anything that tries to escape its folder. */
function unzip(bytes: Uint8Array, stripTop: boolean): Files {
  let count = 0;
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => !f.name.endsWith("/") && f.originalSize <= MAX_FILE_BYTES && ++count <= MAX_FILES,
  });
  const out: Files = new Map();
  for (const [raw, data] of Object.entries(entries)) {
    total += data.length;
    if (total > MAX_ZIP_BYTES * 2) throw new Error("压缩包解开后太大了");
    let p = raw.replace(/\\/g, "/");
    // GitHub archives wrap everything in a "repo-branch/" folder.
    if (stripTop) p = p.split("/").slice(1).join("/");
    if (!p || p.split("/").some((seg) => seg === ".." || seg === "") || p.startsWith("/")) continue;
    if (/(^|\/)(\.git|node_modules|__MACOSX)\//.test(p) || p.endsWith(".DS_Store")) continue;
    out.set(p, data);
  }
  return out;
}

async function loadLocal(p: string): Promise<{ files: Files; single: boolean; subdir: string }> {
  const st = await fs.stat(p);
  if (st.isDirectory()) {
    const files: Files = new Map();
    for (const rel of (await walk(p)).slice(0, MAX_FILES)) {
      if (/(^|\/)(\.git|node_modules)\//.test(rel)) continue;
      const abs = path.join(p, rel);
      if ((await fs.stat(abs)).size <= MAX_FILE_BYTES) files.set(rel, await fs.readFile(abs));
    }
    return { files, single: false, subdir: "" };
  }
  const bytes = await fs.readFile(p);
  if (isZip(bytes)) return { files: unzip(bytes, false), single: false, subdir: "" };
  return { files: new Map([[path.basename(p), bytes]]), single: true, subdir: "" };
}

/** Relative paths (with "/") of every file under dir. */
async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      out.push(...(await walk(dir, rel)));
    } else if (e.isFile()) out.push(rel);
    if (out.length > MAX_FILES) break;
  }
  return out;
}
