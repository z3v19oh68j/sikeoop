import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, GraphOrigin, GraphSource, GraphState, KnowledgeGraph } from "@shared/types";
import { readGitignore } from "../rag/code-index";
import { sha } from "../wiki/store";
import type { WikiWriter } from "../wiki/service";
import { IGNORED_DIRS, readWorkspaceFile, resolveSafe } from "../workspace";
import { type CodeScan, codeFingerprint, scanCode } from "./code";
import { DOC_EXT, readDocument } from "./extract";
import { type GraphFile, GraphStore, type StoredGraph } from "./store";

// 知识图谱: a project or a document broken into flat, typed nodes and the relations between them.
// Code graphs take their modules and import edges from a static scan; one model call names the
// modules and groups them into features. Document graphs come from the model reading the text
// in parts; every quote it gives is checked against the document and dropped when it isn't there.
// Layers are fixed per node kind, so the same input always lays out the same way.

export const CODE_LAYERS: { kind: GraphNodeKind; name: string }[] = [
  { kind: "entry", name: "入口" },
  { kind: "feature", name: "功能" },
  { kind: "module", name: "模块" },
  { kind: "data", name: "数据" },
];
export const DOC_LAYERS: { kind: GraphNodeKind; name: string }[] = [
  { kind: "goal", name: "目标" },
  { kind: "requirement", name: "需求" },
  { kind: "feature", name: "功能" },
  { kind: "interface", name: "接口" },
  { kind: "constraint", name: "约束" },
];
const EDGE_KINDS: GraphEdgeKind[] = ["contains", "depends", "calls", "implements", "constrains", "produces", "uses"];

/** Characters of a document read per model call, and at most how many calls. */
const DOC_PART_CHARS = 40_000;
const DOC_MAX_PARTS = 5;
const MAX_FEATURES = 14;

const CODE_SYSTEM = `你是资深软件架构师，要把一个代码项目整理成一张扁平、客观的知识图谱。
给你的是静态分析得到的模块清单（模块 id、路径、导出的名字）和模块之间真实的 import 关系。
你要做三件事：
1. 给每个模块起一个中文短名（不超过 10 个字），写一句话说明它负责什么。
2. 判断每个模块的角色：entry（程序入口、页面、路由、命令行等用户或系统直接触达的地方）、data（存储、数据模型、类型定义、配置、数据库访问）、module（其余的业务逻辑）。
3. 归纳 3 到 ${MAX_FEATURES} 个用户能感知到的功能，每个功能列出实现它的模块和触发它的入口模块。
要求：只依据给出的信息，看不出来的不要编造；id 必须原样出自清单；说明用大白话，不要套话。
只输出一个 JSON 对象，不要任何其他文字：
{"title":"项目名","summary":"一两句话说明项目","modules":[{"id":"m1","name":"…","summary":"…","role":"entry|module|data"}],"features":[{"name":"…","summary":"…","modules":["m2"],"entries":["m1"]}]}`;

const DOC_SYSTEM = `你是严谨的需求分析师，要把一份开发文档拆成扁平、客观的知识图谱节点和关系。
节点类型：
- goal：文档要达成的目标或要解决的问题
- requirement：具体需求（用户故事、必须满足的条件、验收标准）
- feature：功能点或模块
- interface：接口、页面、API、数据结构、对外协议
- constraint：约束（性能、安全、兼容、时间、技术选型限制等）
关系类型（from → to）：contains 包含、depends 依赖、calls 调用、implements 实现、constrains 约束、produces 产出、uses 使用。
要求：
- 只提取文档里明确写了的内容，不要推测、不要补充文档没说的东西。
- 一个节点只讲一件事；相同的事只出现一次。label 不超过 16 个字。
- quote 必须是从原文逐字复制的一小段连续文字（10 到 60 个字），用来证明这个节点出自文档。
- section 写节点所在的章节标题（没有就留空）。
- 尽量把每个需求连到它服务的目标和实现它的功能；连线也必须有文档依据。
只输出一个 JSON 对象，不要任何其他文字：
{"title":"文档主题","summary":"一两句话概括文档","nodes":[{"id":"n1","kind":"requirement","label":"…","summary":"…","section":"…","quote":"…"}],"edges":[{"from":"n1","to":"n2","kind":"implements"}]}`;

const CodeReply = z.object({
  title: z.string().default(""),
  summary: z.string().default(""),
  modules: z.array(z.object({ id: z.string(), name: z.string().default(""), summary: z.string().default(""), role: z.string().default("module") })).default([]),
  features: z
    .array(z.object({ name: z.string().min(1), summary: z.string().default(""), modules: z.array(z.string()).default([]), entries: z.array(z.string()).default([]) }))
    .default([]),
});

const DocReply = z.object({
  title: z.string().default(""),
  summary: z.string().default(""),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string().min(1),
        summary: z.string().default(""),
        section: z.string().default(""),
        quote: z.string().default(""),
      }),
    )
    .default([]),
  edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string().default("uses") })).default([]),
});

interface Run {
  root: string;
  id: string;
  controller: AbortController;
  progress: { label: string; done: number; total: number };
}

export class GraphService {
  private readonly store: GraphStore;
  private run: Run | null = null;
  private lastError?: { root: string; message: string };
  /** Documents outside the project the user picked in the open dialog; only these can be read. */
  private readonly picked = new Set<string>();

  constructor(
    private readonly opts: {
      cacheDir: string;
      root(): string | null;
      writer(): { write: WikiWriter; model: string };
      onState(s: GraphState): void;
    },
  ) {
    this.store = new GraphStore(opts.cacheDir);
  }

  async state(): Promise<GraphState> {
    const root = this.opts.root();
    if (!root) return { graphs: [], running: null };
    const data = await this.store.load(root);
    const run = this.run?.root === root ? this.run : null;
    return {
      graphs: data.graphs.map((g) => ({ id: g.id, title: g.title, origin: g.origin, nodes: g.nodes.length, generatedAt: g.generatedAt })),
      running: run ? { id: run.id, ...run.progress } : null,
      error: this.lastError?.root === root ? this.lastError.message : undefined,
    };
  }

  /** One graph, checked against the code or the document it came from. */
  async get(id: string): Promise<KnowledgeGraph | null> {
    const root = this.opts.root();
    if (!root) return null;
    const g = (await this.store.load(root)).graphs.find((x) => x.id === id);
    if (!g) return null;
    const { fingerprint, ...graph } = g;
    let now: string | null = null;
    if (g.origin.type === "code") now = await codeFingerprint(root).catch(() => null);
    else now = await this.docAbs(g.origin.path, g.origin.external).then((abs) => readDocument(abs).then((d) => d.hash), () => null);
    return { ...graph, stale: now !== null && now !== fingerprint };
  }

  async delete(id: string): Promise<void> {
    const root = this.opts.root();
    if (!root) return;
    const data = await this.store.load(root);
    data.graphs = data.graphs.filter((g) => g.id !== id);
    await this.store.save(data);
    await this.push();
  }

  /** Documents in the project a graph can be built from, by path. */
  async projectDocs(): Promise<string[]> {
    const root = this.opts.root();
    if (!root) return [];
    const ignore = await readGitignore(root);
    const out: string[] = [];
    const queue = [""];
    while (queue.length && out.length < 300) {
      const dir = queue.shift()!;
      const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".") && !ignore(rel, true)) queue.push(rel);
        } else if (e.isFile() && DOC_EXT.has(path.extname(e.name).toLowerCase()) && !ignore(rel, false)) {
          out.push(rel);
        }
      }
    }
    return out.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  }

  /** Remembers a document the user picked from the computer, so buildDoc may read it. */
  allow(abs: string): void {
    this.picked.add(path.resolve(abs));
  }

  buildCode(): Promise<void> {
    return this.start("code", (run, writer) => this.executeCode(run, writer));
  }

  async buildDoc(file: string): Promise<void> {
    const external = path.isAbsolute(file);
    if (external && !this.picked.has(path.resolve(file))) {
      // Rebuilding a graph made from a document picked in an earlier session is fine too.
      const root = this.opts.root();
      const known = root && (await this.store.load(root)).graphs.some((g) => g.origin.type === "doc" && g.origin.external && g.origin.path === file);
      if (!known) throw new Error("只能读取你在对话框里选择的文档");
    }
    return this.start(`doc-${sha(file).slice(0, 10)}`, (run, writer) => this.executeDoc(run, writer, file, external));
  }

  cancel(): void {
    this.run?.controller.abort();
  }

  private async start(id: string, job: (run: Run, writer: { write: WikiWriter; model: string }) => Promise<StoredGraph>): Promise<void> {
    const root = this.opts.root();
    if (!root) throw new Error("先打开一个项目");
    if (this.run) throw new Error("已经有一张图谱在生成了，等它完成或先停止");
    const writer = this.opts.writer();
    const run: Run = { root, id, controller: new AbortController(), progress: { label: "准备中", done: 0, total: 1 } };
    this.run = run;
    this.lastError = undefined;
    void this.push();
    void job(run, writer)
      .then(async (graph) => {
        if (this.opts.root() !== root) throw new Error("项目已切换");
        const data: GraphFile = await this.store.load(root);
        data.graphs = [graph, ...data.graphs.filter((g) => g.id !== graph.id)];
        await this.store.save(data);
      })
      .catch((err: Error) => {
        if (!run.controller.signal.aborted) this.lastError = { root, message: err.message };
      })
      .finally(() => {
        if (this.run === run) this.run = null;
        void this.push();
      });
  }

  private async executeCode(run: Run, writer: { write: WikiWriter; model: string }): Promise<StoredGraph> {
    const { signal } = run.controller;
    this.step(run, "扫描代码和依赖", 0, 2);
    const scan = await scanCode(run.root, signal);
    if (!scan.modules.length) throw new Error("项目里没有找到可以分析的源代码文件");

    this.step(run, "AI 归纳功能", 1, 2);
    const parts: string[] = [];
    const readme = await readWorkspaceFile("README.md").catch(() => "");
    if (readme) parts.push(`# README（开头）\n${readme.slice(0, 3000)}`);
    parts.push(
      `# 模块清单（共 ${scan.modules.length} 个，来自 ${scan.files} 个源文件${scan.truncated ? "，项目太大只扫描了一部分" : ""}）\n` +
        scan.modules
          .map((m) => {
            const files = m.files.length === 1 ? m.key : `${m.key}/（${m.files.length} 个文件）`;
            return `${m.id} | ${files}${m.symbols.length ? ` | 导出：${m.symbols.join(", ")}` : ""}`;
          })
          .join("\n"),
    );
    parts.push(`# import 关系（from → to ×次数）\n${scan.links.map((l) => `${l.from} → ${l.to} ×${l.weight}`).join("\n") || "（没有找到）"}`);
    const raw = await writer.write(CODE_SYSTEM, parts.join("\n\n"), { maxTokens: 8000, signal });
    const reply = parseJson(raw, CodeReply);
    return { ...codeGraph(scan, reply, path.basename(run.root)), model: writer.model };
  }

  private async executeDoc(run: Run, writer: { write: WikiWriter; model: string }, file: string, external: boolean): Promise<StoredGraph> {
    const { signal } = run.controller;
    this.step(run, "读取文档", 0, 1);
    const abs = await this.docAbs(file, external);
    const doc = await readDocument(abs);
    const chunks = splitDoc(doc.text, DOC_PART_CHARS).slice(0, DOC_MAX_PARTS);
    const name = path.basename(abs);
    const merged = new DocMerge();
    for (const [i, chunk] of chunks.entries()) {
      this.step(run, chunks.length > 1 ? `梳理文档（第 ${i + 1}/${chunks.length} 部分）` : "梳理文档", i, chunks.length);
      const known = merged.nodes.length
        ? `\n\n# 前面部分已经提取的节点（相同的事请直接复用这些 id，不要重复建；新节点的 id 用 x1、x2…）\n${merged.nodes.map((n) => `${n.id} | ${n.kind} | ${n.label}`).join("\n")}`
        : "";
      const user = `文档：${name}${chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 部分）` : ""}${known}\n\n# 文档内容\n${chunk}`;
      const raw = await writer.write(DOC_SYSTEM, user, { maxTokens: 8000, signal });
      merged.add(parseJson(raw, DocReply), doc.text, doc.lineExact && !external ? file : undefined);
    }
    if (!merged.nodes.length) throw new Error("没有从文档里梳理出节点，可能文档内容太少");
    const origin: GraphOrigin = { type: "doc", name, path: file, external };
    return {
      id: run.id,
      title: merged.title || name,
      summary: merged.summary,
      origin,
      layers: DOC_LAYERS.map((l) => l.name),
      nodes: merged.nodes,
      edges: merged.edges,
      generatedAt: Date.now(),
      model: writer.model,
      fingerprint: doc.hash,
    };
  }

  private async docAbs(file: string, external: boolean): Promise<string> {
    return external ? file : resolveSafe(file);
  }

  private step(run: Run, label: string, done: number, total: number): void {
    run.progress = { label, done, total };
    void this.push();
  }

  private async push(): Promise<void> {
    this.opts.onState(await this.state().catch(() => ({ graphs: [], running: null })));
  }
}

function codeGraph(scan: CodeScan, reply: z.infer<typeof CodeReply>, fallbackTitle: string): Omit<StoredGraph, "model"> {
  const layer = (kind: GraphNodeKind) => CODE_LAYERS.findIndex((l) => l.kind === kind);
  const info = new Map(reply.modules.map((m) => [m.id, m]));
  const nodes: GraphNode[] = scan.modules.map((m) => {
    const r = info.get(m.id);
    const kind: GraphNodeKind = r?.role === "entry" ? "entry" : r?.role === "data" ? "data" : "module";
    const base = m.key === "." ? "根目录" : m.key.slice(m.key.lastIndexOf("/") + 1);
    return {
      id: m.id,
      label: r?.name.trim() || base,
      kind,
      layer: layer(kind),
      summary: r?.summary.trim() ?? "",
      sources: m.files.slice(0, 12).map((f) => ({ file: f })),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = scan.links.map((l) => ({ from: l.from, to: l.to, kind: "depends", weight: l.weight }));
  reply.features.slice(0, MAX_FEATURES).forEach((f, i) => {
    const id = `f${i + 1}`;
    const modules = f.modules.filter((m) => ids.has(m));
    const entries = f.entries.filter((m) => ids.has(m));
    nodes.push({
      id,
      label: f.name.trim(),
      kind: "feature",
      layer: layer("feature"),
      summary: f.summary.trim(),
      sources: [...new Set([...entries, ...modules])].flatMap((m) => nodes.find((n) => n.id === m)?.sources.slice(0, 2) ?? []).slice(0, 8),
    });
    for (const e of entries) edges.push({ from: e, to: id, kind: "uses" });
    for (const m of modules) if (!entries.includes(m)) edges.push({ from: id, to: m, kind: "implements" });
  });
  return {
    id: "code",
    title: reply.title.trim() || fallbackTitle,
    summary: reply.summary.trim(),
    origin: { type: "code" },
    layers: CODE_LAYERS.map((l) => l.name),
    nodes,
    edges,
    generatedAt: Date.now(),
    fingerprint: scan.fingerprint,
  };
}

/** Collects the parts of a long document into one graph, keeping the model's ids unique across parts. */
class DocMerge {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  title = "";
  summary = "";
  private byLabel = new Map<string, string>();

  add(reply: z.infer<typeof DocReply>, text: string, file: string | undefined): void {
    if (!this.title) this.title = reply.title.trim();
    if (!this.summary) this.summary = reply.summary.trim();
    const flat = squash(text);
    const local = new Map<string, string>();
    for (const n of reply.nodes) {
      const kind = DOC_LAYERS.find((l) => l.kind === n.kind)?.kind ?? "requirement";
      const key = `${kind}:${squash(n.label)}`;
      // The model reusing an id from an earlier part, or the same label again.
      const existing = this.nodes.find((x) => x.id === n.id) ? n.id : this.byLabel.get(key);
      const source = docSource(n, text, flat, file);
      if (existing) {
        local.set(n.id, existing);
        const node = this.nodes.find((x) => x.id === existing)!;
        if (source && node.sources.length < 4) node.sources.push(source);
        continue;
      }
      const id = `n${this.nodes.length + 1}`;
      local.set(n.id, id);
      this.byLabel.set(key, id);
      this.nodes.push({
        id,
        label: n.label.trim().slice(0, 40),
        kind,
        layer: DOC_LAYERS.findIndex((l) => l.kind === kind),
        summary: n.summary.trim(),
        sources: source ? [source] : [],
      });
    }
    const seen = new Set(this.edges.map((e) => `${e.from}>${e.to}`));
    for (const e of reply.edges) {
      const from = local.get(e.from) ?? (this.nodes.some((n) => n.id === e.from) ? e.from : undefined);
      const to = local.get(e.to) ?? (this.nodes.some((n) => n.id === e.to) ? e.to : undefined);
      if (!from || !to || from === to || seen.has(`${from}>${to}`)) continue;
      seen.add(`${from}>${to}`);
      this.edges.push({ from, to, kind: EDGE_KINDS.includes(e.kind as GraphEdgeKind) ? (e.kind as GraphEdgeKind) : "uses" });
    }
  }
}

/** The node's place in the document. A quote is kept only when it really is in the text. */
function docSource(n: { section: string; quote: string }, text: string, flat: string, file: string | undefined): GraphSource | null {
  const section = n.section.trim() || undefined;
  const quote = n.quote.trim();
  if (quote && flat.includes(squash(quote))) {
    const at = file ? lineOf(text, quote) : undefined;
    return { section, quote, ...(file ? { file, line: at } : {}) };
  }
  return section ? { section, ...(file ? { file } : {}) } : null;
}

/** 1-based line of the quote's first words, matched loosely across line breaks. */
function lineOf(text: string, quote: string): number | undefined {
  const head = quote.replace(/\s+/g, " ").slice(0, 12).trim();
  const i = text.replace(/[ \t]+/g, " ").indexOf(head);
  return i < 0 ? undefined : text.slice(0, i).split("\n").length;
}

const squash = (s: string) => s.replace(/[\s　*_`#>|-]+/g, "").toLowerCase();

/** Splits at headings or blank lines near the limit, so parts don't cut a section mid-sentence. */
function splitDoc(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n#");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** The reply's JSON object, tolerating code fences or a sentence around it. */
function parseJson<T extends z.ZodTypeAny>(raw: string, schema: T): z.infer<T> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回有效的图谱数据，请重试");
  try {
    return schema.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    throw new Error("模型返回的图谱格式不对，请重试");
  }
}
