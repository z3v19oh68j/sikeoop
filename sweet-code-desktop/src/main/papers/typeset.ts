import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CslStyle, CslStyleId, PaperTemplateResult, QuartoEvent, QuartoFormat, QuartoRenderRequest, QuartoRun, QuartoStatus, QuartoWatch } from "@shared/types";
import type { Dispatcher } from "../dispatch/scheduler.ts";
import type { ProjectFiles } from "./project-files.ts";
import { type FoundQuarto, QUARTO_DOCUMENT, QuartoExecutor, type RunProcess, chooseQuarto, expectedOutput, failureHint, parseQuartoVersion, parseRenderOutput, plain, quartoCandidates, quartoStatusOf, renderArgs, supportsTypst } from "./quarto.ts";
import { CSL_STYLES, checkTemplateRequest, emptyBib, looksLikeCsl, paperTemplate } from "./template.ts";

// Typesetting for the workshop (docs/方案-论文工坊.md §8.2): finding Quarto (the user's own first), rendering a
// document as a dispatch-core job (cancellable; a failure is boiled down to what matters),
// rendering again when a watched document is saved, and starting a paper from a template.

export interface TypesetDeps {
  userData(): string;
  root(): string;
  platform: NodeJS.Platform;
  env(): Record<string, string | undefined>;
  home: string;
  dispatcher: Pick<Dispatcher, "submit" | "cancel">;
  files: Pick<ProjectFiles, "resolve" | "relative" | "isFile" | "writeNew" | "list">;
  run: RunProcess;
  /** Whether a program is there (it is only run when it is). */
  isFile(absolute: string): Promise<boolean>;
  /** The copies of Quarto sikeoop downloaded (tools.ts), used when the user has none that will do. */
  managed?(): Promise<{ path: string; version: string }[]>;
  /** Fetches a citation style file, the one time it is first used. */
  fetch: typeof fetch;
  /** Asks before files are added to the project. */
  approveNew(files: string[], detail: string): Promise<boolean>;
  /** Calls back when the file is saved; returns how to stop. */
  watchFile(absolute: string, changed: () => void): () => void;
  /** Shows a rendered file to the user. */
  open(absolute: string, format: QuartoFormat): Promise<void>;
  emit(event: QuartoEvent): void;
  /** How long after a save the rendering starts (several saves in a row are one rendering). */
  debounceMs?: number;
}

interface Going {
  root: string;
  run: QuartoRun;
  job?: string;
}

const RENDER_TIMEOUT = 10 * 60_000;
const KEPT_RUNS = 30;
const OUTPUT = /\.(pdf|docx|html)$/i;
const FORMATS = new Set<QuartoFormat>(["pdf", "docx", "html"]);
const LIVE = new Set<QuartoRun["status"]>(["queued", "running"]);

export class TypesetService {
  private readonly deps: TypesetDeps;
  private found: FoundQuarto | null = null;
  private readonly runs = new Map<string, Going>();
  private watching: { root: string; watch: QuartoWatch; stop(): void; timer?: ReturnType<typeof setTimeout>; current?: string; again?: boolean } | null = null;

  constructor(deps: TypesetDeps) {
    this.deps = deps;
  }

  // ---- finding Quarto ----

  /** The version a program reports, or null when it isn't there or doesn't run. */
  private async versionOf(candidate: string): Promise<string | null> {
    if (!(await this.deps.isFile(candidate))) return null;
    let out = "";
    try {
      const code = await this.deps.run(candidate, ["--version"], this.deps.home, (t) => (out += t), AbortSignal.timeout(15_000));
      return code === 0 ? parseQuartoVersion(plain(out)) : null;
    } catch {
      // Not runnable.
      return null;
    }
  }

  /**
   * Looks for the user's Quarto (PATH, then where its installers put it) and asks it for its
   * version; a copy sikeoop downloaded is used only when the user has none that will do.
   */
  async status(): Promise<QuartoStatus> {
    this.found = null;
    let user: FoundQuarto | null = null;
    for (const candidate of quartoCandidates(this.deps.platform, this.deps.env(), this.deps.home)) {
      const version = await this.versionOf(candidate);
      if (version) {
        user = { path: candidate, version };
        break;
      }
    }
    const ours: FoundQuarto[] = [];
    if (!user || !supportsTypst(user.version)) {
      for (const m of (await this.deps.managed?.().catch(() => [])) ?? []) {
        // What it says itself counts, not the folder's name.
        const version = await this.versionOf(m.path);
        if (version) ours.push({ path: m.path, version, managed: true });
      }
    }
    this.found = chooseQuarto(user, ours);
    return quartoStatusOf(this.found);
  }

  private async quarto(format: QuartoFormat): Promise<string> {
    // A copy that was deleted since it was found is looked for again.
    if (this.found && !(await this.deps.isFile(this.found.path))) this.found = null;
    const status = this.found ? quartoStatusOf(this.found) : await this.status();
    if (!status.found || !status.path) throw new Error("没有找到 Quarto，请先按指引安装");
    if (format === "pdf" && !status.typst) throw new Error(`Quarto ${status.version} 出不了 PDF，需要 1.4 或更新的版本`);
    return status.path;
  }

  documents(): Promise<string[]> {
    return this.deps.files.list(QUARTO_DOCUMENT);
  }

  // ---- rendering ----

  private push(entry: Going): void {
    this.deps.emit({ type: "run", run: structuredClone(entry.run) });
  }

  list(): QuartoRun[] {
    const root = this.deps.root();
    return [...this.runs.values()].filter((e) => e.root === root).map((e) => structuredClone(e.run)).sort((a, b) => b.startedAt - a.startedAt);
  }

  async render(input: unknown, trigger: QuartoRun["trigger"] = "manual"): Promise<QuartoRun> {
    const root = this.deps.root();
    if (!input || typeof input !== "object") throw new Error("排版请求格式不正确");
    const req = input as QuartoRenderRequest;
    if (!FORMATS.has(req.format)) throw new Error("输出格式只能是 PDF、Word 或网页");
    if (typeof req.file !== "string" || !QUARTO_DOCUMENT.test(req.file)) throw new Error("只能排版 .qmd 或 .md 文件");
    const absolute = await this.deps.files.resolve(req.file);
    if (!(await this.deps.files.isFile(req.file))) throw new Error(`没有找到 ${req.file}`);
    const bin = await this.quarto(req.format);
    const cwd = path.dirname(absolute);
    const name = path.basename(absolute);
    const args = renderArgs(name, req.format, req.execute === true);

    const run: QuartoRun = { id: randomUUID(), file: await this.deps.files.relative(absolute), format: req.format, trigger, status: "queued", startedAt: Date.now(), points: [], log: "" };
    const entry: Going = { root, run };
    const executor = new QuartoExecutor(`quarto:${run.id}`, {
      bin,
      args,
      cwd,
      run: this.deps.run,
      begin: () => {
        run.status = "running";
        this.push(entry);
      },
    });
    // One rendering of a document at a time: Quarto keeps its intermediate files beside it.
    const sub = this.deps.dispatcher.submit({ executor, input: `排版 ${run.file} → ${req.format.toUpperCase()}`, origin: "user", from: "论文工坊 · 排版", timeoutMs: RENDER_TIMEOUT, lane: `quarto:${absolute}` });
    if ("error" in sub) throw new Error(sub.error);
    entry.job = sub.job.id;
    this.runs.set(run.id, entry);
    // Only the latest renderings are kept; one still going is never dropped.
    for (const [id, old] of this.runs) {
      if (this.runs.size <= KEPT_RUNS) break;
      if (!LIVE.has(old.run.status)) this.runs.delete(id);
    }
    this.push(entry);

    void sub.done.then(async (job) => {
      const report = parseRenderOutput(executor.log);
      run.log = plain(executor.log).trim().slice(-8000);
      if (job.status === "done") {
        // Quarto says where it wrote; when it doesn't, the file is beside the document.
        const written = path.resolve(cwd, report.output ?? expectedOutput(name, req.format));
        const relative = await this.deps.files.relative(written).catch(() => "");
        const there = relative && !relative.startsWith("..") && (await this.deps.files.isFile(relative).catch(() => false));
        if (there) {
          run.status = "done";
          run.output = relative;
          run.points = report.points;
        } else {
          run.status = "failed";
          run.points = ["Quarto 说排完了，但没有找到输出文件", ...report.points];
        }
      } else if (job.status === "cancelled") {
        run.status = "cancelled";
      } else {
        run.status = "failed";
        const hint = failureHint(report.points, executor.log);
        const first = job.status === "timeout" ? "排版超过 10 分钟没有结束，已停下" : (job.error ?? "排版没有成功");
        run.points = [...new Set([...(report.points.length ? report.points : [first]), ...(hint ? [hint] : [])])];
      }
      // Publish completion only after asynchronous output validation settles.
      run.endedAt = Date.now();
      this.push(entry);
      this.afterRun(run);
    });
    return structuredClone(run);
  }

  cancel(id: unknown): void {
    const entry = typeof id === "string" ? this.runs.get(id) : undefined;
    if (!entry || entry.root !== this.deps.root() || !entry.job || !LIVE.has(entry.run.status)) return;
    this.deps.dispatcher.cancel(entry.job);
  }

  // ---- rendering again on save ----

  watchingNow(): QuartoWatch | null {
    return this.watching && this.watching.root === this.deps.root() ? { ...this.watching.watch } : null;
  }

  private stopWatching(): void {
    if (!this.watching) return;
    clearTimeout(this.watching.timer);
    this.watching.stop();
    this.watching = null;
  }

  /** Starts (or, with null, stops) rendering a document every time it is saved. One document at a time. */
  async watch(input: unknown): Promise<QuartoWatch | null> {
    this.stopWatching();
    if (input === null || input === undefined) {
      this.deps.emit({ type: "watch", watch: null });
      return null;
    }
    const w = input as QuartoWatch;
    if (typeof w !== "object" || !FORMATS.has(w.format) || typeof w.file !== "string" || !QUARTO_DOCUMENT.test(w.file)) throw new Error("实时预览的请求格式不正确");
    const root = this.deps.root();
    const absolute = await this.deps.files.resolve(w.file);
    if (!(await this.deps.files.isFile(w.file))) throw new Error(`没有找到 ${w.file}`);
    await this.quarto(w.format);
    const watch: QuartoWatch = { file: await this.deps.files.relative(absolute), format: w.format, execute: w.execute === true };
    const state: NonNullable<TypesetService["watching"]> = {
      root,
      watch,
      stop: this.deps.watchFile(absolute, () => {
        if (this.watching !== state) return;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => this.renderWatched(state), this.deps.debounceMs ?? 700);
      }),
    };
    this.watching = state;
    this.deps.emit({ type: "watch", watch: { ...watch } });
    this.renderWatched(state);
    return { ...watch };
  }

  private renderWatched(state: NonNullable<TypesetService["watching"]>): void {
    if (this.watching !== state) return;
    // The project was switched: the watch belongs to the old one.
    if (this.safeRoot() !== state.root) return this.stopWatching();
    // Saved again while rendering: once more when this one is done, not a pile of renderings.
    if (state.current) {
      state.again = true;
      return;
    }
    state.current = "starting";
    this.render({ file: state.watch.file, format: state.watch.format, execute: state.watch.execute }, "save").then(
      (run) => {
        if (state.current === "starting") state.current = run.id;
      },
      () => {
        state.current = undefined;
      },
    );
  }

  private afterRun(run: QuartoRun): void {
    const state = this.watching;
    if (!state || run.trigger !== "save" || (state.current !== run.id && state.current !== "starting")) return;
    state.current = undefined;
    if (state.again) {
      state.again = false;
      this.renderWatched(state);
    }
  }

  private safeRoot(): string | null {
    try {
      return this.deps.root();
    } catch {
      return null;
    }
  }

  // ---- looking at the output ----

  async open(file: unknown): Promise<void> {
    if (typeof file !== "string" || !OUTPUT.test(file)) throw new Error("只能打开排版出来的 PDF、Word 或网页");
    const absolute = await this.deps.files.resolve(file);
    if (!(await this.deps.files.isFile(file))) throw new Error(`没有找到 ${file}`);
    const ext = path.extname(absolute).slice(1).toLowerCase() as QuartoFormat;
    await this.deps.open(absolute, ext);
  }

  // ---- a new paper from the template ----

  private cslCache(id: CslStyleId): string {
    return path.join(this.deps.userData(), "papers-csl", CSL_STYLES[id].file);
  }

  async cslStyles(): Promise<CslStyle[]> {
    return Promise.all(
      (Object.keys(CSL_STYLES) as CslStyleId[]).map(async (id) => {
        const s = CSL_STYLES[id];
        return { id, title: s.title, file: s.file, url: s.url, license: s.license, cached: await this.deps.isFile(this.cslCache(id)) };
      }),
    );
  }

  /** The style file's text: from the copy kept after the first download, or fetched now when allowed. */
  private async csl(id: CslStyleId, mayDownload: boolean): Promise<string | undefined> {
    const cache = this.cslCache(id);
    const kept = await fs.readFile(cache, "utf8").catch(() => undefined);
    if (kept && looksLikeCsl(kept)) return kept;
    if (!mayDownload) return undefined;
    const res = await this.deps.fetch(CSL_STYLES[id].url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`样式文件下载失败（${res.status}）`);
    const text = await res.text();
    if (!looksLikeCsl(text)) throw new Error("下载到的不是 CSL 样式文件");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, text);
    return text;
  }

  /**
   * Adds a paper to the project: the document, an empty references.bib and (when there is one) the
   * citation style file. Nothing that exists is replaced; the user is asked before anything is added.
   */
  async newPaper(input: unknown): Promise<PaperTemplateResult> {
    const req = checkTemplateRequest(input);
    const at = (name: string) => (req.dir ? `${req.dir}/${name}` : name);
    const document = at(`${req.name}.qmd`);
    await this.deps.files.resolve(document);
    if (await this.deps.files.isFile(document)) throw new Error(`${document} 已经存在，换个文件名或文件夹`);

    let cslText: string | undefined;
    let cslError: string | undefined;
    try {
      cslText = await this.csl(req.csl, req.downloadCsl);
    } catch (err) {
      // The paper is still made; it uses the built-in fallback until the file can be fetched.
      cslError = err instanceof Error ? err.message : String(err);
    }
    const cslFile = cslText ? CSL_STYLES[req.csl].file : undefined;

    const wanted: [string, string][] = [
      [document, paperTemplate(req, { cslFile, platform: this.deps.platform })],
      [at("references.bib"), emptyBib()],
      ...(cslText && cslFile ? [[at(cslFile), cslText] as [string, string]] : []),
    ];
    const add: [string, string][] = [];
    const skipped: string[] = [];
    for (const [file, content] of wanted) ((await this.deps.files.isFile(file)) ? skipped.push(file) : add.push([file, content]));
    const detail = [`会新增：${add.map(([f]) => f).join("、")}`, skipped.length ? `已经有、不动：${skipped.join("、")}` : "", cslFile ? `引用格式文件 ${cslFile} 来自 CSL 官方样式库（${CSL_STYLES[req.csl].license}），原样保存` : ""].filter(Boolean).join("\n");
    if (!(await this.deps.approveNew(add.map(([f]) => f), detail))) throw new Error("你取消了新建，没有添加文件");
    for (const [file, content] of add) await this.deps.files.writeNew(file, content);
    return { document, files: add.map(([f]) => f), skipped, ...(cslError ? { cslError } : {}) };
  }
}
