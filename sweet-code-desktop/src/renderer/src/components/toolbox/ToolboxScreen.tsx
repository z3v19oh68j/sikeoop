import { memo, useEffect, useState } from "react";
import { Icon } from "../Icon";
import { MoreMenu } from "../plugins/ui";
import { StatusBadge, cleanError } from "../settings/ui";
import { CATEGORIES, toolbox, type AiSite, type AiToolboxPrefs } from "./types";
import "../../styles/settings.css";
import "../../styles/plugins.css";
import "../../styles/research.css";
import "../../styles/toolbox.css";

// 百宝箱 (docs/方案-AI搜索百宝箱.md): one question, sent to several AI search sites, opened side by
// side in the built-in browser's own session (persist:sikeoop-browser), so logins are kept.
// Nothing is fetched or scraped from those sites: they are just opened.

const MAX_PANES = 4;
const EMPTY: AiToolboxPrefs = { favorites: [], order: [], hidden: [], custom: [], groups: [] };

interface Pane { key: string; siteId: string; url: string }

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

export const ToolboxScreen = memo(function ToolboxScreen({ hidden }: { hidden: boolean }) {
  const [sites, setSites] = useState<AiSite[]>([]);
  const [prefs, setPrefs] = useState<AiToolboxPrefs>(EMPTY);
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);

  useEffect(() => {
    if (hidden || sites.length) return;
    void Promise.all([toolbox().toolboxSites(), toolbox().toolboxPrefs()]).then(([s, p]) => {
      setSites(s);
      setPrefs(p);
      // 「发给」 starts with three: favorites first, then sites that take the question in the address.
      const first = [...p.favorites, ...s.filter((x) => x.query).map((x) => x.id)].filter((id, i, a) => a.indexOf(id) === i && !p.hidden.includes(id));
      setChosen(first.slice(0, 3));
    });
  }, [hidden, sites.length]);

  const byId = new Map(sites.map((s) => [s.id, s]));
  const rank = (id: string) => { const i = prefs.order.indexOf(id); return i < 0 ? 1e6 + sites.findIndex((s) => s.id === id) : i; };
  const save = async (p: AiToolboxPrefs) => {
    setPrefs(p);
    try { await toolbox().toolboxSavePrefs(p); } catch (e) { setError(cleanError(e)); }
  };
  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(""), 3500); };

  async function openSites(ids: string[], replace: boolean) {
    setError("");
    try {
      const opened = await Promise.all(ids.map(async (id) => ({ id, ...(await toolbox().toolboxOpenUrl(id, q.trim() || undefined)) })));
      const next = opened.map((o) => ({ key: `${o.id}-${Date.now()}`, siteId: o.id, url: o.url }));
      setPanes((cur) => (replace ? next : [...cur, ...next].slice(-MAX_PANES)));
      const copied = opened.filter((o) => o.copied).map((o) => byId.get(o.id)?.name ?? o.id);
      if (copied.length && q.trim()) flash(`问题已复制，在「${copied.join("」「")}」里粘贴即可`);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const toggleChosen = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_PANES ? c : [...c, id]));
  const toggleFav = (id: string) => void save({ ...prefs, favorites: prefs.favorites.includes(id) ? prefs.favorites.filter((x) => x !== id) : [...prefs.favorites, id] });
  const hide = (id: string) => { setChosen((c) => c.filter((x) => x !== id)); void save({ ...prefs, hidden: [...prefs.hidden, id] }); };
  const unhide = (id: string) => void save({ ...prefs, hidden: prefs.hidden.filter((x) => x !== id) });
  const removeCustom = (id: string) => void save({ ...prefs, custom: prefs.custom.filter((s) => s.id !== id), favorites: prefs.favorites.filter((x) => x !== id) }).then(() => toolbox().toolboxSites().then(setSites));
  function dropOn(target: string) {
    if (!drag || drag === target) return;
    const ids = [...sites].sort((a, b) => rank(a.id) - rank(b.id)).map((s) => s.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    void save({ ...prefs, order: ids });
  }

  const visible = sites.filter((s) => showHidden || !prefs.hidden.includes(s.id));
  const favs = visible.filter((s) => prefs.favorites.includes(s.id)).sort((a, b) => rank(a.id) - rank(b.id));
  const groupName = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).join("、");

  const card = (s: AiSite) => {
    const isHidden = prefs.hidden.includes(s.id);
    return (
      <li
        key={s.id}
        className={"tb-card" + (chosen.includes(s.id) ? " chosen" : "") + (isHidden ? " is-hidden" : "") + (drag === s.id ? " dragging" : "")}
        draggable
        onDragStart={() => setDrag(s.id)}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => { dropOn(s.id); setDrag(null); }}
      >
        <button type="button" className="tb-card-main" onClick={() => void openSites([s.id], true)} title={q.trim() ? `用「${q.trim()}」打开 ${s.name}` : `打开 ${s.name}`}>
          <img className="tb-fav" src={`https://${hostOf(s.home)}/favicon.ico`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
          <span className="tb-name">{s.name}</span>
          {s.note && <span className="tb-note">{s.note}</span>}
          <span className="tb-tags">
            {!s.query && <span className="tb-tag">复制粘贴</span>}
            {s.login === "required" && <span className="tb-tag warn">要登录</span>}
            {s.login === "optional" && <span className="tb-tag">登录更好用</span>}
            {s.cnDirect && <span className="tb-tag ok">国内直连</span>}
          </span>
        </button>
        <div className="tb-card-ops">
          <label className="tb-pick" title="发给它">
            <input type="checkbox" checked={chosen.includes(s.id)} disabled={!chosen.includes(s.id) && chosen.length >= MAX_PANES} onChange={() => toggleChosen(s.id)} aria-label={`把问题发给 ${s.name}`} />
          </label>
          <button type="button" className={"icon-btn square tb-star" + (prefs.favorites.includes(s.id) ? " on" : "")} onClick={() => toggleFav(s.id)} aria-label={prefs.favorites.includes(s.id) ? "取消收藏" : "收藏"} title={prefs.favorites.includes(s.id) ? "取消收藏" : "收藏"}>
            <Icon name="heart" />
          </button>
          <MoreMenu
            name={s.name}
            items={[
              isHidden ? { label: "不再隐藏", onClick: () => unhide(s.id) } : { label: "隐藏", onClick: () => hide(s.id) },
              ...(s.category === "custom" ? [{ label: "删除", icon: "trash", danger: true, onClick: () => removeCustom(s.id) }] : []),
            ]}
          />
        </div>
      </li>
    );
  };

  return (
    <main className="research toolbox" hidden={hidden}>
      <div className="rs-inner tb-inner">
        <header className="rs-head">
          <div>
            <h1>百宝箱</h1>
            <p className="hint">一个问题，同时问好几家 AI 搜索，并排对比着看。都在内置浏览器里打开，登录过的会记住；sikeoop 不替你登录，也不读取它们的内容。</p>
          </div>
        </header>

        <section className="rs-card tb-ask">
          <form className="tb-ask-row" onSubmit={(e) => { e.preventDefault(); if (chosen.length) void openSites(chosen, true); }}>
            <input className="rs-input tb-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="想问什么？比如：Vite 和 Webpack 哪个适合新手" aria-label="要问的问题" />
            <button type="submit" className="send rs-accent" disabled={!chosen.length}>发给 {chosen.length} 家</button>
          </form>
          <div className="tb-send-to">
            <span className="hint">发给：</span>
            {chosen.length === 0 && <span className="hint">在下面的卡片上勾选，最多 {MAX_PANES} 家</span>}
            {chosen.map((id) => (
              <button key={id} type="button" className="tb-chip on" onClick={() => toggleChosen(id)} title="点一下去掉">
                {byId.get(id)?.name ?? id} <Icon name="close" />
              </button>
            ))}
            {prefs.groups.length > 0 && <span className="tb-sep" aria-hidden="true" />}
            {prefs.groups.map((g) => (
              <span key={g.id} className="tb-group">
                <button type="button" className="tb-chip" onClick={() => setChosen(g.sites.filter((id) => byId.has(id)).slice(0, MAX_PANES))} title={groupName(g.sites)}>
                  {g.name}
                </button>
                <button type="button" className="tb-group-x" aria-label={`删除组合 ${g.name}`} onClick={() => void save({ ...prefs, groups: prefs.groups.filter((x) => x.id !== g.id) })}>
                  <Icon name="close" />
                </button>
              </span>
            ))}
            {chosen.length > 1 && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const name = window.prompt("给这个组合起个名字", groupName(chosen).slice(0, 16));
                  if (name?.trim()) void save({ ...prefs, groups: [...prefs.groups, { id: `g${Date.now()}`, name: name.trim(), sites: chosen }] });
                }}
              >
                存成组合
              </button>
            )}
          </div>
          {toast && <p className="tb-toast" role="status"><Icon name="copy" /> {toast}</p>}
          {error && <p className="err-text">{error}</p>}
        </section>

        {panes.length > 0 && (
          <section className="tb-compare" aria-label="对比">
            <div className="tb-compare-head">
              <b>{panes.length > 1 ? `对比 ${panes.length} 家` : byId.get(panes[0].siteId)?.name}</b>
              <span className="hint">同一个浏览器会话，登录状态共用</span>
              <span className="spacer" />
              <button type="button" className="mini-btn" onClick={() => setPanes([])}>全部关掉</button>
            </div>
            <div className={"tb-panes n" + panes.length}>
              {panes.map((p) => (
                <div key={p.key} className="tb-pane">
                  <div className="tb-pane-bar">
                    <img className="tb-fav" src={`https://${hostOf(p.url)}/favicon.ico`} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                    <span>{byId.get(p.siteId)?.name ?? hostOf(p.url)}</span>
                    {!byId.get(p.siteId)?.query && q.trim() && <StatusBadge tone="warn">粘贴问题</StatusBadge>}
                    <span className="spacer" />
                    <button type="button" className="icon-btn square" aria-label="关掉这一栏" onClick={() => setPanes((c) => c.filter((x) => x.key !== p.key))}>
                      <Icon name="close" />
                    </button>
                  </div>
                  <webview src={p.url} partition="persist:sikeoop-browser" className="tb-webview" />
                </div>
              ))}
            </div>
          </section>
        )}

        {favs.length > 0 && (
          <section className="tb-section">
            <h2 className="tb-h"><Icon name="heart" /> 收藏</h2>
            <ul className="tb-grid">{favs.map(card)}</ul>
          </section>
        )}
        {CATEGORIES.map((c) => {
          const list = visible.filter((s) => s.category === c.id && !prefs.favorites.includes(s.id)).sort((a, b) => rank(a.id) - rank(b.id));
          if (!list.length && c.id !== "custom") return null;
          return (
            <section key={c.id} className="tb-section">
              <h2 className="tb-h">
                {c.label} <span className="hint">{c.hint}</span>
                {c.id === "custom" && (
                  <button type="button" className="mini-btn" onClick={() => setAdding(!adding)}><Icon name="plus" /> 添加站点</button>
                )}
              </h2>
              {c.id === "custom" && adding && (
                <AddSite
                  onCancel={() => setAdding(false)}
                  onAdd={async (s) => {
                    await save({ ...prefs, custom: [...prefs.custom, s] });
                    setSites(await toolbox().toolboxSites());
                    setAdding(false);
                  }}
                />
              )}
              {list.length ? <ul className="tb-grid">{list.map(card)}</ul> : c.id === "custom" && !adding && <p className="hint">还没有。可以把你常用的 AI 网站加进来。</p>}
            </section>
          );
        })}
        {prefs.hidden.length > 0 && (
          <button type="button" className="link-btn tb-self-start" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "收起已隐藏的" : `显示已隐藏的 ${prefs.hidden.length} 个`}
          </button>
        )}
        <p className="hint">卡片可以拖动排序。点卡片单独打开；勾选几家再点「发给」，就会并排对比。没有标「复制粘贴」的站点会直接带上你的问题。</p>
      </div>
    </main>
  );
});

function AddSite({ onCancel, onAdd }: { onCancel(): void; onAdd(s: AiSite): Promise<void> }) {
  const [name, setName] = useState("");
  const [home, setHome] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const homeOk = /^https?:\/\/[^\s/]+/i.test(home.trim());
  const queryOk = !query.trim() || (/^https?:\/\//i.test(query.trim()) && query.includes("{q}"));
  return (
    <form
      className="tb-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !homeOk || !queryOk) return;
        void onAdd({ id: `custom-${Date.now()}`, name: name.trim(), category: "custom", home: home.trim(), query: query.trim() || undefined, login: "optional" }).catch((err) => setError(cleanError(err)));
      }}
    >
      <label><span>名字</span><input className="rs-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：我常用的搜索" /></label>
      <label><span>首页</span><input className="rs-input" value={home} onChange={(e) => setHome(e.target.value)} placeholder="https://…" /></label>
      <label className="wide">
        <span>带问题的网址（可以不填）</span>
        <input className="rs-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="https://example.com/search?q={q}" />
      </label>
      <p className="hint wide">网址里用 {"{q}"} 代表问题。不填的话，打开首页时会把问题复制好，你粘贴就行。只支持 http / https。</p>
      {(!homeOk && home) || !queryOk ? <p className="warn-text wide">{!homeOk && home ? "首页要以 http:// 或 https:// 开头。" : "带问题的网址要以 http(s):// 开头，并且包含 {q}。"}</p> : null}
      {error && <p className="err-text wide">{error}</p>}
      <div className="rs-actions wide">
        <span className="spacer" />
        <button type="button" className="mini-btn" onClick={onCancel}>取消</button>
        <button type="submit" className="send rs-accent" disabled={!name.trim() || !homeOk || !queryOk}>添加</button>
      </div>
    </form>
  );
}
