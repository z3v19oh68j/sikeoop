import { useEffect, useMemo, useState } from "react";
import type { PaperDoc, PaperReviewDecision, ResearchHandoff, ReviewReport, ReviewRequest, ReviewRun, ReviewerModel } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, type Tone } from "../settings/ui";
import { cleanError } from "./common";

const DECISION: Record<PaperReviewDecision, { text: string; tone: Tone }> = {
  accept: { text: "接收", tone: "ok" },
  minor: { text: "小修", tone: "accent" },
  major: { text: "大修", tone: "warn" },
  reject: { text: "拒绝", tone: "bad" },
};
const RUN_STATUS: Record<ReviewRun["status"], { text: string; tone: Tone }> = {
  queued: { text: "排队中", tone: "muted" },
  running: { text: "审稿中", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  failed: { text: "失败", tone: "bad" },
  cancelled: { text: "已取消", tone: "muted" },
};
const REPORT_STATUS: Record<ReviewReport["status"], string> = { queued: "排队中", running: "在审", done: "审完了", failed: "没审成" };
const SUB = [
  ["originality", "原创性"],
  ["quality", "质量"],
  ["clarity", "清晰度"],
  ["significance", "重要性"],
] as const;
const live = (r: ReviewRun) => r.status === "queued" || r.status === "running";
const keyOf = (m: ReviewerModel) => `${m.providerId}\n${m.model}`;

type SourceKind = ReviewRequest["source"]["kind"];

interface Props {
  papers: PaperDoc[];
  /** Hand a weakness to 写作与润色: the passage it is about and what to change. */
  onPolish(seed: { text: string; note: string }): void;
  /** Open 深度科研 with this evidence repository chosen. */
  /** question: prefilled in deep research when known (review / ideas hand-offs). */
  onStartResearch(path: string, question?: string): void;
}

/**
 * 模拟审稿: two to five models each fill in a review form for a manuscript; the reports are put
 * together (scores, how far apart they are, weaknesses merged), and each weakness can go on to
 * 写作与润色 or to 深度科研.
 */
export function ReviewTab({ papers, onPolish, onStartResearch }: Props) {
  const [candidates, setCandidates] = useState<ReviewerModel[]>([]);
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [kind, setKind] = useState<SourceKind>("paper");
  const [paperId, setPaperId] = useState("");
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [reflections, setReflections] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.reviewCandidates().then(setCandidates);
    void window.sweet.reviewList().then((list) => {
      setRuns(list);
      setOpenId((cur) => cur ?? list[0]?.id ?? null);
    });
    return window.sweet.onReviewEvent((e) => {
      if (e.type === "removed") setRuns((list) => list.filter((r) => r.id !== e.id));
      else setRuns((list) => (list.some((r) => r.id === e.run.id) ? list.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...list]));
    });
  }, []);

  useEffect(() => {
    if (!paperId && papers[0]) setPaperId(papers[0].id);
  }, [papers, paperId]);

  const open = runs.find((r) => r.id === openId) ?? null;
  const ready = kind === "paper" ? !!paperId : kind === "file" ? !!file.trim() : !!text.trim();
  const calls = chosen.length * (1 + reflections);

  function toggle(m: ReviewerModel) {
    const k = keyOf(m);
    setChosen((list) => (list.includes(k) ? list.filter((x) => x !== k) : list.length >= 5 ? list : [...list, k]));
  }

  async function start() {
    setError("");
    setStarting(true);
    try {
      const source: ReviewRequest["source"] = kind === "paper" ? { kind, paperId } : kind === "file" ? { kind, path: file.trim() } : { kind, text };
      const run = await window.sweet.reviewStart({ source, reviewers: candidates.filter((c) => chosen.includes(keyOf(c))), reflections });
      setRuns((list) => (list.some((r) => r.id === run.id) ? list : [run, ...list]));
      setOpenId(run.id);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="pp-review">
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="file" />
          <h3>审哪篇稿子</h3>
          <span className="spacer" />
          <div className="seg" role="radiogroup" aria-label="稿件来源">
            {(
              [
                ["paper", "工坊里的论文"],
                ["file", "项目里的文件"],
                ["text", "粘贴文字"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={kind === id} className={kind === id ? "on" : undefined} onClick={() => setKind(id)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {kind === "paper" &&
          (papers.length ? (
            <select className="rs-select pp-wide" value={paperId} onChange={(e) => setPaperId(e.target.value)} aria-label="要审的论文">
              {papers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          ) : (
            <p className="hint">工坊里还没有论文。先到「读论文」导入一篇，或者换成「粘贴文字」。</p>
          ))}
        {kind === "file" && (
          <>
            <input className="rs-input pp-wide pv-path" value={file} onChange={(e) => setFile(e.target.value)} placeholder="paper/main.tex" aria-label="稿件在项目里的路径" spellCheck={false} />
            <p className="hint">填稿件在项目里的相对路径，支持 .tex、.md、.txt。只读这一个文件，不会改它。</p>
          </>
        )}
        {kind === "text" && <textarea className="rs-textarea pp-input" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="把稿件正文粘贴到这里。" aria-label="稿件正文" />}
        <p className="hint">稿件最多取前 6 万字给审稿人；更长的会注明“只看到前面一部分”。</p>
      </section>

      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="group" />
          <h3>请谁来审</h3>
          <span className="spacer" />
          <span className="hint">已选 {chosen.length} / 5，至少 2 位</span>
        </header>
        {candidates.length < 2 ? (
          <p className="hint">至少要有两个配好 Key 的模型才能模拟审稿。到「设置 → 模型服务商」里再配一家。</p>
        ) : (
          <div className="pv-models">
            {candidates.map((c) => {
              const on = chosen.includes(keyOf(c));
              return (
                <button key={keyOf(c)} type="button" className={"pv-model" + (on ? " on" : "")} aria-pressed={on} disabled={!on && chosen.length >= 5} onClick={() => toggle(c)}>
                  <b>{c.model}</b>
                  <span>{c.providerName}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="hint">尽量选不同家的模型：同一家的模型容易有同样的盲点，意见会更像。</p>
        <div className="rs-actions">
          <span className="rs-label">自我反思</span>
          <div className="seg" role="radiogroup" aria-label="自我反思轮数">
            {[0, 1, 2, 3].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={reflections === n} className={reflections === n ? "on" : undefined} onClick={() => setReflections(n)}>
                {n === 0 ? "不做" : `${n} 轮`}
              </button>
            ))}
          </div>
          <span className="hint">每一轮让审稿人对照稿件检查并修正自己的意见，更稳，也更费。</span>
          <span className="spacer" />
          {chosen.length >= 2 && <span className="hint">共 {calls} 次模型调用</span>}
          <button type="button" className="send rs-accent" disabled={!ready || chosen.length < 2 || starting} onClick={() => void start()}>
            {starting ? "正在开始…" : "开始审稿"}
          </button>
        </div>
        {error && <p className="err-text">{error}</p>}
      </section>

      {runs.length > 0 && (
        <section className="rs-card">
          <header className="rs-card-head">
            <Icon name="history" />
            <h3>审稿记录</h3>
          </header>
          <ul className="pv-runs">
            {runs.map((r) => (
              <li key={r.id} className={r.id === openId ? "on" : undefined}>
                <button type="button" className="pv-run" onClick={() => setOpenId(r.id)}>
                  <b>{r.title}</b>
                  <span className="hint">
                    {new Date(r.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {r.reports.length} 位审稿人
                    {r.summary?.mean != null && ` · 平均 ${r.summary.mean} 分`}
                  </span>
                </button>
                <StatusBadge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].text}</StatusBadge>
                <button type="button" className="icon-btn square" title="删除这次审稿记录" aria-label={`删除 ${r.title} 的审稿记录`} onClick={() => void window.sweet.reviewDelete(r.id)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <RunView run={open} onPolish={onPolish} onStartResearch={onStartResearch} />}
    </div>
  );
}

function RunView({ run, onPolish, onStartResearch }: { run: ReviewRun; onPolish: Props["onPolish"]; onStartResearch: Props["onStartResearch"] }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [handoff, setHandoff] = useState<(ResearchHandoff & { copied: boolean }) | null>(null);
  const s = run.summary;
  const names = useMemo(() => run.reports.map((r) => r.reviewer.model), [run.reports]);

  useEffect(() => {
    setHandoff(null);
    setError("");
  }, [run.id]);

  async function polish(index: number) {
    setError("");
    setBusy(`polish:${index}`);
    try {
      onPolish(await window.sweet.reviewPolishSeed(run.id, index));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy("");
    }
  }

  async function research(key: string, target: Parameters<typeof window.sweet.reviewToResearch>[1]) {
    setError("");
    setBusy(key);
    try {
      const h = await window.sweet.reviewToResearch(run.id, target);
      // The question travels by clipboard: 深度科研 takes the repository from here, the question is pasted there.
      const copied = await navigator.clipboard.writeText(h.question).then(
        () => true,
        () => false,
      );
      setHandoff({ ...h, copied });
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rs-card pv-result" aria-label={`${run.title} 的审稿结果`}>
      <header className="rs-card-head">
        <Icon name="list-check" />
        <h3>{run.title}</h3>
        <StatusBadge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].text}</StatusBadge>
        <span className="spacer" />
        {live(run) && (
          <button type="button" className="mini-btn" onClick={() => void window.sweet.reviewCancel(run.id)}>
            <Icon name="stop" /> 取消
          </button>
        )}
      </header>

      {live(run) && (
        <div role="status" aria-live="polite">
          <div className={"rs-bar" + (run.total ? "" : " indeterminate")} aria-hidden="true">
            <span style={{ transform: `scaleX(${run.total ? Math.min(1, run.done / run.total) : 0})` }} />
          </div>
          <p className="hint">
            已完成 {run.done} / {run.total} 次模型调用{run.reflections > 0 && `（含每人 ${run.reflections} 轮自我反思）`}
          </p>
        </div>
      )}
      {run.error && <p className="err-text">{run.error}</p>}
      {run.truncated && <p className="hint">这篇稿子比较长，审稿人只看到了前 {run.chars.toLocaleString()} 字。</p>}

      {!s && (
        <ul className="pv-progress">
          {run.reports.map((r, i) => (
            <li key={i}>
              <b>{r.reviewer.model}</b>
              <span className="hint">{r.reviewer.providerName}</span>
              <span className="spacer" />
              <span className={r.status === "failed" ? "err-text" : "hint"}>{r.error ?? REPORT_STATUS[r.status]}</span>
            </li>
          ))}
        </ul>
      )}

      {s && (
        <>
          <div className="pv-stats">
            <div className="pv-stat big">
              <b>{s.mean ?? "—"}</b>
              <span>平均总分（满分 10）</span>
            </div>
            <div className="pv-stat">
              <b>{s.spread ?? "—"}</b>
              <span>
                分歧（最高 {s.max ?? "—"} − 最低 {s.min ?? "—"}）
              </span>
            </div>
            {SUB.map(([key, label]) => (
              <div className="pv-stat" key={key}>
                <b>{s.scores[key] ?? "—"}</b>
                <span>{label}（满分 4）</span>
              </div>
            ))}
          </div>
          <div className="pv-decisions">
            <span className="rs-label">建议分布</span>
            {(Object.keys(DECISION) as PaperReviewDecision[])
              .filter((d) => s.decisions[d] > 0)
              .map((d) => (
                <StatusBadge key={d} tone={DECISION[d].tone}>
                  {DECISION[d].text} × {s.decisions[d]}
                </StatusBadge>
              ))}
            <span className="hint">
              {s.reports} / {run.reports.length} 位审稿人给出了可用的意见
            </span>
          </div>

          {handoff && (
            <div className="rs-callout pv-handoff" role="status">
              <span>
                已把各位审稿人的立场存成证据库 <code>{handoff.path}</code>。点下面的按钮，深度科研会自动填好证据库和研究问题。
              </span>
              <blockquote>{handoff.question}</blockquote>
              <div className="rs-actions">
                <span className="hint">证据是模型的意见，不是事实；研判结果只说明哪边的论证更站得住。</span>
                <span className="spacer" />
                <button type="button" className="send rs-accent" onClick={() => onStartResearch(handoff.path, handoff.question)}>
                  去深度科研
                </button>
              </div>
            </div>
          )}
          {error && <p className="err-text">{error}</p>}

          {s.disputes.length > 0 && (
            <div className="pv-block">
              <div className="rs-label">审稿人意见不一的地方</div>
              <ul className="pv-list">
                {s.disputes.map((d) => (
                  <li key={d.id}>
                    <div className="pv-item-main">
                      <b>{d.topic}</b>
                      <p>{d.detail}</p>
                    </div>
                    <button type="button" className="mini-btn" disabled={!!busy} onClick={() => void research(`dispute:${d.id}`, { kind: "dispute", id: d.id })}>
                      {busy === `dispute:${d.id}` ? "正在准备…" : "送去深度研判"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pv-block">
            <div className="rs-label">缺点（意思相近的已合并，提到的人多的排在前面）</div>
            {s.weaknesses.length === 0 ? (
              <p className="hint">审稿人没有列出缺点。</p>
            ) : (
              <ul className="pv-list">
                {s.weaknesses.map((w, i) => (
                  <li key={i}>
                    <div className="pv-item-main">
                      <p className="pv-weak">{w.text}</p>
                      <p className="hint">
                        <span className={"pv-count" + (w.reviewers.length > 1 ? " many" : "")}>{w.reviewers.length} 位审稿人提到</span>
                        {w.reviewers.map((r) => names[r]).join("、")}
                        {w.where && ` · 针对：${w.where}`}
                      </p>
                      {w.variants.length > 0 && (
                        <details className="pv-variants">
                          <summary>另外 {w.variants.length} 种说法</summary>
                          <ul>
                            {w.variants.map((v) => (
                              <li key={v}>{v}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="pv-item-ops">
                      <button type="button" className="mini-btn" disabled={!!busy} onClick={() => void polish(i)} title="到「写作与润色」里改相关的段落">
                        {busy === `polish:${i}` ? "正在找段落…" : "送去润色"}
                      </button>
                      <button type="button" className="mini-btn" disabled={!!busy} onClick={() => void research(`weakness:${i}`, { kind: "weakness", index: i })} title="这条批评成不成立，交给深度科研对抗研判">
                        {busy === `weakness:${i}` ? "正在准备…" : "送去深度研判"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pv-block">
            <div className="rs-label">每位审稿人的意见</div>
            {run.reports.map((r, i) => (
              <ReportView key={i} report={r} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ReportView({ report: r }: { report: ReviewReport }) {
  if (r.status !== "done") {
    return (
      <div className="pv-report failed">
        <b>{r.reviewer.model}</b>
        <span className="hint">{r.reviewer.providerName}</span>
        <span className="spacer" />
        <span className="err-text">{r.error ?? REPORT_STATUS[r.status]}</span>
      </div>
    );
  }
  const lists: [string, string[] | undefined][] = [
    ["优点", r.strengths],
    ["缺点", r.weaknesses?.map((w) => (w.where ? `${w.text}（针对：${w.where}）` : w.text))],
    ["给作者的问题", r.questions],
    ["修改建议", r.suggestions],
  ];
  return (
    <details className="pv-report">
      <summary>
        <b>{r.reviewer.model}</b>
        <span className="hint">{r.reviewer.providerName}</span>
        <span className="spacer" />
        {r.overall !== undefined && <span className="pv-overall">{r.overall} / 10</span>}
        {r.decision && <StatusBadge tone={DECISION[r.decision].tone}>{DECISION[r.decision].text}</StatusBadge>}
      </summary>
      <div className="pv-report-body">
        {r.summary && <p>{r.summary}</p>}
        <p className="hint">
          {r.scores && SUB.map(([key, label]) => `${label} ${r.scores![key]}`).join(" · ")}
          {r.confidence !== undefined && `${r.scores ? " · " : ""}把握 ${r.confidence} / 5`}
          {r.reflected > 0 && ` · 自我反思了 ${r.reflected} 轮`}
        </p>
        {lists.map(
          ([label, items]) =>
            !!items?.length && (
              <div key={label}>
                <div className="rs-label">{label}</div>
                <ul>
                  {items.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            ),
        )}
      </div>
    </details>
  );
}
