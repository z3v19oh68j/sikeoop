import { z } from "zod";
import type { FileNode, WikiAnswer, WikiAskRequest, WikiPage, WikiState } from "@shared/types";
import type { RagService } from "../rag/service";
import { buildTree, readWorkspaceFile, treeToText } from "../workspace";
import { type StoredPage, type WikiFile, WikiStore, sha } from "./store";

// The project wiki, after deepwiki-open: the model first plans a table of contents from the
// file tree and README, then writes each page from that page's files plus what the code index
// finds for its topic. Pages remember the hashes of their files, so a later run rewrites only
// the pages whose code changed.

/** One plain request: system + user → text. */
export type WikiWriter = (system: string, user: string, opts: { maxTokens: number; signal: AbortSignal }) => Promise<string>;

const MAX_PAGES = 12;
const FILES_PER_PAGE = 8;
/** Characters of one file shown to the page writer, and of all its files together. */
const FILE_CHARS = 12_000;
const PAGE_CHARS = 48_000;

const PlanSchema = z.object({
  title: z.string().min(1),
  summary: z.string().default(""),
  pages: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        description: z.string().default(""),
        files: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

const PLAN_SYSTEM = `你是资深软件架构师，要给一个代码项目写一份面向新手的中文 Wiki。
先只做规划：根据文件树、README 和依赖清单，设计 4 到 ${MAX_PAGES} 页的目录。
第一页必须是「项目概览」（做什么、技术栈、整体架构）。其余页按模块或数据流拆分，每页覆盖一块相对独立的内容。
每页列出最能说明它的源文件（最多 ${FILES_PER_PAGE} 个，路径必须原样出自文件树）。
只输出一个 JSON 对象，不要任何其他文字：
{"title":"项目名","summary":"一两句话说明项目","pages":[{"id":"overview","title":"…","description":"这页讲什么","files":["src/a.ts"]}]}`;

const PAGE_SYSTEM = `你是资深软件架构师，在给一个代码项目写面向新手的中文 Wiki 中的一页。
要求：
- 只依据给出的源码写，不要编造不存在的文件、函数或配置；不确定就不写。
- 用 Markdown，从二级标题（##）开始，不要重复页面标题。
- 至少画一张 Mermaid 图（\`\`\`mermaid 代码块）说明结构、调用流程或数据流。节点文字含特殊字符时用双引号包起来。
- 提到具体代码时，用链接指向文件和行号，链接地址必须是从项目根开始的完整路径（和源码标题里的一样），例如 [loop.ts](src/main/agent/loop.ts:42)，不能只写文件名。
- 文件名、函数名、通配符（如 \`build_*\`）等代码标识符一律放进反引号，否则其中的 * 和 _ 会被当成加粗、斜体符号。加粗的 ** 必须成对出现。
- 语言是大白话，先讲“它是干什么的、为什么这样设计”，再讲细节。篇幅适中（约 600 到 1500 字）。`;

const ASK_SYSTEM = `你是这个项目的向导，在回答用户读项目百科时提出的问题。
- 优先依据给出的源码和百科页面回答；资料里没有的就直说不确定，不要编造。
- 用户选中了段落时，围绕那段内容解释。
- 用中文大白话，简洁直接，必要时用 Mermaid 图或短代码片段说明。
- 提到代码时用完整路径链接，例如 [loop.ts](src/main/agent/loop.ts:42)；文件名、函数名等标识符放进反引号。`;

interface Run {
  root: string;
  controller: AbortController;
  progress: { done: number; total: number; label: string };
}

export class WikiService {
  private readonly store: WikiStore;
  private run: Run | null = null;
  private lastError?: { root: string; message: string };

  constructor(
    private readonly opts: {
      cacheDir: string;
      root(): string | null;
      rag: RagService;
      /** A model with its label: the chat model, or the given provider. Throws when it isn't set up. */
      writer(providerId?: string): { write: WikiWriter; model: string };
      onState(s: WikiState | null): void;
    },
  ) {
    this.store = new WikiStore(opts.cacheDir);
  }

  /** The open project's wiki, with each page checked against the files on disk. */
  async get(): Promise<WikiState | null> {
    const root = this.opts.root();
    if (!root) return null;
    const data = await this.store.load(root);
    const run = this.run?.root === root ? this.run : null;
    const error = this.lastError?.root === root ? this.lastError.message : undefined;
    if (!data) return run || error ? { title: "", summary: "", pages: [], running: !!run, progress: run?.progress, error } : null;
    const files = flatten(await buildTree().catch(() => []));
    return {
      title: data.title,
      summary: data.summary,
      pages: await Promise.all(
        data.pages.map(async (p) => {
          const page = await this.withStale(p);
          // Also mends pages written before links were checked.
          return page.content ? { ...page, content: fixFileLinks(page.content, files, page.files) } : page;
        }),
      ),
      generatedAt: data.generatedAt,
      model: data.model,
      running: !!run,
      progress: run?.progress,
      error,
    };
  }

  /** Starts writing in the background; progress arrives through onState. */
  async generate(mode: "all" | "stale"): Promise<void> {
    const root = this.opts.root();
    if (!root) throw new Error("先打开一个项目");
    if (this.run) throw new Error("项目百科正在生成中");
    const writer = this.opts.writer();
    const run: Run = { root, controller: new AbortController(), progress: { done: 0, total: 1, label: "准备中" } };
    this.run = run;
    this.lastError = undefined;
    void this.push();
    void this.execute(run, mode, writer)
      .catch((err: Error) => {
        if (!run.controller.signal.aborted) this.lastError = { root, message: err.message };
      })
      .finally(() => {
        if (this.run === run) this.run = null;
        void this.push();
      });
  }

  /** Stops a run; pages written so far are kept. */
  cancel(): void {
    this.run?.controller.abort();
  }

  private asking: AbortController | null = null;

  /** Answers a question about the wiki from the page, the selected passage and the code index. */
  async ask(req: WikiAskRequest): Promise<WikiAnswer> {
    const root = this.opts.root();
    if (!root) throw new Error("先打开一个项目");
    const question = req.question.trim();
    if (!question) throw new Error("请输入问题");
    const writer = this.opts.writer(req.providerId);
    this.asking?.abort();
    const controller = new AbortController();
    this.asking = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    try {
      const data = await this.store.load(root);
      const page = data?.pages.find((p) => p.id === req.pageId);
      const parts: string[] = [];
      if (data) parts.push(`项目：${data.title}\n${data.summary}`);
      if (page?.content) parts.push(`# 用户正在看的百科页面「${page.title}」\n${page.content.slice(0, 16_000)}`);
      if (req.quote?.trim()) parts.push(`# 用户选中的段落\n${req.quote.trim().slice(0, 4000)}`);

      const index = this.opts.rag.current();
      const hits = index ? await index.search(`${question} ${req.quote ?? ""}`.slice(0, 2000), 8, { signal }).catch(() => []) : [];
      if (hits.length) {
        parts.push(
          "# 代码索引检索到的相关源码\n" +
            hits.map((h) => `## ${h.chunk.path}:${h.chunk.start}-${h.chunk.end}\n\`\`\`\n${h.chunk.text.slice(0, 4000)}\n\`\`\``).join("\n\n"),
        );
      }
      const history = req.history
        .slice(-4)
        .map((h) => `问：${h.question}\n答：${h.answer.slice(0, 3000)}`)
        .join("\n\n");
      if (history) parts.push(`# 之前的问答\n${history}`);
      parts.push(`# 问题\n${question}`);

      const answer = await writer.write(ASK_SYSTEM, parts.join("\n\n"), { maxTokens: 3000, signal });
      if (!answer.trim()) throw new Error("模型没有返回内容");
      const files = flatten(await buildTree().catch(() => []));
      return { answer: fixFileLinks(answer, files, page?.files), model: writer.model };
    } catch (err) {
      if (controller.signal.aborted) throw new Error("已停止");
      throw err;
    } finally {
      if (this.asking === controller) this.asking = null;
    }
  }

  cancelAsk(): void {
    this.asking?.abort();
  }

  private async execute(run: Run, mode: "all" | "stale", writer: { write: WikiWriter; model: string }): Promise<void> {
    const { signal } = run.controller;
    const files = flatten(await buildTree());
    let data = mode === "stale" ? await this.store.load(run.root) : null;

    if (!data) {
      this.step(run, 0, 1, "规划目录");
      data = await this.plan(run.root, writer.write, signal);
      data.model = writer.model;
      await this.save(run, data);
    }

    const todo: StoredPage[] = [];
    for (const p of data.pages) {
      if (mode === "all" || !p.content || p.error || (await this.withStale(p)).stale) todo.push(p);
    }
    for (const [i, page] of todo.entries()) {
      this.step(run, i, todo.length, `正在写「${page.title}」`);
      try {
        const { content, hashes } = await this.writePage(data, page, writer.write, signal);
        Object.assign(page, { content: fixFileLinks(content, files, page.files), hashes, error: undefined });
      } catch (err) {
        if (signal.aborted) throw err;
        page.error = (err as Error).message;
      }
      data.generatedAt = Date.now();
      data.model = writer.model;
      await this.save(run, data);
    }
  }

  private async plan(root: string, write: WikiWriter, signal: AbortSignal): Promise<WikiFile> {
    const tree = await buildTree();
    const files = new Set(flatten(tree));
    const parts = [`# 文件树\n${treeToText(tree, 6, 600)}`];
    for (const name of ["README.md", "readme.md", "README", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
      if (!files.has(name)) continue;
      const text = await readWorkspaceFile(name).catch(() => "");
      if (text) parts.push(`# ${name}\n${text.slice(0, 6000)}`);
    }
    const raw = await write(PLAN_SYSTEM, parts.join("\n\n"), { maxTokens: 3000, signal });
    const plan = parsePlan(raw);

    const ids = new Set<string>();
    const pages: StoredPage[] = plan.pages.slice(0, MAX_PAGES).map((p, i) => {
      let id = slug(p.id || p.title) || `page-${i + 1}`;
      while (ids.has(id)) id += "-2";
      ids.add(id);
      const own = [...new Set(p.files.map((f) => f.replace(/^\.?\//, "")))].filter((f) => files.has(f)).slice(0, FILES_PER_PAGE);
      return { id, title: p.title, description: p.description, files: own };
    });
    return { version: 1, root, title: plan.title, summary: plan.summary, pages, generatedAt: Date.now(), model: "" };
  }

  private async writePage(data: WikiFile, page: StoredPage, write: WikiWriter, signal: AbortSignal) {
    const hashes: Record<string, string> = {};
    const blocks: string[] = [];
    let budget = PAGE_CHARS;
    for (const f of page.files) {
      const text = await readWorkspaceFile(f).catch(() => null);
      if (text === null) continue;
      hashes[f] = sha(text);
      const shown = text.slice(0, Math.min(FILE_CHARS, budget));
      if (!shown) continue;
      budget -= shown.length;
      blocks.push(`## ${f}${shown.length < text.length ? "（截取开头）" : ""}\n\`\`\`\n${numbered(shown)}\n\`\`\``);
    }

    // More code on the topic from the project index, outside the page's own files.
    const index = this.opts.rag.current();
    if (index && budget > 2000) {
      const hits = await index.search(`${page.title} ${page.description}`, 8, { signal }).catch(() => []);
      for (const h of hits) {
        if (budget <= 0) break;
        if (hashes[h.chunk.path]) continue;
        budget -= h.chunk.text.length;
        blocks.push(`## ${h.chunk.path}:${h.chunk.start}-${h.chunk.end}（检索到的相关片段）\n\`\`\`\n${h.chunk.text}\n\`\`\``);
      }
    }

    const toc = data.pages.map((p) => `- ${p.title}：${p.description}`).join("\n");
    const user =
      `项目：${data.title}\n${data.summary}\n\nWiki 目录：\n${toc}\n\n` +
      `现在写这一页：「${page.title}」\n这页讲：${page.description}\n\n` +
      `源码（每行开头是行号）：\n\n${blocks.join("\n\n") || "（没有找到相关源码，只根据目录简要说明）"}`;
    const content = await write(PAGE_SYSTEM, user, { maxTokens: 4000, signal });
    if (!content.trim()) throw new Error("模型没有返回内容");
    return { content, hashes };
  }

  private async withStale(p: StoredPage): Promise<WikiPage> {
    const { hashes, ...page } = p;
    if (!p.content || !hashes) return page;
    for (const [f, h] of Object.entries(hashes)) {
      const text = await readWorkspaceFile(f).catch(() => null);
      if (text === null || sha(text) !== h) return { ...page, stale: true };
    }
    return page;
  }

  /** Saves only while the run's project is still the open one. */
  private async save(run: Run, data: WikiFile): Promise<void> {
    if (this.opts.root() !== run.root) {
      run.controller.abort();
      throw new Error("项目已切换");
    }
    await this.store.save(data);
    await this.push();
  }

  private step(run: Run, done: number, total: number, label: string): void {
    run.progress = { done, total, label };
    void this.push();
  }

  private async push(): Promise<void> {
    this.opts.onState(await this.get().catch(() => null));
  }
}

/**
 * Points links that name a file by a partial path (`[x](briefs.py:12)`) at the project file
 * they mean: the page's own files first, then any project file, when exactly one matches.
 */
export function fixFileLinks(content: string, files: string[], preferred: string[] = []): string {
  const all = new Set(files);
  const find = (rel: string) => {
    for (const pool of [preferred, files]) {
      const hits = pool.filter((f) => f === rel || f.endsWith("/" + rel));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null;
    }
    return null;
  };
  return content.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("#")) return whole;
    const m = href.match(/^(?:\.\/)?(.*?)((?::\d+(?:[-:]\d+)?|#L\d+\S*)?)$/);
    if (!m || !m[1] || all.has(m[1])) return whole;
    // Models escape underscores (\\_) and sometimes add a folder in front: drop leading folders until one matches.
    const parts = m[1].replace(/\\(?=[_*])/g, "").split("/");
    for (let i = 0; i < parts.length; i++) {
      const full = find(parts.slice(i).join("/"));
      if (full) return `](${full}${m[2]})`;
    }
    return whole;
  });
}

function flatten(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "file" ? [n.path] : flatten(n.children ?? [])));
}

/** The plan JSON, tolerating code fences or a sentence around it. */
export function parsePlan(raw: string): z.infer<typeof PlanSchema> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回有效的目录");
  try {
    return PlanSchema.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    throw new Error("模型返回的目录格式不对，请重试");
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const numbered = (text: string) =>
  text
    .split("\n")
    .map((l, i) => `${i + 1}\t${l}`)
    .join("\n");
