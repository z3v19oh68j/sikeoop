import { useEffect, useState } from "react";
import type { ArxivEntry, PaperDoc } from "@shared/types";
import { Icon } from "../Icon";
import { authorsText, cleanError } from "./common";

/** An arXiv id ("2401.12345", "2401.12345v2", old "hep-th/9901001") or an arxiv.org link. */
const looksLikeId = (q: string) => /arxiv\.org\//i.test(q) || /^\s*(arxiv:)?\d{4}\.\d{4,5}(v\d+)?\s*$/i.test(q) || /^\s*[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?\s*$/i.test(q);

const PAGE = 10;

/** arXiv 小助手: look up / search, translate abstracts, add papers (one-time network notice first). */
export function ArxivTab({ papers }: { papers: PaperDoc[] }) {
  const [consent, setConsent] = useState<boolean | null>(null);
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ArxivEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [lastQuery, setLastQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [translations, setTranslations] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void window.sweet.arxivConsent().then(setConsent);
  }, []);

  const added = new Set(papers.filter((p) => p.source.kind === "arxiv").map((p) => (p.source as { id: string }).id.replace(/v\d+$/, "")));
  const isAdded = (e: ArxivEntry) => added.has(e.id.replace(/v\d+$/, ""));

  /** Every network request goes through here: the first one asks. */
  function withConsent(fn: () => void) {
    if (consent) fn();
    else setAsking(() => fn);
  }

  async function search(more = false) {
    const q = more ? lastQuery : query.trim();
    if (!q) return;
    setError("");
    setBusy(more ? "加载中…" : "查找中…");
    try {
      if (!more && looksLikeId(q)) {
        const e = await window.sweet.arxivLookup(q);
        setEntries([e]);
        setTotal(1);
      } else {
        const r = await window.sweet.arxivSearch(q, more ? entries.length : 0);
        setEntries(more ? [...entries, ...r.entries] : r.entries);
        setTotal(r.total);
      }
      if (!more) {
        setLastQuery(q);
        setChosen([]);
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy("");
    }
  }

  async function translate(e: ArxivEntry) {
    setTranslations((t) => ({ ...t, [e.id]: null }));
    try {
      const r = await window.sweet.writingRun({ action: "translate_en_zh", text: e.summary, format: "latex" });
      setTranslations((t) => ({ ...t, [e.id]: r.text }));
    } catch (err) {
      setTranslations((t) => {
        const { [e.id]: _, ...rest } = t;
        return rest;
      });
      setError(cleanError(err));
    }
  }

  async function add(ids: string[]) {
    setError("");
    for (const id of ids) {
      setAdding((a) => ({ ...a, [id]: true }));
      try {
        await window.sweet.paperImport({ kind: "arxiv", id });
      } catch (e) {
        setError(`${id}：${cleanError(e)}`);
      } finally {
        setAdding((a) => ({ ...a, [id]: false }));
      }
    }
    setChosen([]);
  }

  return (
    <div className="pp-arxiv">
      {asking && (
        <section className="rs-card rs-confirm" aria-label="联网说明">
          <header className="rs-card-head">
            <Icon name="globe" />
            <h3>arXiv 小助手需要联网</h3>
          </header>
          <div className="rs-callout">
            <p>
              查找时会访问 arXiv 官方接口 <code>export.arxiv.org</code>，取回论文的标题、作者、摘要和分类，只发送你输入的编号或关键词。
            </p>
            <p>
              「加入论文」时会从 <code>arxiv.org</code> 下载这篇论文的 PDF 到这个项目里。「翻译摘要」会把摘要发给你在「模型分工」里设的模型。
            </p>
            <p>这个说明只出现一次。</p>
          </div>
          <div className="rs-actions">
            <span className="spacer" />
            <button type="button" className="mini-btn" onClick={() => setAsking(null)}>
              先不用
            </button>
            <button
              type="button"
              className="send rs-accent"
              onClick={() =>
                void window.sweet.grantArxivConsent().then(() => {
                  setConsent(true);
                  const fn = asking;
                  setAsking(null);
                  fn();
                })
              }
            >
              同意并继续
            </button>
          </div>
        </section>
      )}

      <section className="rs-card">
        <form
          className="pp-search"
          onSubmit={(e) => {
            e.preventDefault();
            withConsent(() => void search());
          }}
        >
          <Icon name="eye-search" />
          <input
            className="rs-input pp-wide"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="arXiv 编号（2401.12345）、链接，或英文关键词（graph neural network）"
            aria-label="搜索 arXiv"
          />
          <button type="submit" className="send rs-accent" disabled={!query.trim() || !!busy}>
            {busy && !entries.length ? busy : "查找"}
          </button>
        </form>
        <p className="hint">按编号或链接会直接找到那一篇；按关键词按相关度列出结果，关键词用英文效果更好。</p>
        {error && <p className="err-text">{error}</p>}
      </section>

      {entries.length > 0 && (
        <section className="rs-card">
          <header className="rs-card-head">
            <Icon name="list-check" />
            <h3>结果</h3>
            <span className="rs-count">
              {entries.length}
              {total > entries.length ? ` / ${total}` : ""}
            </span>
            <span className="spacer" />
            {chosen.length > 0 && (
              <button type="button" className="send rs-accent" onClick={() => withConsent(() => void add(chosen))}>
                把选中的 {chosen.length} 篇加入论文
              </button>
            )}
          </header>
          <ul className="pp-results">
            {entries.map((e) => {
              const tr = translations[e.id];
              const done = isAdded(e);
              return (
                <li key={e.id} className="pp-result-item">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${e.title}`}
                    disabled={done}
                    checked={chosen.includes(e.id)}
                    onChange={(ev) => setChosen((c) => (ev.target.checked ? [...c, e.id] : c.filter((x) => x !== e.id)))}
                  />
                  <div className="pp-result-main">
                    <a className="pp-result-title" href={e.absUrl} target="_blank" rel="noreferrer">
                      {e.title}
                    </a>
                    <div className="pp-result-meta">
                      <span>{authorsText(e.authors)}</span>
                      <span>{e.published.slice(0, 10)}</span>
                      <code>{e.id}</code>
                      {e.categories.slice(0, 3).map((c) => (
                        <span key={c} className="pp-cat">
                          {c}
                        </span>
                      ))}
                    </div>
                    <Abstract text={e.summary} />
                    {e.id in translations && (
                      <div className="pp-abstract-zh">{tr === null ? <span className="hint">翻译中…</span> : tr}</div>
                    )}
                    <div className="rs-actions">
                      <button type="button" className="mini-btn" disabled={e.id in translations} onClick={() => void translate(e)}>
                        翻译摘要
                      </button>
                      {done ? (
                        <span className="ok-text">
                          <Icon name="check" /> 已在论文列表里
                        </span>
                      ) : (
                        <button type="button" className="mini-btn" disabled={adding[e.id]} onClick={() => withConsent(() => void add([e.id]))}>
                          <Icon name="plus" /> {adding[e.id] ? "下载中…" : "加入论文"}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {total > entries.length && (
            <button type="button" className="mini-btn pp-self-start" disabled={!!busy} onClick={() => withConsent(() => void search(true))}>
              {busy || `再加载 ${Math.min(PAGE, total - entries.length)} 条`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function Abstract({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className={"pp-abstract" + (open ? " open" : "")} onClick={() => setOpen(!open)} title={open ? "收起" : "展开摘要"} aria-expanded={open}>
      {text}
    </button>
  );
}
