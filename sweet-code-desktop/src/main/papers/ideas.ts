import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EvidenceRecord, EvidenceRepoFile, IdeaEvent, IdeaRequest, IdeaRun, IdeaSettings, PaperDoc, PaperSummary, ResearchHandoff, ResearchIdea } from "@shared/types";
import { ModelExecutor } from "../dispatch/model.ts";
import type { Dispatcher } from "../dispatch/scheduler.ts";
import { safeName } from "./evidence.ts";
import { IDEAS_SYSTEM, backgroundOf, ideaRecord, ideaResearchSeed, ideasMarkdown, ideasPrompt, noveltyPrompt, parseIdeas, parseNovelty, queriesOf } from "./ideas-parse.ts";
import { ScholarSearch } from "./openalex.ts";

// Topic ideas and the novelty check (docs/方案-论文工坊.md §7.2): a model proposes ideas for a
// research direction, and each idea can be checked against OpenAlex for close work. Every model
// call is a `model` job on the dispatch core; the calls of one run are one tree. Going online
// happens only after the user has read, once, what is searched and where.

export interface IdeasDeps {
  userData(): string;
  root(): string;
  dispatcher: Pick<Dispatcher, "submit" | "cancel">;
  /** One streamed call to the workshop's model. */
  model(system: string, input: string, delta: (text: string) => void, signal: AbortSignal): Promise<string>;
  paper(id: string): Promise<{ paper: PaperDoc; summary?: PaperSummary } | null>;
  fetch: typeof fetch;
  semanticScholarKey(): string | undefined;
  evidenceFiles(): Promise<EvidenceRepoFile[]>;
  loadEvidence(relative: string): Promise<EvidenceRecord[]>;
  saveEvidence(name: string, records: EvidenceRecord[]): Promise<EvidenceRepoFile>;
  /** Asks before a file is added to the project. */
  approveExport(file: string, content: string): Promise<boolean>;
  /** Writes a new file inside the project; fails when it exists. */
  writeNewProjectFile(relative: string, content: string): Promise<void>;
  emit(event: IdeaEvent): void;
  /** Waits between searches (replaced in tests). */
  sleep?(ms: number): Promise<void>;
}

const RUN_ID = /^[a-f0-9-]{36}$/;
const LIVE = new Set<IdeaRun["status"]>(["queued", "running"]);

function runId(v: unknown): string {
  if (typeof v !== "string" || !RUN_ID.test(v)) throw new Error("选题记录编号不正确");
  return v;
}

export class IdeasService {
  private readonly deps: IdeasDeps;
  private readonly scholar: ScholarSearch;
  /** Runs being generated in this process, and the root job of each run's tree. */
  private readonly live = new Map<string, { root: string; run: IdeaRun }>();
  private readonly rootJobs = new Map<string, string>();
  /** Runs with a novelty check going. */
  private readonly checking = new Set<string>();
  /** Each run's writes, one after another; a deleted run is not written again. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();

  constructor(deps: IdeasDeps) {
    this.deps = deps;
    this.scholar = new ScholarSearch({
      fetch: deps.fetch,
      consent: () => this.consent(),
      mailto: async () => (await this.settings()).mailto,
      semanticScholarKey: deps.semanticScholarKey,
      sleep: deps.sleep,
    });
  }

  // ---- stored state ----

  private file(root: string, id: string): string {
    return path.join(this.deps.userData(), "paper-ideas", createHash("sha256").update(root).digest("hex").slice(0, 16), `${id}.json`);
  }

  private async write(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async read(root: string, id: string): Promise<IdeaRun | null> {
    const going = this.live.get(id);
    if (going) return going.root === root ? structuredClone(going.run) : null;
    const run = await this.readJson<IdeaRun>(this.file(root, id));
    if (!run) return null;
    if (LIVE.has(run.status)) return { ...run, status: "failed", error: "sikeoop 关闭时还没生成完，可以重新开始一次" };
    // A check cut short by a quit is not left spinning.
    for (const idea of run.ideas) if (idea.novelty?.status === "checking" && !this.checking.has(id)) idea.novelty = { ...idea.novelty, status: "failed", error: "检查被中断了，可以再查一次" };
    return run;
  }

  private async put(root: string, run: IdeaRun): Promise<void> {
    this.deps.emit({ type: "run", run: structuredClone(run) });
    const snapshot = structuredClone(run);
    const next = (this.writes.get(run.id) ?? Promise.resolve()).then(() => (this.deleted.has(run.id) ? undefined : this.write(this.file(root, run.id), snapshot))).catch(() => {});
    this.writes.set(run.id, next);
    await next;
  }

  async list(): Promise<IdeaRun[]> {
    const root = this.deps.root();
    const names = await fs.readdir(path.dirname(this.file(root, "x"))).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter((n) => n.endsWith(".json") && RUN_ID.test(n.slice(0, -5))).map((n) => this.read(root, n.slice(0, -5))));
    return runs.filter((r): r is IdeaRun => !!r).sort((a, b) => b.startedAt - a.startedAt);
  }

  async consent(): Promise<boolean> {
    return (await this.readJson<{ agreed: boolean }>(path.join(this.deps.userData(), "papers-openalex-consent.json")))?.agreed === true;
  }

  async grantConsent(): Promise<void> {
    await this.write(path.join(this.deps.userData(), "papers-openalex-consent.json"), { agreed: true, at: Date.now() });
  }

  async settings(): Promise<IdeaSettings> {
    const saved = await this.readJson<{ mailto?: unknown }>(path.join(this.deps.userData(), "papers-ideas-settings.json"));
    return { mailto: typeof saved?.mailto === "string" ? saved.mailto : "", semanticScholar: !!this.deps.semanticScholarKey() };
  }

  async setSettings(patch: unknown): Promise<IdeaSettings> {
    const mailto = (patch as { mailto?: unknown } | null)?.mailto;
    if (mailto !== undefined) {
      if (typeof mailto !== "string" || mailto.length > 200 || (mailto.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailto.trim()))) throw new Error("邮箱格式不对；不想提供就留空");
      await this.write(path.join(this.deps.userData(), "papers-ideas-settings.json"), { mailto: mailto.trim() });
    }
    return this.settings();
  }

  // ---- model calls ----

  /** One model call as a job in the run's tree. Resolves with the reply, or throws why there is none. */
  private async call(runIdOf: string, name: string, input: string): Promise<string> {
    const executor = new ModelExecutor(`ideas:${runIdOf}:${randomUUID().slice(0, 8)}`, "选题", { stream: (_job, delta, signal) => this.deps.model(IDEAS_SYSTEM, input, delta, signal) });
    const sub = this.deps.dispatcher.submit({ executor, input: name, origin: "user", from: "论文工坊 · 选题", parentId: this.rootJobs.get(runIdOf) });
    if ("error" in sub) throw new Error(sub.error);
    if (!this.rootJobs.has(runIdOf)) this.rootJobs.set(runIdOf, sub.job.id);
    const job = await sub.done;
    if (job.status !== "done") throw new Error(job.error ?? (job.status === "cancelled" ? "已取消" : job.status === "timeout" ? "等太久了，已停下" : "没有拿到回复"));
    return job.result?.text ?? "";
  }

  async start(input: unknown): Promise<IdeaRun> {
    const root = this.deps.root();
    if (!input || typeof input !== "object") throw new Error("选题请求格式不正确");
    const req = input as IdeaRequest;
    if (typeof req.direction !== "string" || !req.direction.trim() || req.direction.length > 2000) throw new Error("请写下研究方向（2000 字以内）");
    if (!Number.isInteger(req.count) || req.count < 1 || req.count > 10) throw new Error("一次生成 1 到 10 个点子");
    if (!Array.isArray(req.paperIds) || req.paperIds.length > 10 || !req.paperIds.every((id) => typeof id === "string")) throw new Error("背景论文最多选 10 篇");
    const background: string[] = [];
    for (const id of new Set(req.paperIds)) {
      const found = await this.deps.paper(id);
      if (!found) throw new Error("有背景论文不在工坊里了，请重新选择");
      background.push(backgroundOf(found.paper, found.summary));
    }
    const run: IdeaRun = { id: randomUUID(), direction: req.direction.trim(), paperIds: [...new Set(req.paperIds)], status: "running", startedAt: Date.now(), ideas: [] };
    this.live.set(run.id, { root, run });
    await this.put(root, run);

    void (async () => {
      try {
        const reply = await this.call(run.id, `选题：${run.direction.slice(0, 80)}`, ideasPrompt(run.direction, req.count, background));
        if (run.status === "running") {
          run.ideas = parseIdeas(reply, req.count, () => randomUUID());
          if (!run.ideas.length) throw new Error("模型没有给出可用的点子，请换个说法再试");
          run.status = "done";
        }
      } catch (err) {
        if (run.status === "running") {
          run.status = "failed";
          run.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        run.endedAt = Date.now();
        // Listed as going until its end is on disk: read from disk before that, it would look cut off by a quit.
        await this.put(root, run);
        this.live.delete(run.id);
      }
    })();
    return structuredClone(run);
  }

  /** Stops generating, and a novelty check after the idea it is on. */
  cancel(id: unknown): void {
    const key = runId(id);
    const going = this.live.get(key);
    if (going && going.root === this.deps.root()) going.run.status = "cancelled";
    this.checking.delete(key);
    const rootJob = this.rootJobs.get(key);
    if (rootJob) this.deps.dispatcher.cancel(rootJob);
  }

  async delete(id: unknown): Promise<void> {
    const root = this.deps.root();
    const key = runId(id);
    this.cancel(key);
    // A write that is under way finishes first, so it can't put the file back after it is removed.
    this.deleted.add(key);
    await this.writes.get(key);
    await fs.rm(this.file(root, key), { force: true });
    this.writes.delete(key);
    this.rootJobs.delete(key);
    this.deps.emit({ type: "removed", id: key });
  }

  /**
   * Checks one idea (or all of a run's) against the literature: searches for its phrases, then
   * asks the model whether what was found is the same work. With nothing found the answer is
   * "unseen" without asking the model.
   */
  async check(id: unknown, ideaId?: unknown): Promise<IdeaRun> {
    const root = this.deps.root();
    const run = await this.read(root, runId(id));
    if (!run) throw new Error("没有找到这次选题");
    if (run.status !== "done") throw new Error("点子还没生成完");
    if (!(await this.consent())) throw new Error("请先阅读并同意联网检索的说明");
    if (this.checking.has(run.id)) throw new Error("这次选题正在检查，等它查完");
    const targets = run.ideas.filter((i) => (ideaId === undefined ? true : i.id === ideaId));
    if (!targets.length) throw new Error("没有找到这个点子");
    this.checking.add(run.id);
    // Each check is a job tree of its own: checking again later doesn't run into the budget of an earlier tree.
    this.rootJobs.delete(run.id);
    try {
      for (const idea of targets) {
        if (!this.checking.has(run.id)) break;
        const queries = queriesOf(idea);
        idea.novelty = { status: "checking", works: [], queries };
        await this.put(root, run);
        try {
          const works = await this.scholar.search(queries);
          if (!works.length) {
            idea.novelty = { status: "done", verdict: "unseen", reason: "文献库里没有检索到相近的论文。这只说明没搜到，不等于一定没人做过；可以换几个检索词再查。", works: [], queries, checkedAt: Date.now() };
          } else {
            const judged = parseNovelty(await this.call(run.id, `查新：${idea.title.slice(0, 80)}`, noveltyPrompt(idea, works)), works.length);
            if (!judged) throw new Error("模型没有给出可用的判断，请再查一次");
            // The works the judgement leaned on come first.
            const order = [...judged.closest, ...works.map((_, i) => i).filter((i) => !judged.closest.includes(i))];
            idea.novelty = { status: "done", verdict: judged.verdict, reason: judged.reason, works: order.map((i) => works[i]), queries, checkedAt: Date.now() };
          }
        } catch (err) {
          idea.novelty = { status: "failed", works: [], queries, error: err instanceof Error ? err.message : String(err) };
        }
        await this.put(root, run);
      }
    } finally {
      this.checking.delete(run.id);
    }
    return run;
  }

  // ---- handing ideas on ----

  private async ideas(id: unknown, ideaIds: unknown): Promise<{ run: IdeaRun; ideas: ResearchIdea[] }> {
    const run = await this.read(this.deps.root(), runId(id));
    if (!run) throw new Error("没有找到这次选题");
    const wanted = Array.isArray(ideaIds) ? ideaIds : [ideaIds];
    const ideas = run.ideas.filter((i) => wanted.includes(i.id));
    if (!ideas.length) throw new Error("没有找到这些点子");
    return { run, ideas };
  }

  /** Adds ideas to research/<name>.repository.json as draft records; an idea already there is replaced. */
  async toEvidence(id: unknown, ideaIds: unknown, name: unknown): Promise<EvidenceRepoFile> {
    const { ideas } = await this.ideas(id, ideaIds);
    const clean = safeName(typeof name === "string" ? name : "");
    const fresh = ideas.map(ideaRecord);
    const target = `research/${clean}.repository.json`;
    const existing = (await this.deps.evidenceFiles()).some((f) => f.path === target) ? await this.deps.loadEvidence(target) : [];
    const refs = new Set(fresh.map((r) => r.ref));
    return this.deps.saveEvidence(clean, [...existing.filter((r) => !refs.has(r.ref)), ...fresh]);
  }

  async toResearch(id: unknown, ideaId: unknown): Promise<ResearchHandoff> {
    const { ideas } = await this.ideas(id, ideaId);
    const seed = ideaResearchSeed(ideas[0]);
    const file = await this.deps.saveEvidence(seed.name, seed.records);
    return { path: file.path, question: seed.question };
  }

  /** Writes a run's ideas as Markdown into the project, after asking. Returns the path. */
  async export(id: unknown): Promise<string> {
    const run = await this.read(this.deps.root(), runId(id));
    if (!run?.ideas.length) throw new Error("没有可导出的点子");
    const relative = `research/ideas-${safeName(run.direction.slice(0, 40))}-${run.id.slice(0, 8)}.md`;
    const text = ideasMarkdown(run);
    if (!(await this.deps.approveExport(relative, text))) throw new Error("你取消了导出，文件没有改动");
    await this.deps.writeNewProjectFile(relative, text);
    return relative;
  }
}
