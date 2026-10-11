import { useEffect, useState } from "react";
import type { EvidenceRecord, EvidenceRepoFile, PaperDoc, PaperTask } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge } from "../settings/ui";
import { CharCount, LIVE_TASK, TaskBar, cleanError } from "./common";

const TITLE_MAX = 200;
const DETAIL_MAX = 500;

interface Props {
  papers: PaperDoc[];
  tasks: PaperTask[];
  /** question: prefilled in deep research when known (review / ideas hand-offs). */
  onStartResearch(path: string, question?: string): void;
}

/** 转证据库: extract claims from papers, review and edit them, save as a repository Chain-Centric reads. */
export function EvidenceTab({ papers, tasks, onStartResearch }: Props) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [records, setRecords] = useState<EvidenceRecord[] | null>(null);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<EvidenceRepoFile | null>(null);
  const [files, setFiles] = useState<EvidenceRepoFile[]>([]);
  const [open, setOpen] = useState<number | null>(0);
  const [error, setError] = useState("");

  const task = tasks.find((t) => t.id === taskId);
  const refresh = () => void window.sweet.evidenceList().then(setFiles);
  useEffect(refresh, []);

  // The extraction finished: its drafted records go into the review table.
  useEffect(() => {
    if (task?.status === "done" && task.records && !records) {
      setRecords(task.records);
      setOpen(0);
    }
  }, [task?.status, task?.records, records]);

  async function extract() {
    setError("");
    setSaved(null);
    try {
      const t = await window.sweet.paperExtract(chosen);
      setRecords(null);
      setTaskId(t.id);
      if (t.status === "done" && t.records) setRecords(t.records);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function save() {
    if (!records) return;
    setError("");
    try {
      const f = await window.sweet.evidenceSave(name.trim(), records);
      setSaved(f);
      refresh();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function load(f: EvidenceRepoFile) {
    setError("");
    try {
      setRecords(await window.sweet.evidenceLoad(f.path));
      setName(f.name);
      setSaved(f);
      setTaskId(null);
      setOpen(0);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const patch = (i: number, p: Partial<EvidenceRecord>) => {
    setSaved(null);
    setRecords((list) => list && list.map((r, j) => (j === i ? { ...r, ...p } : r)));
  };
  const patchClaim = (i: number, k: number, p: Partial<EvidenceRecord["claims"][number]>) =>
    patch(i, { claims: records![i].claims.map((c, j) => (j === k ? { ...c, ...p } : c)) });

  const over = records?.some((r) => [...r.title].length > TITLE_MAX || [...r.detail].length > DETAIL_MAX || r.claims.some((c) => [...c.title].length > TITLE_MAX || [...c.detail].length > DETAIL_MAX));

  return (
    <div className="pp-evidence">
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="list-check" />
          <h3>1. 选论文，提取论点</h3>
        </header>
        <p className="hint">模型会从每篇论文里找出主要结论和支撑它们的论点，并记下出自原文哪一页。提取完可以逐条修改。</p>
        {papers.length === 0 ? (
          <p className="hint pp-empty">先在「读论文」里导入论文。</p>
        ) : (
          <ul className="pp-pick">
            {papers.map((p) => (
              <li key={p.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                  />
                  <span>{p.title}</span>
                  <span className={"pp-src " + p.source.kind}>{p.source.kind === "arxiv" ? "arXiv" : "本地"}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="rs-actions">
          <span className="hint">已选 {chosen.length} 篇</span>
          <span className="spacer" />
          <button type="button" className="send rs-accent" disabled={!chosen.length || (!!task && LIVE_TASK.has(task.status))} onClick={() => void extract()}>
            提取论点
          </button>
        </div>
        {task && task.status !== "done" && <TaskBar task={task} />}
      </section>

      {records && (
        <section className="rs-card">
          <header className="rs-card-head">
            <Icon name="check-circle" />
            <h3>2. 审阅论点</h3>
            <span className="rs-count">{records.length} 条</span>
          </header>
          <p className="hint">
            每条是一篇论文的一个结论，下面的论点是它的依据。标题最多 200 字、说明最多 500 字，超出的部分深度科研读不到。
            带「出自原文」的论点可以对照原文核实。
          </p>
          <ul className="pp-records">
            {records.map((r, i) => (
              <li key={i} className={"pp-record" + (open === i ? " open" : "")}>
                <div className="pp-record-row">
                  <button type="button" className="icon-btn square" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} aria-label={open === i ? "收起" : "展开论点"}>
                    <Icon name={open === i ? "chevron-down" : "chevron-right"} />
                  </button>
                  <code className="pp-ref">{r.ref || "（没有 ref）"}</code>
                  <span className="pp-record-title">{r.title || "（没有标题）"}</span>
                  <span className="pp-record-meta">{r.claims.length} 个论点</span>
                  <button type="button" className="icon-btn square" title="删除这条" aria-label="删除这条" onClick={() => setRecords(records.filter((_, j) => j !== i))}>
                    <Icon name="trash" />
                  </button>
                </div>
                {open === i && (
                  <div className="pp-record-edit">
                    <div className="pp-grid2">
                      <label className="pp-fld">
                        <span>ref（引用标识）</span>
                        <input className="rs-input pp-wide" value={r.ref} onChange={(e) => patch(i, { ref: e.target.value })} />
                      </label>
                      <label className="pp-fld">
                        <span>来源</span>
                        <input className="rs-input pp-wide" value={r.source} onChange={(e) => patch(i, { source: e.target.value })} />
                      </label>
                    </div>
                    <label className="pp-fld">
                      <span>
                        标题 <CharCount text={r.title} max={TITLE_MAX} />
                      </span>
                      <input className="rs-input pp-wide" value={r.title} onChange={(e) => patch(i, { title: e.target.value })} />
                    </label>
                    <label className="pp-fld">
                      <span>
                        一句话结论 <CharCount text={r.detail} max={DETAIL_MAX} />
                      </span>
                      <textarea className="rs-textarea" rows={2} value={r.detail} onChange={(e) => patch(i, { detail: e.target.value })} />
                    </label>
                    <div className="rs-label">论点</div>
                    <ol className="pp-claims">
                      {r.claims.map((c, k) => (
                        <li key={k}>
                          <div className="pp-claim-fields">
                            <label className="pp-fld">
                              <span>
                                论点 <CharCount text={c.title} max={TITLE_MAX} />
                              </span>
                              <input className="rs-input pp-wide" value={c.title} onChange={(e) => patchClaim(i, k, { title: e.target.value })} />
                            </label>
                            <label className="pp-fld">
                              <span>
                                依据与数据 <CharCount text={c.detail} max={DETAIL_MAX} />
                              </span>
                              <textarea className="rs-textarea" rows={2} value={c.detail} onChange={(e) => patchClaim(i, k, { detail: e.target.value })} />
                            </label>
                            {c.quote ? (
                              <blockquote className="pp-quote">
                                <StatusBadge tone="ok">出自原文第 {c.quote.page} 页</StatusBadge>
                                <span>{c.quote.excerpt}</span>
                              </blockquote>
                            ) : (
                              <p className="hint">没有记下出处，是模型的归纳。</p>
                            )}
                          </div>
                          <button type="button" className="icon-btn square" title="删除这个论点" aria-label="删除这个论点" onClick={() => patch(i, { claims: r.claims.filter((_, j) => j !== k) })}>
                            <Icon name="close" />
                          </button>
                        </li>
                      ))}
                    </ol>
                    <button type="button" className="mini-btn pp-self-start" onClick={() => patch(i, { claims: [...r.claims, { title: "", detail: "" }] })}>
                      <Icon name="plus" /> 加一个论点
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mini-btn pp-self-start"
            onClick={() => {
              setRecords([...records, { ref: "", title: "", detail: "", source: "论文工坊", claims: [] }]);
              setOpen(records.length);
            }}
          >
            <Icon name="plus" /> 加一条
          </button>

          <div className="pp-save">
            <label className="pp-fld">
              <span>证据库名字</span>
              <input className="rs-input pp-wide" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：阿尔茨海默-淀粉样蛋白" />
            </label>
            <div className="rs-actions">
              {over && <span className="warn-text">有内容超出字数，保存后超出部分会被截掉</span>}
              <span className="spacer" />
              <button type="button" className="send rs-accent" disabled={!name.trim() || !records.length} onClick={() => void save()}>
                保存为证据库
              </button>
              {saved && (
                <button type="button" className="send" onClick={() => onStartResearch(saved.path)}>
                  用它开始深度研判
                </button>
              )}
            </div>
            {saved && <p className="ok-text">已保存到 {saved.path}</p>}
          </div>
        </section>
      )}
      {error && <p className="err-text">{error}</p>}

      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="archive" />
          <h3>已保存的证据库</h3>
          <span className="rs-count">{files.length}</span>
        </header>
        {files.length === 0 ? (
          <p className="hint">还没有保存过。</p>
        ) : (
          <ul className="pp-files">
            {files.map((f) => (
              <li key={f.path}>
                <div>
                  <b>{f.name}</b>
                  <span className="hint">
                    {f.records} 条 · {new Date(f.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · <code>{f.path}</code>
                  </span>
                </div>
                <button type="button" className="mini-btn" onClick={() => void load(f)}>
                  打开编辑
                </button>
                <button type="button" className="mini-btn" onClick={() => onStartResearch(f.path)}>
                  用它开始深度研判
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
