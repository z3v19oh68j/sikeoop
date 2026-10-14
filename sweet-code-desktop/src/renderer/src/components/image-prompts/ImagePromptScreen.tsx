import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImagePromptCard, ImagePromptCategory, ImagePromptLang, ImagePromptMeta, ImagePromptModel, ImagePromptQuery } from "@shared/types";
import { Icon } from "../Icon";
import { Empty } from "../plugins/ui";
import { StatusBadge, cleanError } from "../settings/ui";
import { PromptCard } from "./PromptCard";
import { PromptDetail } from "./PromptDetail";
import { SourcesDialog } from "./SourcesDialog";
import { categoryName, langName, modelName } from "./labels";
import { useThumbs } from "./thumbs";
import "../../styles/settings.css";
import "../../styles/plugins.css";
import "../../styles/research.css";
import "../../styles/image-prompts.css";

// 图片提示词精选库 (docs/提示词库-任务书.md): browse, search, copy and favorite curated image prompts.
// Everything that comes from the data set is shown as plain text; links only open when they are http(s);
// pictures only ever come from imagePromptThumbs (data: URLs). Copying always goes through imagePromptCopy.

const PAGE = 48;

export function ImagePromptScreen({ hidden }: { hidden: boolean }) {
  const scroller = useRef<HTMLElement>(null);
  const thumbs = useThumbs(scroller, hidden);
  const started = useRef(false);
  const [meta, setMeta] = useState<ImagePromptMeta | null>(null);
  const [metaError, setMetaError] = useState("");
  const [metaLoading, setMetaLoading] = useState(false);
  const metaRun = useRef(0);

  const [qRaw, setQRaw] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ImagePromptCategory | "">("");
  const [model, setModel] = useState<ImagePromptModel | "">("");
  const [lang, setLang] = useState<ImagePromptLang | "">("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [withImage, setWithImage] = useState(false);

  const [items, setItems] = useState<ImagePromptCard[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [firstDone, setFirstDone] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [openId, setOpenId] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);

  const itemsRef = useRef<ImagePromptCard[]>([]);
  itemsRef.current = items;
  const run = useRef(0);
  const busy = useRef(false);
  const dataset = useRef("");
  const toastTimer = useRef<number | undefined>(undefined);
  const copiedTimer = useRef<number | undefined>(undefined);
  const sentinel = useRef<HTMLDivElement>(null);

  const flash = useCallback((text: string, bad?: boolean) => {
    setToast({ text, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  useEffect(() => () => { window.clearTimeout(toastTimer.current); window.clearTimeout(copiedTimer.current); }, []);

  // 页面第一次显示才请求，藏着的时候不碰接口。
  const loadMeta = useCallback(() => {
    setMetaError("");
    setMetaLoading(true);
    const id = ++metaRun.current;
    window.sweet.imagePromptMeta().then(
      (m) => { if (id === metaRun.current) { setMeta(m); setMetaLoading(false); } },
      (e) => { if (id === metaRun.current) { setMetaError(cleanError(e)); setMetaLoading(false); } },
    );
  }, []);
  // 页面被切走时顺手关掉抽屉和来源面板，切回来不会看到没头没尾的弹层。
  useEffect(() => {
    if (hidden) { setOpenId(null); setShowSources(false); }
  }, [hidden]);
  useEffect(() => {
    if (hidden || started.current) return;
    started.current = true;
    loadMeta();
  }, [hidden, loadMeta]);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(qRaw.trim().slice(0, 200)), 250);
    return () => window.clearTimeout(t);
  }, [qRaw]);

  const ready = meta?.state === "ready";
  const query = useMemo((): ImagePromptQuery => ({
    ...(q && { q }), ...(category && { category }), ...(model && { model }), ...(lang && { lang }),
    ...(favoritesOnly && { favoritesOnly: true }), ...(withImage && { withImage: true }),
  }), [q, category, model, lang, favoritesOnly, withImage]);

  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    const id = ++run.current;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await window.sweet.imagePromptQuery({ ...query, offset, limit: PAGE });
      if (id !== run.current) return;
      if (page.dataset !== dataset.current) {
        const changedMidway = !replace && dataset.current !== "";
        dataset.current = page.dataset;
        thumbs.reset();
        // 翻页翻到一半数据集换了：已经显示的和新的对不上，整个重来。
        if (changedMidway) { setReloadKey((k) => k + 1); return; }
      }
      setItems((cur) => {
        if (replace) return page.items;
        const seen = new Set(cur.map((c) => c.id));
        return [...cur, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setTotal(page.total);
      setNextOffset(page.nextOffset);
    } catch (e) {
      if (id !== run.current) return;
      setError(cleanError(e));
      setNextOffset(null);
    } finally {
      if (id === run.current) { busy.current = false; setLoading(false); setFirstDone(true); }
    }
  }, [query, thumbs]);

  // 筛选条件一变就从头来过。
  useEffect(() => {
    if (!ready) return;
    setItems([]);
    setNextOffset(0);
    scroller.current?.scrollTo({ top: 0 });
    void fetchPage(0, true);
  }, [ready, fetchPage, reloadKey]);

  // 底部哨兵：快滚到底时再要下一页。每次列表变化都重建，这样一页没填满屏幕时会接着要。
  useEffect(() => {
    const el = sentinel.current;
    if (!el || nextOffset === null || !ready) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && !busy.current) void fetchPage(nextOffset, false);
    }, { root: scroller.current, rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, nextOffset, ready, fetchPage]);

  const toggleFavorite = useCallback(async (card: ImagePromptCard) => {
    try {
      const r = await window.sweet.imagePromptSetFavorite(card.id, !card.favorite);
      setItems((cur) => cur.map((c) => (c.id === r.id ? { ...c, favorite: r.favorite } : c)));
      setMeta((m) => (m ? { ...m, favorites: r.count } : m));
    } catch (e) {
      flash(`收藏没成功：${cleanError(e)}`, true);
    }
  }, [flash]);

  const copy = useCallback(async (id: string, l?: ImagePromptLang, step?: number) => {
    try {
      const r = await window.sweet.imagePromptCopy({ id, ...(l && { lang: l }), ...(step !== undefined && { step }) });
      setCopiedId(id);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(""), 1600);
      flash(`已复制，共 ${r.chars} 个字`);
      return r.chars;
    } catch (e) {
      flash(`复制没成功：${cleanError(e)}`, true);
      throw e;
    }
  }, [flash]);
  const copyCard = useCallback((c: ImagePromptCard) => { void copy(c.id).catch(() => {}); }, [copy]);

  const open = useCallback((id: string) => {
    setOpenId(id);
    if (itemsRef.current.find((c) => c.id === id)?.hasThumb) thumbs.want(id);
  }, [thumbs]);
  const openCard = openId ? items.find((c) => c.id === openId) : undefined;
  const filtered = !!(q || category || model || lang || favoritesOnly || withImage);
  const clearFilters = () => { setQRaw(""); setQ(""); setCategory(""); setModel(""); setLang(""); setFavoritesOnly(false); setWithImage(false); };

  const categories = meta?.categories.filter((c) => c.count > 0) ?? [];
  const models = meta?.models.filter((m) => m.count > 0) ?? [];
  const langs = meta?.langs.filter((l) => l.count > 0) ?? [];

  const top = categories.reduce<(typeof categories)[number] | null>((a, c) => (!a || c.count > a.count ? c : a), null);
  const intro = top && meta && meta.total > 0 && top.count / meta.total >= 0.4
    ? `下面按默认顺序排，「${categoryName(top.id, top.label)}」一类就有 ${top.count} 条，会比较多。想看别的类型，点一下就只看那一类：`
    : "想按类型逛，点一下下面的类型就只看那一类：";

  return (
    <main className="research ipl" hidden={hidden} ref={scroller}>
      <div className="rs-inner ipl-inner">
        <header className="rs-head">
          <div>
            <h1>提示词库</h1>
            <p className="hint">精选的图片生成提示词，适合 GPT Image 2 / 2.5。看看效果图，挑一条复制走，把里面的内容换成你自己的就能用。</p>
          </div>
          <button type="button" className="mini-btn" disabled={!meta} onClick={() => setShowSources(true)}><Icon name="book" /> 来源与许可</button>
        </header>

        {!meta && !metaError && <Skeleton />}
        {metaError && (
          <section className="rs-card ipl-state">
            <p className="err-text">{metaError}</p>
            <div><button type="button" className="mini-btn" disabled={metaLoading} onClick={loadMeta}><Icon name="refresh" /> {metaLoading ? "正在重试…" : "再试一次"}</button></div>
          </section>
        )}
        {meta?.state === "missing" && (
          <section className="rs-card ipl-state">
            <h2><Icon name="folder-open" /> 提示词数据还没准备好</h2>
            <p className="hint">这个功能需要一份提示词数据才能显示内容，现在没有找到。</p>
            <p className="hint">如果你用的是正式安装的 sikeoop，可以先更新到最新版本，再点下面的「重新检查」；如果你在开发版里，请先运行导入脚本生成数据，再重新检查。</p>
            {meta.reason && <p className="ipl-reason">补充说明：{meta.reason}</p>}
            <div><RecheckButton loading={metaLoading} onClick={loadMeta} /></div>
          </section>
        )}
        {meta?.state === "invalid" && (
          <section className="rs-card ipl-state">
            <h2><StatusBadge tone="bad">数据有问题</StatusBadge> 提示词数据用不了</h2>
            <p className="hint">提示词数据文件可能损坏了，或者不是可以使用的版本，所以现在没法显示内容。</p>
            <p className="hint">可以先点「重新检查」试一次；还是不行的话，请重新安装或更新 sikeoop，开发版请重新运行导入脚本。</p>
            {meta.reason && <p className="ipl-reason">补充说明：{meta.reason}</p>}
            <div><RecheckButton loading={metaLoading} onClick={loadMeta} /></div>
          </section>
        )}

        {meta && ready && (
          <>
            <div className="ipl-bar">
              <div className="ipl-bar-row">
                <label className="ipl-search">
                  <Icon name="eye-search" />
                  <input className="rs-input" value={qRaw} maxLength={200} onChange={(e) => setQRaw(e.target.value)} placeholder="搜标题、标签、作者，或提示词里的词" aria-label="搜索提示词" />
                  {qRaw && <button type="button" className="ipl-search-x" onClick={() => setQRaw("")} aria-label="清空搜索"><Icon name="close" /></button>}
                </label>
                {models.length > 0 && (
                  <div className="seg ipl-seg" role="radiogroup" aria-label="模型">
                    <button type="button" role="radio" aria-checked={model === ""} className={model === "" ? "on" : undefined} onClick={() => setModel("")}>全部模型</button>
                    {models.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={model === m.id} className={model === m.id ? "on" : undefined} onClick={() => setModel(m.id)} title={`${m.count} 条`}>{modelName(m.id, m.label)}</button>
                    ))}
                  </div>
                )}
                {langs.length > 1 && (
                  <div className="seg ipl-seg" role="radiogroup" aria-label="语言">
                    <button type="button" role="radio" aria-checked={lang === ""} className={lang === "" ? "on" : undefined} onClick={() => setLang("")}>全部语言</button>
                    {langs.map((l) => (
                      <button key={l.id} type="button" role="radio" aria-checked={lang === l.id} className={lang === l.id ? "on" : undefined} onClick={() => setLang(l.id)} title={`${l.count} 条`}>{langName(l.id, l.label)}</button>
                    ))}
                  </div>
                )}
                <button type="button" className={"ipl-toggle" + (favoritesOnly ? " on" : "")} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
                  <Icon name="heart" /> 只看收藏{meta.favorites > 0 ? ` ${meta.favorites}` : ""}
                </button>
                <button type="button" className={"ipl-toggle" + (withImage ? " on" : "")} aria-pressed={withImage} onClick={() => setWithImage(!withImage)}>
                  <Icon name="ft-image" /> 只看有配图
                </button>
              </div>
              <div className="ipl-chips" role="radiogroup" aria-label="分类">
                <button type="button" role="radio" aria-checked={category === ""} className={"ipl-chip" + (category === "" ? " on" : "")} onClick={() => setCategory("")}>全部 <i>{meta.total}</i></button>
                {categories.map((c) => (
                  <button key={c.id} type="button" role="radio" aria-checked={category === c.id} className={"ipl-chip" + (category === c.id ? " on" : "")} onClick={() => setCategory(c.id)}>{categoryName(c.id, c.label)} <i>{c.count}</i></button>
                ))}
              </div>
            </div>

            <div className="ipl-count" aria-live="polite">
              {firstDone && !error && !(loading && items.length === 0) && <span>{filtered ? `找到 ${total} 条` : `共 ${total} 条`}</span>}
              {filtered && <button type="button" className="link-btn" onClick={clearFilters}>清除筛选</button>}
            </div>

            {error && (
              <section className="rs-card ipl-state">
                <p className="err-text">{error}</p>
                <div><button type="button" className="mini-btn" onClick={() => setReloadKey((k) => k + 1)}><Icon name="refresh" /> 再试一次</button></div>
              </section>
            )}

            {!filtered && !error && categories.length > 0 && items.length > 0 && (
              <section className="ipl-intro" aria-label="按类型逛逛">
                <p>{intro}</p>
                <div className="ipl-intro-list">
                  {categories.map((c) => (
                    <button key={c.id} type="button" className="ipl-chip" onClick={() => setCategory(c.id)}>{categoryName(c.id, c.label)} <i>{c.count}</i></button>
                  ))}
                </div>
              </section>
            )}

            {!error && items.length === 0 && firstDone && !loading && (
              <div className="ipl-empty">
                <Empty>{favoritesOnly && !q && !category && !model && !lang && !withImage ? "还没有收藏。看到喜欢的，点卡片上的心形按钮就会存在这里。" : "没有找到符合的提示词，换个关键词或者放宽筛选试试。"}</Empty>
                {filtered && <button type="button" className="mini-btn" onClick={clearFilters}>清除筛选</button>}
              </div>
            )}
            {!firstDone && items.length === 0 && !error && <Skeleton />}

            {items.length > 0 && (
              <ul className="ipl-grid">
                {items.map((c) => (
                  <PromptCard key={c.id} card={c} src={c.hasThumb ? thumbs.src(c.id) : undefined} observe={thumbs.observe} copied={copiedId === c.id} onOpen={open} onFavorite={toggleFavorite} onCopy={copyCard} />
                ))}
              </ul>
            )}
            {nextOffset !== null && <div ref={sentinel} className="ipl-sentinel">{loading && items.length > 0 ? "正在加载更多…" : ""}</div>}
            {nextOffset === null && items.length > PAGE && !error && <p className="ipl-end">已经到底了</p>}
          </>
        )}
      </div>

      {toast && <p className={"ipl-toast" + (toast.bad ? " bad" : "")} role="status"><Icon name={toast.bad ? "warning" : "check"} /> {toast.text}</p>}
      {showSources && meta && <SourcesDialog meta={meta} onClose={() => setShowSources(false)} />}
      {openCard && (
        <PromptDetail
          card={openCard}
          meta={meta}
          src={thumbs.src(openCard.id)}
          favorite={openCard.favorite}
          onClose={() => setOpenId(null)}
          onFavorite={toggleFavorite}
          onCopy={copy}
        />
      )}
    </main>
  );
}

function RecheckButton({ loading, onClick }: { loading: boolean; onClick(): void }) {
  return (
    <button type="button" className="mini-btn" disabled={loading} aria-busy={loading} onClick={onClick}>
      <Icon name="refresh" /> {loading ? "正在检查…" : "重新检查"}
    </button>
  );
}

function Skeleton() {
  return (
    <ul className="ipl-grid ipl-skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="ipl-card"><div className="ipl-media" style={{ aspectRatio: i % 3 === 0 ? "3 / 4" : "4 / 3" }}><span className="ipl-shimmer" /></div><div className="ipl-info"><span className="ipl-bone" /><span className="ipl-bone short" /></div></li>
      ))}
    </ul>
  );
}
