import { useEffect, useState } from "react";
import type { IdeaRun, IdeaSettings, NoveltyVerdict, PaperDoc, ResearchHandoff, ResearchIdea } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, type Tone } from "../settings/ui";
import { cleanError } from "./common";

const VERDICT: Record<NoveltyVerdict, { text: string; tone: Tone; hint: string }> = {
  done: { text: "已有人做过", tone: "bad", hint: "检索到的论文里有做同一件事的" },
  overlap: { text: "部分重叠", tone: "warn", hint: "有人做了其中一部分，或很接近的问题" },
  unseen: { text: "未见", tone: "ok", hint: "没检索到相近的工作；不等于一定没人做过" },
};
const RUN_STATUS: Record<IdeaRun["status"], { text: string; tone: Tone }> = {
  queued: { text: "排队中", tone: "muted" },
  running: { text: "生成中", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  failed: { text: "失败", tone: "bad" },
  cancelled: { text: "已取消", tone: "muted" },
};
const SCORES = [
  ["interest", "有趣度"],
  ["feasibility", "可行性"],
  ["novelty", "新颖性（估计）"],
] as const;
const live = (r: IdeaRun) => r.status === "queued" || r.status === "running";

interface Props {
  papers: PaperDoc[];
  /** Open 深度科研 with this evidence repository chosen. */
  /** question: prefilled in deep research when known (review / ideas hand-offs). */
  onStartResearch(path: string, question?: string): void;
}

/**
 * 选题: a model proposes research ideas for a direction (optionally from papers in the workshop),
 * and each idea can be checked against OpenAlex for work that has already done it.
 */
export function IdeasTab({ papers, onStartResearch }: Props) {
  const [runs, setRuns] = useState<IdeaRun[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [background, setBackground] = useState<string[]>([]);
  const [count, setCount] = useState(5);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<IdeaSettings>({ mailto: "", semanticScholar: false });
  const [mailto, setMailto] = useState("");
  /** A check waiting for the user to read the going-online note. */
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  const [handoff, setHandoff] = useState<(ResearchHandoff & { copied: boolean }) | null>(null);

  useEffect(() => {
    void window.sweet.ideasList().then((list) => {
      setRuns(list);
      setOpenId((cur) => cur ?? list[0]?.id ?? null);
    });
    void window.sweet.ideasConsent().then(setConsent);
    void window.sweet.ideasSettings().then((s) => {
      setSettings(s);
      setMailto(s.mailto);
    });
    return window.sweet.onIdeaEvent((e) => {
      if (e.type === "removed") setRuns((list) => list.filter((r) => r.id !== e.id));
      else setRuns((list) => (list.some((r) => r.id === e.run.id) ? list.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...list]));
    });
  }, []);

  const open = runs.find((r) => r.id === openId) ?? null;
  const checking = !!open?.ideas.some((i) => i.novelty?.status === "checking");

  async function act(work: () => Promise<unknown>) {
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function start() {
    setStarting(true);
    await act(async () => {
      const run = await window.sweet.ideasStart({ direction: direction.trim(), paperIds: background, count });
      setRuns((list) => (list.some((r) => r.id === run.id) ? list : [run, ...list]));
      setOpenId(run.id);
      setHandoff(null);
    });
    setStarting(false);
  }

  /** Going online is explained once; after that checks start straight away. */
  function check(runId: string, ideaId?: string) {
    const go = () => void act(() => window.sweet.ideasCheck(runId, ideaId));
    if (consent) go();
    else setAsking(() => go);
  }

  async function agree() {
    await act(async () => {
      if (mailto.trim() !== settings.mailto) setSettings(await window.sweet.ideasSetSettings({ mailto: mailto.trim() }));
      await window.sweet.grantIdeasConsent();
      setConsent(true);
      asking?.();
      setAsking(null);
    });
  }

  async function toResearch(run: IdeaRun, idea: ResearchIdea) {
    await act(async () => {
      const h = await window.sweet.ideasToResearch(run.id, idea.id);
      const copied = await navigator.clipboard.writeText(h.question).then(
        () => true,
        () => false,
      );
      setHandoff({ ...h, copied });
    });
  }

  return (
    <div className="pp-ideas">
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="sparkle" />
          <h3>想做哪个方向</h3>
        </header>
        <textarea
          className="rs-textarea pp-input"
          rows={3}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="例如：让小模型在长文档问答里少编造；想找能用公开数据、单卡做完的题目。"
          aria-label="研究方向"
        />
        {papers.length > 0 && (
          <div className="rs-field">
            <span className="rs-label">用工坊里的论文当背景（可不选）</span>
            <ul className="pp-pick">
              {papers.map((p) => (
                <li key={p.id}>
                  <label>
                    <input type="checkbox" checked={background.includes(p.id)} onChange={(e) => setBackground((b) => (e.target.checked ? [...b, p.id].slice(0, 10) : b.filter((x) => x !== p.id)))} />
                    <span>{p.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="rs-actions">
          <span className="rs-label">要几个</span>
          <div className="seg" role="radiogroup" aria-label="点子数量">
            {[3, 5, 8].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={count === n} className={count === n ? "on" : undefined} onClick={() => setCount(n)}>
                {n} 个
              </button>
            ))}
          </div>
          <span className="hint">点子和分数都是模型给的草稿，新不新要靠下面的检查和你自己的判断。</span>
          <span className="spacer" />
          <button type="button" className="send rs-accent" disabled={!direction.trim() || starting} onClick={() => void start()}>
            {starting ? "正在开始…" : "生成点子"}
          </button>
        </div>
        {error && <p className="err-text">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </section>

      {asking && (
        <section className="rs-card rs-callout warn" role="dialog" aria-label="新颖性检查会联网">
          <b>新颖性检查需要联网，先说清楚会发生什么</b>
          <span>
            会把点子的英文检索词（几个词，例如 “retrieval grounding small language models”）发给 <b>OpenAlex</b>（api.openalex.org，公开的学术文献索引，不需要 Key），取回最接近的几篇论文的标题、年份、作者和摘要开头。
            {settings.semanticScholar && " 你配置了 Semantic Scholar 的 Key，所以同样的检索词也会发给 api.semanticscholar.org。"}
          </span>
          <span>不会发送你的论文、项目文件或点子的全文。取回的论文再交给你的模型判断是否重叠。这段说明只出现这一次。</span>
          <label className="rs-field">
            <span className="rs-label">邮箱（选填）</span>
            <input className="rs-input pp-wide pv-path" type="email" value={mailto} onChange={(e) => setMailto(e.target.value)} placeholder="留空就不发送" spellCheck={false} />
            <span className="hint">OpenAlex 建议带上邮箱，请求会进入更稳定的“礼貌池”。填了就会随每次检索一起发给它；不填也能用。</span>
          </label>
          <div className="rs-actions">
            <span className="spacer" />
            <button type="button" className="mini-btn" onClick={() => setAsking(null)}>
              先不查
            </button>
            <button type="button" className="send rs-accent" onClick={() => void agree()}>
              知道了，开始检查
            </button>
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="rs-card">
          <header className="rs-card-head">
            <Icon name="history" />
            <h3>选题记录</h3>
          </header>
          <ul className="pv-runs">
            {runs.map((r) => (
              <li key={r.id} className={r.id === openId ? "on" : undefined}>
                <button
                  type="button"
                  className="pv-run"
                  onClick={() => {
                    setOpenId(r.id);
                    setHandoff(null);
                  }}
                >
                  <b>{r.direction}</b>
                  <span className="hint">
                    {new Date(r.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {r.ideas.length} 个点子
                  </span>
                </button>
                <StatusBadge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].text}</StatusBadge>
                <button type="button" className="icon-btn square" title="删除这次选题记录" aria-label="删除这次选题记录" onClick={() => void window.sweet.ideasDelete(r.id)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && (
        <section className="rs-card" aria-label="点子">
          <header className="rs-card-head">
            <Icon name="list-check" />
            <h3>{open.direction}</h3>
            <StatusBadge tone={RUN_STATUS[open.status].tone}>{RUN_STATUS[open.status].text}</StatusBadge>
            <span className="spacer" />
            {live(open) && (
              <button type="button" className="mini-btn" onClick={() => void window.sweet.ideasCancel(open.id)}>
                <Icon name="stop" /> 取消
              </button>
            )}
            {open.status === "done" && (
              <>
                <button type="button" className="mini-btn" disabled={checking} onClick={() => check(open.id)} title="逐个到文献库里查有没有人做过">
                  {checking ? "正在检查…" : "全部做新颖性检查"}
                </button>
                {checking && (
                  <button type="button" className="mini-btn" onClick={() => void window.sweet.ideasCancel(open.id)}>
                    停下
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void act(async () => setNotice(`已导出到 ${await window.sweet.ideasExport(open.id)}`))}
                  title="把这些点子存成项目里的一个 Markdown 文件（会先问你）"
                >
                  <Icon name="file" /> 导出 Markdown
                </button>
              </>
            )}
          </header>
          {live(open) && (
            <div className="rs-bar indeterminate" aria-hidden="true">
              <span />
            </div>
          )}
          {open.error && <p className="err-text">{open.error}</p>}

          {handoff && (
            <div className="rs-callout pv-handoff" role="status">
              <span>
                已把这个点子和检索到的论文存成证据库 <code>{handoff.path}</code>。点下面的按钮，深度科研会自动填好证据库和研究问题。
              </span>
              <blockquote>{handoff.question}</blockquote>
              <div className="rs-actions">
                <span className="spacer" />
                <button type="button" className="send rs-accent" onClick={() => onStartResearch(handoff.path, handoff.question)}>
                  去深度科研
                </button>
              </div>
            </div>
          )}

          <ol className="pi-ideas">
            {open.ideas.map((idea) => (
              <li key={idea.id} className="pi-idea">
                <div className="pi-head">
                  <b>{idea.title}</b>
                  {idea.novelty?.status === "done" && idea.novelty.verdict && (
                    <StatusBadge tone={VERDICT[idea.novelty.verdict].tone} title={VERDICT[idea.novelty.verdict].hint}>
                      {VERDICT[idea.novelty.verdict].text}
                    </StatusBadge>
                  )}
                </div>
                <p className="pi-one">{idea.oneLine}</p>
                <div className="pi-scores">
                  {SCORES.map(([key, label]) => (
                    <span key={key} className="pi-score" title={`${label} ${idea.scores[key]} / 10`}>
                      <span>{label}</span>
                      <span className="pi-meter" aria-hidden="true">
                        <i style={{ width: `${idea.scores[key] * 10}%` }} />
                      </span>
                      <b>{idea.scores[key]}</b>
                    </span>
                  ))}
                </div>
                {idea.rationale && <p className="hint">打分理由：{idea.rationale}</p>}
                <details className="pi-more">
                  <summary>动机和实验方案</summary>
                  {idea.motivation && (
                    <>
                      <div className="rs-label">动机</div>
                      <p>{idea.motivation}</p>
                    </>
                  )}
                  {idea.plan && (
                    <>
                      <div className="rs-label">实验方案草案</div>
                      <p>{idea.plan}</p>
                    </>
                  )}
                </details>

                <Novelty idea={idea} />

                <div className="rs-actions pi-ops">
                  <button type="button" className="mini-btn" disabled={checking} onClick={() => check(open.id, idea.id)}>
                    <Icon name="globe" /> {idea.novelty?.status === "done" || idea.novelty?.status === "failed" ? "再查一次" : "新颖性检查"}
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => void act(async () => setNotice(`已加入证据库 ${(await window.sweet.ideasToEvidence(open.id, [idea.id], "ideas")).path}，可以到「转证据库」里打开审阅。`))}
                    title="存进 research/ideas.repository.json，作为草稿"
                  >
                    加入证据库草稿
                  </button>
                  <button type="button" className="mini-btn" onClick={() => void toResearch(open, idea)} title="值不值得做，交给深度科研对抗研判">
                    开始深度研判
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** What the novelty check found for one idea. */
function Novelty({ idea }: { idea: ResearchIdea }) {
  const n = idea.novelty;
  if (!n) return null;
  if (n.status === "checking") return <p className="hint pi-novelty">正在文献库里检索：{n.queries.join("；")}</p>;
  if (n.status === "failed") return <p className="err-text pi-novelty">检查没成功：{n.error}</p>;
  return (
    <div className="pi-novelty">
      {n.reason && <p>{n.reason}</p>}
      {n.works.length > 0 && (
        <ul className="pi-works">
          {n.works.map((w) => (
            <li key={w.url}>
              <a href={w.url} target="_blank" rel="noopener noreferrer">
                {w.title}
              </a>
              <span className="hint">
                {[w.year, w.authors.slice(0, 2).join(", ") + (w.authors.length > 2 ? " 等" : ""), w.venue, w.citedBy !== undefined ? `被引 ${w.citedBy}` : "", w.source === "openalex" ? "OpenAlex" : "Semantic Scholar"].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">检索词：{n.queries.join("；")}。判断只依据检索到的标题和摘要开头，结论请自己再核对。</p>
    </div>
  );
}
