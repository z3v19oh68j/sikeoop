import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagedQuarto, PaperToolId, PaperToolsState, ToolEvent, ToolOffer, ToolTask } from "@shared/types";
import { extractTarGz, extractZip } from "./archive.ts";
import { Cancelled, type HttpRequest, downloadTo, getJson, getText, headOf, sha256File } from "./net-download.ts";
import { type RunProcess, parseQuartoVersion, plain } from "./quarto.ts";
import {
  BBT_RELEASE,
  GITHUB_API_HOSTS,
  GITHUB_DOWNLOAD_HOSTS,
  QUARTO_RELEASE,
  ZOTERO_HOSTS,
  archiveKind,
  bbtAsset,
  checksumsAsset,
  compareVersions,
  compatibilityNote,
  expectedSha256,
  isVersion,
  opensAsInstaller,
  parseChecksums,
  parseRelease,
  parseZoteroInstaller,
  pickAsset,
  quartoAssetName,
  quartoBinIn,
  zoteroCandidates,
  zoteroDownloadPage,
} from "./tools-release.ts";

// Quarto, Zotero and Better BibTeX fetched when the user asks (docs/方案-论文工坊.md §9). None of
// them ships with sikeoop. Quarto is unpacked into userData/tools/quarto/<version>/ and used from
// there; Zotero's installer and the plugin file are only downloaded, the user installs them.
// Every download is told to the user first (toolOffer) and starts on their click (toolDownload).

export interface ToolsDeps {
  userData(): string;
  /** Where the Zotero installer and the plugin file are saved (the user's Downloads folder). */
  downloads(): string;
  platform: NodeJS.Platform;
  arch: string;
  env(): Record<string, string | undefined>;
  home: string;
  request: HttpRequest;
  /** Runs the unpacked Quarto once (`--version`) to see that it works. */
  run: RunProcess;
  exists(absolute: string): Promise<boolean>;
  /** Hands a file to the system to open. */
  open(absolute: string): Promise<void>;
  /** Shows a file or folder in the system's file manager. */
  reveal(absolute: string): void;
  emit(event: ToolEvent): void;
}

/** What a download is going to do, worked out when the offer was made. */
interface Plan {
  offer: ToolOffer;
  url: string;
  hosts: readonly string[];
  sha256?: string;
}

interface Going {
  task: ToolTask;
  abort: AbortController;
  /** Files to remove if the user stops it. */
  scratch: string[];
}

const TOOLS = new Set<PaperToolId>(["quarto", "zotero", "bbt"]);
const LIVE = new Set<ToolTask["phase"]>(["downloading", "verifying", "extracting"]);
const PROGRESS_EVERY = 200;

const sizeOf = (file: string): Promise<number> => fs.stat(file).then((s) => (s.isFile() ? s.size : -1), () => -1);

export class ToolsService {
  private readonly deps: ToolsDeps;
  private readonly plans = new Map<PaperToolId, Plan>();
  private readonly going = new Map<PaperToolId, Going>();

  constructor(deps: ToolsDeps) {
    this.deps = deps;
  }

  private quartoDir(): string {
    return path.join(this.deps.userData(), "tools", "quarto");
  }

  private tool(input: unknown): PaperToolId {
    if (typeof input !== "string" || !TOOLS.has(input as PaperToolId)) throw new Error("不认识这个工具");
    return input as PaperToolId;
  }

  // ---- what is here ----

  /** The copies of Quarto in sikeoop's data folder, newest first. Only folders this service made count. */
  async managedQuarto(): Promise<ManagedQuarto[]> {
    const root = this.quartoDir();
    const names = await fs.readdir(root).catch(() => [] as string[]);
    const out: ManagedQuarto[] = [];
    for (const version of names.filter(isVersion)) {
      const dir = path.join(root, version);
      const bin = quartoBinIn(dir, this.deps.platform);
      if (await this.deps.exists(bin)) out.push({ version, dir, bin });
    }
    return out.sort((a, b) => compareVersions(b.version, a.version));
  }

  private async zoteroInstalled(): Promise<boolean> {
    for (const candidate of zoteroCandidates(this.deps.platform, this.deps.env(), this.deps.home)) if (await this.deps.exists(candidate)) return true;
    return false;
  }

  async state(): Promise<PaperToolsState> {
    return {
      quarto: await this.managedQuarto(),
      quartoDir: this.quartoDir(),
      zoteroInstalled: await this.zoteroInstalled(),
      downloads: this.deps.downloads(),
      tasks: [...this.going.values()].map((g) => ({ ...g.task })),
    };
  }

  // ---- what would be downloaded ----

  /** Asks the official source for the latest version, its size and its checksum. Small requests only. */
  async offer(input: unknown): Promise<ToolOffer> {
    const tool = this.tool(input);
    const plan = tool === "quarto" ? await this.quartoPlan() : tool === "bbt" ? await this.bbtPlan() : await this.zoteroPlan();
    this.plans.set(tool, plan);
    return { ...plan.offer };
  }

  private async quartoPlan(): Promise<Plan> {
    const { request } = this.deps;
    const release = parseRelease(await getJson(request, QUARTO_RELEASE, GITHUB_API_HOSTS));
    const asset = pickAsset(release, quartoAssetName(release.version, this.deps.platform, this.deps.arch));
    // Older releases have no digest from GitHub: the release's own checksums file is used then.
    const sums = asset.sha256 ? undefined : checksumsAsset(release);
    const sha256 = expectedSha256(asset, sums ? parseChecksums(await getText(request, sums.url, GITHUB_DOWNLOAD_HOSTS)) : undefined);
    const have = (await this.managedQuarto()).some((m) => m.version === release.version);
    return {
      url: asset.url,
      hosts: GITHUB_DOWNLOAD_HOSTS,
      sha256,
      offer: {
        tool: "quarto",
        version: release.version,
        file: asset.name,
        size: asset.size,
        source: "GitHub 上 quarto-dev/quarto-cli 的 Releases（Quarto 官方发布页）",
        url: asset.url,
        license: "MIT；包里还有 Pandoc（GPL-2.0）、Typst、Deno 等组件，各自的许可见包内说明",
        checksum: true,
        where: `解压到 sikeoop 自己的数据文件夹：${path.join(this.quartoDir(), release.version)}。不需要管理员权限，不改系统的任何设置`,
        ...(have ? { have: true } : {}),
      },
    };
  }

  private async bbtPlan(): Promise<Plan> {
    const release = parseRelease(await getJson(this.deps.request, BBT_RELEASE, GITHUB_API_HOSTS));
    const asset = bbtAsset(release);
    const note = compatibilityNote(release.notes);
    return {
      url: asset.url,
      hosts: GITHUB_DOWNLOAD_HOSTS,
      sha256: expectedSha256(asset),
      offer: {
        tool: "bbt",
        version: release.version,
        file: asset.name,
        size: asset.size,
        source: "GitHub 上 retorquere/zotero-better-bibtex 的 Releases（插件作者的发布页）",
        url: asset.url,
        license: "MIT",
        checksum: true,
        where: `保存到 ${this.deps.downloads()}，由你在 Zotero 里装上`,
        ...(note ? { note } : {}),
      },
    };
  }

  private async zoteroPlan(): Promise<Plan> {
    const page = zoteroDownloadPage(this.deps.platform, this.deps.arch);
    const head = await headOf(this.deps.request, page, ZOTERO_HOSTS);
    const { version, file } = parseZoteroInstaller(head.url);
    // No checksum is published for it, so the size is all there is to check a download against.
    if (!head.size) throw new Error("zotero.org 没有说安装包有多大，没法核对下载是否完整，所以没有下载");
    return {
      url: head.url,
      hosts: ZOTERO_HOSTS,
      offer: {
        tool: "zotero",
        version,
        file,
        size: head.size,
        source: "zotero.org 的官方下载地址",
        url: head.url,
        license: "AGPL-3.0",
        // zotero.org publishes no checksum for its installers.
        checksum: false,
        where: opensAsInstaller(file) ? `保存到 ${this.deps.downloads()}，下完自动打开安装包，安装由你自己完成` : `保存到 ${this.deps.downloads()}，是一个压缩包，要你自己解压后运行里面的 zotero`,
      },
    };
  }

  // ---- downloading ----

  private push(g: Going): void {
    this.deps.emit({ type: "task", task: { ...g.task } });
  }

  /** Starts downloading the version the user was shown. Resolves once it has started. */
  async download(toolInput: unknown, version: unknown): Promise<ToolTask> {
    const tool = this.tool(toolInput);
    if (!isVersion(version)) throw new Error("版本号不对");
    const running = this.going.get(tool);
    if (running && LIVE.has(running.task.phase)) throw new Error("这个已经在下载了，等它结束或先取消");
    let plan = this.plans.get(tool);
    if (!plan || plan.offer.version !== version) {
      await this.offer(tool);
      plan = this.plans.get(tool)!;
    }
    // What gets downloaded is what the user read about, never a version that appeared since.
    if (plan.offer.version !== version) throw new Error(`最新版本已经变成 ${plan.offer.version} 了，请重新查看后再下载`);
    const again = this.going.get(tool);
    if (again && LIVE.has(again.task.phase)) throw new Error("这个已经在下载了，等它结束或先取消");

    const g: Going = { abort: new AbortController(), scratch: [], task: { tool, phase: "downloading", version, file: plan.offer.file, received: 0, total: plan.offer.size } };
    this.going.set(tool, g);
    this.push(g);
    const work = tool === "quarto" ? this.installQuarto(plan, g) : this.fetchFile(plan, g);
    void work.then(
      (done) => {
        Object.assign(g.task, { phase: "done" as const, ...done });
        this.push(g);
      },
      async (err: unknown) => {
        if (g.abort.signal.aborted || err instanceof Cancelled) {
          // Stopped by the user: nothing half-done is left behind.
          for (const file of g.scratch) await fs.rm(file, { recursive: true, force: true }).catch(() => undefined);
          g.task.phase = "cancelled";
        } else {
          g.task.phase = "failed";
          g.task.error = err instanceof Error ? err.message : String(err);
          const kept = await Promise.all(g.scratch.map((f) => sizeOf(f)));
          if (kept.some((n) => n > 0)) g.task.resumable = true;
        }
        this.push(g);
      },
    );
    return { ...g.task };
  }

  cancel(toolInput: unknown): void {
    const g = this.going.get(this.tool(toolInput));
    if (g && LIVE.has(g.task.phase)) g.abort.abort();
  }

  private phase(g: Going, phase: ToolTask["phase"]): void {
    if (g.abort.signal.aborted) throw new Cancelled();
    g.task.phase = phase;
    this.push(g);
  }

  /** Reports progress, but not more often than the window can use; the latest figure always gets through. */
  private progress(g: Going): (received: number, total: number) => void {
    let last = 0;
    let later: ReturnType<typeof setTimeout> | undefined;
    return (received, total) => {
      g.task.received = received;
      if (total) g.task.total = total;
      const now = Date.now();
      if (now - last < PROGRESS_EVERY && received !== total) {
        later ??= setTimeout(() => {
          later = undefined;
          last = Date.now();
          if (g.task.phase === "downloading") this.push(g);
        }, PROGRESS_EVERY);
        return;
      }
      clearTimeout(later);
      later = undefined;
      last = now;
      this.push(g);
    };
  }

  private async checked(plan: Plan, g: Going, file: string): Promise<void> {
    if (!plan.sha256) return;
    this.phase(g, "verifying");
    const actual = await sha256File(file, g.abort.signal);
    if (actual !== plan.sha256) {
      await fs.rm(file, { force: true });
      throw new Error(`校验不通过：下载到的 ${plan.offer.file} 和官方公布的 SHA-256 不一样，已删除。可能是下载出了错，也可能文件被改过；再试一次，还不行就先不要装`);
    }
  }

  /** Quarto: download, check, unpack beside the other versions, try it, then put it in place. */
  private async installQuarto(plan: Plan, g: Going): Promise<Partial<ToolTask>> {
    const { version, file } = plan.offer;
    const root = this.quartoDir();
    const final = path.join(root, version);
    if (await this.deps.exists(quartoBinIn(final, this.deps.platform))) return { path: final };

    const part = path.join(root, ".downloads", `${file}.part`);
    await fs.mkdir(path.dirname(part), { recursive: true });
    g.scratch.push(part);
    await downloadTo({ request: this.deps.request, url: plan.url, hosts: plan.hosts, part, total: plan.offer.size, signal: g.abort.signal, progress: this.progress(g) });
    await this.checked(plan, g, part);

    this.phase(g, "extracting");
    // What an unpacking that never finished (sikeoop was closed) left behind goes first.
    for (const name of await fs.readdir(root)) if (name.startsWith(".staging-")) await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    const staging = path.join(root, `.staging-${version}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(staging);
    try {
      const windows = this.deps.platform === "win32";
      await (archiveKind(file) === "zip" ? extractZip(part, staging, { signal: g.abort.signal, windows }) : extractTarGz(part, staging, { signal: g.abort.signal, windows }));
      // Some packages have everything inside one "quarto-<version>" folder.
      let unpacked = staging;
      if (!(await this.deps.exists(quartoBinIn(unpacked, this.deps.platform)))) {
        const inside = (await fs.readdir(staging, { withFileTypes: true })).filter((e) => e.isDirectory());
        if (inside.length === 1) unpacked = path.join(staging, inside[0].name);
      }
      const bin = quartoBinIn(unpacked, this.deps.platform);
      if (!(await this.deps.exists(bin))) throw new Error("解压出来的东西里没有找到 Quarto 的程序，没有安装");
      let out = "";
      const code = await this.deps.run(bin, ["--version"], unpacked, (t) => (out += t), AbortSignal.any([g.abort.signal, AbortSignal.timeout(60_000)])).catch(() => -1);
      if (g.abort.signal.aborted) throw new Cancelled();
      if (code !== 0 || !parseQuartoVersion(plain(out))) throw new Error(`下载的 Quarto 在这台电脑上运行不起来，没有安装${plain(out).trim() ? `（${plain(out).trim().slice(0, 200)}）` : ""}`);
      await fs.rm(final, { recursive: true, force: true });
      await fs.rename(unpacked, final);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(part, { force: true });
    // An update replaces what was there before; a copy that can't be removed now stays listed.
    for (const old of await this.managedQuarto()) if (old.version !== version) await fs.rm(old.dir, { recursive: true, force: true }).catch(() => undefined);
    return { path: final };
  }

  /** Zotero's installer or the plugin file: download into the Downloads folder, check, and (installer) open. */
  private async fetchFile(plan: Plan, g: Going): Promise<Partial<ToolTask>> {
    const dir = this.deps.downloads();
    const { file, size } = plan.offer;
    if (path.basename(file) !== file) throw new Error("文件名不对");
    let to = path.join(dir, file);
    const already = await this.deps.exists(to);
    // The same file from an earlier time is used again; a different file of that name is left alone.
    const same = already && size > 0 && (await sizeOf(to)) === size && (!plan.sha256 || (await sha256File(to, g.abort.signal)) === plan.sha256);
    if (!same) {
      if (already) to = await this.freeName(dir, file);
      const part = `${to}.part`;
      await fs.mkdir(dir, { recursive: true });
      g.scratch.push(part);
      await downloadTo({ request: this.deps.request, url: plan.url, hosts: plan.hosts, part, total: size, signal: g.abort.signal, progress: this.progress(g) });
      await this.checked(plan, g, part);
      if (g.abort.signal.aborted) throw new Cancelled();
      await fs.rename(part, to);
    }
    if (g.task.tool === "zotero" && opensAsInstaller(file)) {
      const opened = await this.deps.open(to).then(() => true, () => false);
      return { path: to, opened };
    }
    return { path: to };
  }

  /** "Zotero-10.0.6 (2).dmg": a name no file in the folder has yet (an unfinished download of it is continued). */
  private async freeName(dir: string, file: string): Promise<string> {
    const m = /^(.*?)(\.tar\.[a-z0-9]+|\.[^.]+)?$/.exec(file)!;
    for (let n = 2; n < 100; n++) {
      const candidate = path.join(dir, `${m[1]} (${n})${m[2] ?? ""}`);
      if (!(await this.deps.exists(candidate))) return candidate;
    }
    throw new Error(`下载文件夹里同名的文件太多了，先清理一下 ${file}`);
  }

  // ---- afterwards ----

  private finished(toolInput: unknown): ToolTask {
    const g = this.going.get(this.tool(toolInput));
    if (!g || g.task.phase !== "done" || !g.task.path) throw new Error("还没有下载好的文件");
    return g.task;
  }

  /** Opens the downloaded Zotero installer again. */
  async open(toolInput: unknown): Promise<void> {
    const task = this.finished(toolInput);
    if (task.tool !== "zotero" || !opensAsInstaller(task.file)) throw new Error("这个文件不是可以直接打开的安装包，请到文件夹里处理");
    if (!(await this.deps.exists(task.path!))) throw new Error("安装包已经不在了，重新下载一次");
    await this.deps.open(task.path!);
  }

  /** Shows the downloaded file in its folder; for Quarto, the folder its copies are in. */
  async reveal(toolInput: unknown): Promise<void> {
    const tool = this.tool(toolInput);
    const target = tool === "quarto" ? ((await this.managedQuarto())[0]?.dir ?? this.quartoDir()) : this.finished(tool).path!;
    if (!(await this.deps.exists(target))) throw new Error("文件已经不在了");
    this.deps.reveal(target);
  }

  /** Deletes one copy of Quarto sikeoop downloaded. The user's own Quarto is never touched. */
  async removeQuarto(version: unknown): Promise<PaperToolsState> {
    if (!isVersion(version)) throw new Error("版本号不对");
    const g = this.going.get("quarto");
    if (g && LIVE.has(g.task.phase)) throw new Error("Quarto 正在下载或安装，等它结束或先取消");
    const found = (await this.managedQuarto()).find((m) => m.version === version);
    if (!found) throw new Error(`没有 sikeoop 下载的 Quarto ${version}`);
    await fs.rm(found.dir, { recursive: true, force: true });
    if (g?.task.version === version) this.going.delete("quarto");
    return this.state();
  }
}
