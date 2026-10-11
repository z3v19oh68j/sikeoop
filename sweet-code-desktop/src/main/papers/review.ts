import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EvidenceRecord, EvidenceRepoFile, PaperDoc, ResearchHandoff, ReviewEvent, ReviewReport, ReviewRequest, ReviewRun, ReviewerModel } from "@shared/types";
import { ModelExecutor } from "../dispatch/model.ts";
import type { Dispatcher } from "../dispatch/scheduler.ts";
import { MAX_MANUSCRIPT, REVIEW_SYSTEM, parseReview, reflectPrompt, reviewPrompt } from "./review-parse.ts";
import { polishNote, relatedPassage, researchSeed, summarize } from "./review-summary.ts";

// Simulated peer review (docs/方案-论文工坊.md §7.1): two to five models each fill in a review form
// for a manuscript, optionally look at their own report again, and the reports are put together.
// Every model call is a `model` job on the dispatch core; the calls of one review are one tree
// (the first call is its root), so cancelling the root stops the review. Runs are kept per project
// under userData. No Electron here: models, files and the window are handed in.

export interface ReviewDeps {
  userData(): string;
  root(): string;
  dispatcher: Pick<Dispatcher, "submit" | "cancel">;
  /** The models that may review: providers with a key. */
  candidates(): ReviewerModel[];
  /** One streamed call to that model. */
  call(reviewer: ReviewerModel, system: string, input: string, delta: (text: string) => void, signal: AbortSignal): Promise<string>;
  /** A paper in the workshop. */
  paper(id: string): Promise<PaperDoc | null>;
  /** The text of a file inside the project (path relative to it). */
  readProjectFile(relative: string): Promise<string>;
  /** Saves records as research/<name>.repository.json. */
  saveEvidence(name: string, records: EvidenceRecord[]): Promise<EvidenceRepoFile>;
  emit(event: ReviewEvent): void;
}

/** A review while it is going on. */
interface Going {
  root: string;
  run: ReviewRun;
  /** The first model call: the root of the review's job tree. */
  rootJob?: string;
  /** Deleted meanwhile: nothing more is written for it. */
  deleted?: boolean;
  /** The run's writes, one after another. */
  writes?: Promise<void>;
}

const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_TEXT = 1_000_000;
const LIVE = new Set<ReviewRun["status"]>(["queued", "running"]);

function runId(v: unknown): string {
  if (typeof v !== "string" || !RUN_ID.test(v)) throw new Error("审稿记录编号不正确");
  return v;
}

export class ReviewService {
  private readonly deps: ReviewDeps;
  /** Reviews going on in this process: the run as it is now, and the root job to cancel. */
  private readonly live = new Map<string, Going>();

  constructor(deps: ReviewDeps) {
    this.deps = deps;
  }

  candidates(): ReviewerModel[] {
    return this.deps.candidates();
  }

  private base(root: string): string {
    return path.join(this.deps.userData(), "paper-reviews", createHash("sha256").update(root).digest("hex").slice(0, 16));
  }

  private async save(root: string, run: ReviewRun): Promise<void> {
    const dir = path.join(this.base(root), run.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `run.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(run, null, 2), { mode: 0o600 });
    await fs.rename(tmp, path.join(dir, "run.json"));
  }

  private async read(root: string, id: string): Promise<ReviewRun | null> {
    const going = this.live.get(id);
    if (going) return going.root === root ? structuredClone(going.run) : null;
    try {
      const run = JSON.parse(await fs.readFile(path.join(this.base(root), id, "run.json"), "utf8")) as ReviewRun;
      // Stored as going but nothing is running it: sikeoop closed before it finished.
      if (LIVE.has(run.status)) return { ...run, status: "failed", error: "sikeoop 关闭时还没审完，可以重新开始一次", endedAt: run.endedAt ?? run.startedAt };
      return run;
    } catch {
      return null;
    }
  }

  async list(): Promise<ReviewRun[]> {
    const root = this.deps.root();
    const names = await fs.readdir(this.base(root)).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter((n) => RUN_ID.test(n)).map((n) => this.read(root, n)));
    return runs.filter((r): r is ReviewRun => !!r).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: unknown): Promise<ReviewRun | null> {
    return this.read(this.deps.root(), runId(id));
  }

  /** The manuscript a request points at: a workshop paper, a .tex / .md file of the project, or pasted text. */
  private async manuscript(source: ReviewRequest["source"]): Promise<{ title: string; text: string; source: ReviewRun["source"] }> {
    if (!source || typeof source !== "object") throw new Error("请选择要审的稿件");
    if (source.kind === "paper") {
      const paper = typeof source.paperId === "string" ? await this.deps.paper(source.paperId) : null;
      if (!paper) throw new Error("这篇论文不在工坊里了，请重新导入");
      return { title: paper.title, text: paper.sections.map((s) => `## ${s.title}\n${s.text}`).join("\n\n"), source: { kind: "paper", paperId: paper.id } };
    }
    if (source.kind === "file") {
      if (typeof source.path !== "string" || !/\.(?:tex|md|markdown|txt)$/i.test(source.path)) throw new Error("请选择项目里的 .tex、.md 或 .txt 文件");
      return { title: path.basename(source.path), text: await this.deps.readProjectFile(source.path), source: { kind: "file", path: source.path } };
    }
    if (source.kind === "text") {
      if (typeof source.text !== "string") throw new Error("请粘贴要审的稿件");
      const title = typeof source.title === "string" && source.title.trim() ? source.title.trim().slice(0, 200) : "粘贴的稿件";
      return { title, text: source.text, source: { kind: "text" } };
    }
    throw new Error("稿件来源不正确");
  }

  async start(input: unknown): Promise<ReviewRun> {
    const root = this.deps.root();
    if (!input || typeof input !== "object") throw new Error("审稿请求格式不正确");
    const req = input as ReviewRequest;
    if (!Number.isInteger(req.reflections) || req.reflections < 0 || req.reflections > 3) throw new Error("自我反思轮数只能是 0 到 3");
    if (!Array.isArray(req.reviewers) || req.reviewers.length < 2 || req.reviewers.length > 5) throw new Error("请选择 2 到 5 位审稿人");
    const offered = this.deps.candidates();
    const reviewers = req.reviewers.map((r) => {
      const found = r && offered.find((c) => c.providerId === r.providerId && c.model === r.model);
      if (!found) throw new Error("有审稿人用的模型现在不可用，请重新选择");
      return found;
    });
    if (new Set(reviewers.map((r) => `${r.providerId}\n${r.model}`)).size !== reviewers.length) throw new Error("同一个模型只能当一位审稿人");
    const paper = await this.manuscript(req.source);
    if (!paper.text.trim()) throw new Error("稿件是空的");
    if (paper.text.length > MAX_TEXT) throw new Error("稿件太长了");
    const given = paper.text.slice(0, MAX_MANUSCRIPT);

    const run: ReviewRun = {
      id: randomUUID(),
      title: paper.title,
      source: paper.source,
      chars: given.length,
      truncated: paper.text.length > MAX_MANUSCRIPT,
      reflections: req.reflections,
      status: "running",
      done: 0,
      total: reviewers.length * (1 + req.reflections),
      startedAt: Date.now(),
      reports: reviewers.map((reviewer) => ({ reviewer, status: "queued", reflected: 0 })),
    };
    const entry: Going = { root, run };
    this.live.set(run.id, entry);
    await this.save(root, run);
    // Kept beside the run: a weakness is later matched to the passage it is about.
    await fs.writeFile(path.join(this.base(root), run.id, "text.txt"), given, { mode: 0o600 });
    this.deps.emit({ type: "run", run: structuredClone(run) });

    void this.work(entry, given);
    return structuredClone(run);
  }

  /** Runs every reviewer (side by side), each through its rounds, then puts the reports together. */
  private async work(entry: Going, text: string): Promise<void> {
    const { run, root } = entry;
    // Reviewers finish in any order: each state is written whole, one after another, so an older
    // one can't land on top of a newer one.
    const progress = () => {
      const snapshot = structuredClone(run);
      this.deps.emit({ type: "run", run: snapshot });
      entry.writes = (entry.writes ?? Promise.resolve()).then(() => (entry.deleted ? undefined : this.save(root, snapshot))).catch(() => {});
      return entry.writes;
    };
    const ask = (report: ReviewReport, index: number, prompt: string): Promise<string | { failed: string }> => {
      const executor = new ModelExecutor(`review:${run.id}:${index}`, report.reviewer.model, {
        begin: () => {
          if (report.status === "queued") report.status = "running";
          void progress();
        },
        stream: (_job, delta, signal) => this.deps.call(report.reviewer, REVIEW_SYSTEM, prompt, delta, signal),
      });
      const sub = this.deps.dispatcher.submit({ executor, input: `审稿：${run.title}`, origin: "user", from: "模拟审稿", parentId: entry.rootJob });
      if ("error" in sub) return Promise.resolve({ failed: sub.error });
      // The first call handed out is the tree's root: cancelling it stops every other call.
      entry.rootJob ??= sub.job.id;
      return sub.done.then((job) => (job.status === "done" ? (job.result?.text ?? "") : { failed: job.error ?? ENDED[job.status] ?? "没有拿到回复" }));
    };

    // Asked again after every wait: it may have been cancelled meanwhile.
    const cancelled = () => (run.status as ReviewRun["status"]) === "cancelled";
    await Promise.all(
      run.reports.map(async (report, index) => {
        let previous = "";
        for (let round = 0; round <= run.reflections; round++) {
          if (cancelled()) return;
          const reply = await ask(report, index, round === 0 ? reviewPrompt(run.title, text, run.truncated) : reflectPrompt(run.title, text, run.truncated, previous));
          if (cancelled()) return;
          const parsed = typeof reply === "string" ? parseReview(reply) : null;
          if (!parsed) {
            // The first round failing leaves no report; a later one failing keeps the report it had.
            if (round === 0) {
              report.status = "failed";
              report.error = typeof reply === "string" ? "没有返回可用的审稿结果" : reply.failed;
            }
            run.total -= run.reflections - round;
            run.done++;
            await progress();
            return;
          }
          Object.assign(report, parsed, { status: "done", reflected: round });
          previous = JSON.stringify(parsed, null, 2);
          run.done++;
          await progress();
        }
      }),
    );

    if (!cancelled()) {
      const usable = run.reports.filter((r) => r.status === "done").length;
      if (usable) {
        run.status = "done";
        run.summary = summarize(run.reports);
      } else {
        run.status = "failed";
        run.error = "审稿人都没有返回可用的结果：" + [...new Set(run.reports.map((r) => r.error).filter(Boolean))].join("；");
      }
    }
    for (const r of run.reports) if (r.status === "queued" || r.status === "running") Object.assign(r, { status: "failed", error: "已取消" });
    run.endedAt = Date.now();
    // Listed as going until its end is on disk: read from disk before that, it would look cut off by a quit.
    await progress();
    this.live.delete(run.id);
  }

  cancel(id: unknown): void {
    const entry = this.live.get(runId(id));
    if (!entry || entry.root !== this.deps.root()) return;
    entry.run.status = "cancelled";
    if (entry.rootJob) this.deps.dispatcher.cancel(entry.rootJob);
  }

  async delete(id: unknown): Promise<void> {
    const root = this.deps.root();
    const key = runId(id);
    const going = this.live.get(key);
    if (going?.root === root) going.deleted = true;
    this.cancel(key);
    // A write that is under way finishes first, so it can't put the record back after it is removed.
    await going?.writes;
    await fs.rm(path.join(this.base(root), key), { recursive: true, force: true });
    this.deps.emit({ type: "removed", id: key });
  }

  /** The passage a merged weakness is about, and what to ask 写作与润色 to do with it. */
  async polishSeed(id: unknown, index: unknown): Promise<{ text: string; note: string }> {
    const root = this.deps.root();
    const run = await this.read(root, runId(id));
    const weakness = typeof index === "number" ? run?.summary?.weaknesses[index] : undefined;
    if (!run?.summary || !weakness) throw new Error("没有找到这条缺点");
    const text = await fs.readFile(path.join(this.base(root), run.id, "text.txt"), "utf8").catch(() => "");
    return { text: relatedPassage(text, weakness), note: polishNote(weakness, run.summary.reports) };
  }

  /** A weakness or a disagreement as a question plus an evidence repository for deep research. */
  async toResearch(id: unknown, target: unknown): Promise<ResearchHandoff> {
    const run = await this.read(this.deps.root(), runId(id));
    const t = target as { kind?: string; index?: unknown; id?: unknown } | null;
    const seed =
      run && t?.kind === "weakness" && typeof t.index === "number"
        ? researchSeed(run, { kind: "weakness", index: t.index })
        : run && t?.kind === "dispute" && typeof t.id === "string"
          ? researchSeed(run, { kind: "dispute", id: t.id })
          : null;
    if (!seed) throw new Error("没有找到要研判的这一条");
    const file = await this.deps.saveEvidence(seed.name, seed.records);
    return { path: file.path, question: seed.question };
  }
}

const ENDED: Record<string, string> = { cancelled: "已取消", timeout: "等太久了，已停下", exited: "已退出" };
