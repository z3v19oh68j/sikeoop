import { useEffect, useState } from "react";
import type { PaperDoc, PaperSummary, PaperTask, PaperTranslation } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge } from "../settings/ui";
import { MoreMenu } from "../plugins/ui";
import { LIVE_TASK, TaskBar, authorsText, cleanError, sourceText } from "./common";

const SUMMARY_FIELDS: { key: keyof PaperSummary; label: string }[] = [
  { key: "problem", label: "研究问题" },
  { key: "method", label: "方法" },
  { key: "results", label: "主要结论" },
  { key: "experiments", label: "数据与实验" },
  { key: "limitations", label: "局限" },
  { key: "related", label: "和相关工作的关系" },
];

const CHUNK: Record<PaperTranslation["chunks"][number]["status"], string> = { queued: "排队中", running: "翻译中", done: "完成", failed: "失败" };

interface Props {
  papers: PaperDoc[];
  tasks: PaperTask[];
  /** Bumped when a paper's summary or translation changed (from onPaperEvent). */
  version: Record<string, number>;
  translations: Record<string, PaperTranslation>;
  onArxiv(): void;
}

/** 读论文: the list on the left, the picked paper's summary / translation on the right. */
export function ReadTab({ papers, tasks, version, translations, onArxiv }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const selected = papers.find((p) => p.id === selectedId) ?? papers[0] ?? null;

  async function pick() {
    setError("");
    setBusy("正在读取 PDF…");
    try {
      const added = await window.sweet.paperPickPdf();
      if (added[0]) setSelectedId(added[0].id);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="pp-read">
      <aside className="pp-list rs-card">
        <div className="pp-list-actions">
          <button type="button" className="send rs-accent" onClick={() => void pick()} disabled={!!busy}>
            <Icon name="folder-open" /> 导入 PDF
          </button>
          <button type="button" className="mini-btn" onClick={onArxiv}>
            <Icon name="globe" /> 从 arXiv 添加
          </button>
        </div>
        {busy && <p className="hint">{busy}</p>}
        {error && <p className="err-text">{error}</p>}
        {papers.length === 0 ? (
          <p className="hint pp-empty">还没有论文。导入一份 PDF，或者从 arXiv 添加。</p>
        ) : (
          <ul>
            {papers.map((p) => (
              <li key={p.id} className={"pp-paper" + (p.id === selected?.id ? " on" : "")}>
                <button type="button" className="pp-paper-main" onClick={() => setSelectedId(p.id)} aria-current={p.id === selected?.id ? "true" : undefined}>
                  <span className="pp-paper-title">{p.title}</span>
                  <span className="pp-paper-meta">
                    <span className={"pp-src " + p.source.kind}>{p.source.kind === "arxiv" ? "arXiv" : "本地"}</span>
                    {p.pages} 页 · {authorsText(p.authors, 2) || "作者未知"}
                  </span>
                </button>
                <MoreMenu name={p.title.slice(0, 20)} items={[{ label: "移除", icon: "trash", danger: true, onClick: () => void window.sweet.paperDelete(p.id) }]} />
              </li>
            ))}
          </ul>
        )}
      </aside>

      {selected ? (
        <PaperDetail
          key={selected.id}
          paper={selected}
          tasks={tasks.filter((t) => t.paperIds.includes(selected.id) && t.kind !== "extract")}
          version={version[selected.id] ?? 0}
          liveTranslation={translations[selected.id]}
        />
      ) : (
        <div className="rs-card pp-placeholder">
          <Icon name="book" />
          <p>导入论文后，可以生成结构化总结、全文中英对照翻译，再转成深度科研用的证据库。</p>
        </div>
      )}
    </div>
  );
}

function PaperDetail({ paper, tasks, version, liveTranslation }: { paper: PaperDoc; tasks: PaperTask[]; version: number; liveTranslation?: PaperTranslation }) {
  const [summary, setSummary] = useState<PaperSummary | undefined>();
  const [translation, setTranslation] = useState<PaperTranslation | undefined>();
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [view, setView] = useState<"summary" | "translation">("summary");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.paperGet(paper.id).then((r) => {
      setSummary(r?.summary);
      setTranslation(r?.translation);
    });
  }, [paper.id, version]);
  useEffect(() => {
    if (liveTranslation) setTranslation(liveTranslation);
  }, [liveTranslation]);

  const summarizing = tasks.find((t) => t.kind === "summarize" && LIVE_TASK.has(t.status));
  const translating = tasks.find((t) => t.kind === "translate" && LIVE_TASK.has(t.status));
  const lastTask = [...tasks].reverse().find((t) => t.kind === (view === "summary" ? "summarize" : "translate"));

  async function run(fn: () => Promise<unknown>) {
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const failed = translation?.chunks.filter((c) => c.status === "failed").length ?? 0;

  return (
    <section className="rs-card pp-detail">
      <header className="pp-detail-head">
        <div>
          <h3>{paper.title}</h3>
          <p className="hint">
            {authorsText(paper.authors, 6) || "作者未知"} · {sourceText(paper)} · {paper.pages} 页
            {paper.arxiv && (
              <>
                {" · "}
                <a href={paper.arxiv.absUrl} target="_blank" rel="noreferrer">
                  arXiv 页面
                </a>
              </>
            )}
          </p>
        </div>
        <button type="button" className="mini-btn" onClick={() => void run(async () => setNote(`已导出到 ${await window.sweet.paperExport(paper.id)}`))}>
          <Icon name="file" /> 导出 Markdown
        </button>
      </header>
      {note && <p className="ok-text">{note}</p>}
      {error && <p className="err-text">{error}</p>}

      <div className="pp-subtabs">
        <div className="seg" role="tablist" aria-label="论文内容">
          <button type="button" role="tab" aria-selected={view === "summary"} className={view === "summary" ? "on" : undefined} onClick={() => setView("summary")}>
            结构化总结
          </button>
          <button type="button" role="tab" aria-selected={view === "translation"} className={view === "translation" ? "on" : undefined} onClick={() => setView("translation")}>
            全文对照翻译
          </button>
        </div>
      </div>

      {lastTask && (LIVE_TASK.has(lastTask.status) || lastTask.status === "failed") && <TaskBar task={lastTask} />}

      {view === "summary" ? (
        summary ? (
          <div className="pp-summary">
            <p className="pp-oneline">
              <span className="rs-label">一句话</span>
              {summary.oneLine}
            </p>
            <dl>
              {SUMMARY_FIELDS.map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{summary[f.key] || "（没有提到）"}</dd>
                </div>
              ))}
            </dl>
            <div className="rs-actions">
              <span className="hint">由模型根据原文生成，引用数字前最好对照原文核实。</span>
              <span className="spacer" />
              <button type="button" className="mini-btn" disabled={!!summarizing} onClick={() => void run(() => window.sweet.paperSummarize(paper.id))}>
                <Icon name="refresh" /> 重新生成
              </button>
            </div>
          </div>
        ) : (
          <div className="pp-empty-card">
            <p>还没有总结。会按研究问题、方法、结论、实验、局限、相关工作几个方面整理这篇论文。</p>
            <button type="button" className="send rs-accent" disabled={!!summarizing} onClick={() => void run(() => window.sweet.paperSummarize(paper.id))}>
              {summarizing ? "生成中…" : "生成总结"}
            </button>
          </div>
        )
      ) : (
        <div className="pp-translation">
          <div className="rs-actions">
            <span className="rs-label">翻译成</span>
            <div className="seg" role="radiogroup" aria-label="翻译成">
              {(["zh", "en"] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={lang === l} className={lang === l ? "on" : undefined} onClick={() => setLang(l)}>
                  {l === "zh" ? "中文" : "English"}
                </button>
              ))}
            </div>
            <button type="button" className="send rs-accent" disabled={!!translating} onClick={() => void run(() => window.sweet.paperTranslate(paper.id, lang))}>
              {translating ? "翻译中…" : translation ? "重新翻译" : "全文翻译"}
            </button>
            {failed > 0 && !translating && (
              <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.paperTranslate(paper.id, translation!.lang))}>
                <Icon name="refresh" /> 重试失败的 {failed} 段
              </button>
            )}
            <span className="hint">分段并行翻译，用「模型分工」里的子任务模型。</span>
          </div>
          {translation ? (
            <div className="pp-bilingual">
              <div className="pp-bi-head">
                <span>原文</span>
                <span>{translation.lang === "zh" ? "中文译文" : "English"}</span>
              </div>
              {paper.sections.map((s) => {
                const chunks = translation.chunks.filter((c) => c.sectionId === s.id);
                return (
                  <section key={s.id} className="pp-bi-section">
                    <h4>
                      {s.title} <span className="hint">第 {s.page} 页</span>
                    </h4>
                    <div className="pp-bi-row">
                      <div className="pp-bi-src">{s.text}</div>
                      <div className="pp-bi-dst">
                        {chunks.length === 0 && <span className="hint">（这一节没有翻译）</span>}
                        {chunks.map((c, i) =>
                          c.status === "done" ? (
                            <p key={i}>{c.text}</p>
                          ) : (
                            <p key={i} className={"pp-chunk " + c.status}>
                              <StatusBadge tone={c.status === "failed" ? "bad" : c.status === "running" ? "accent" : "muted"}>{CHUNK[c.status]}</StatusBadge>
                              {c.status === "failed" && <span className="hint">{c.error || "这一段没翻成"}</span>}
                            </p>
                          ),
                        )}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="hint pp-empty">选好语言后点「全文翻译」，按章节左右对照显示。</p>
          )}
        </div>
      )}
    </section>
  );
}
