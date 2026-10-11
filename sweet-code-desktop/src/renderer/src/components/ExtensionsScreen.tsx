import { useEffect, useRef, useState } from "react";
import type { ExtensionSearchItem, InstalledExtension } from "@shared/types";
import { currentEditorTheme, editorThemes, onExtensionsApplied, setEditorTheme } from "../extensions";
import { Icon } from "./Icon";
import { SKINS, setSkin, useSkin } from "../skin";
import "../styles/extensions.css";

// The「扩展」page: search Open VSX, install, enable/disable, remove, and pick the editor theme.
// Only themes, syntax highlighting, language settings and snippets are used; extension code never runs.

const fmtCount = (n?: number) => (n === undefined ? "" : n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : String(n));

function summaryText(e: InstalledExtension): string {
  const s = e.summary;
  const parts = [
    s.themes && `${s.themes} 个主题`,
    s.grammars && `${s.grammars} 套语法高亮`,
    s.languages && `${s.languages} 种语言设置`,
    s.snippets && `${s.snippets} 组代码片段`,
  ].filter(Boolean);
  return parts.length ? `带来：${parts.join("、")}` : "没有 sikeoop 能用的内容（主题、语法、片段）";
}

export function ExtensionsScreen({ hidden }: { hidden: boolean }) {
  const [tab, setTab] = useState<"search" | "installed">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ total: number; items: ExtensionSearchItem[] } | null>(null);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [themes, setThemes] = useState(editorThemes());
  const [theme, setTheme] = useState(currentEditorTheme());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const searched = useRef(false);
  const skin = useSkin();

  const fail = (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

  const search = async (q: string) => {
    setLoading(true);
    setError("");
    try {
      setResults(await window.sweet.extSearch(q));
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void window.sweet.extInstalled().then(setInstalled);
    return onExtensionsApplied(() => {
      setThemes(editorThemes());
      setTheme(currentEditorTheme());
    });
  }, []);

  // First visit: show popular extensions.
  useEffect(() => {
    if (hidden || searched.current) return;
    searched.current = true;
    void search("");
  }, [hidden]);

  const act = async (id: string, f: () => Promise<InstalledExtension[]>) => {
    setWorking(id);
    setError("");
    try {
      setInstalled(await f());
    } catch (e) {
      fail(e);
    } finally {
      setWorking(null);
    }
  };

  const isInstalled = (id: string) => installed.find((e) => e.id.toLowerCase() === id.toLowerCase());

  return (
    <main className="usage ext" hidden={hidden}>
      <div className="usage-inner">
        <div className="usage-head">
          <h1>扩展</h1>
          <span className="ext-source">来自 Open VSX</span>
          <span className="spacer" />
          <label className="ext-theme">
            <span>皮肤</span>
            <select value={skin.id} onChange={(e) => setSkin(e.target.value)}>
              {SKINS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ext-theme">
            <span>编辑器主题</span>
            <select
              value={theme}
              onChange={(e) => {
                setTheme(e.target.value);
                setEditorTheme(e.target.value);
              }}
            >
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.source !== "内置" ? `（${t.source}）` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="ext-note">
          <Icon name="shield-check" />
          sikeoop 只用扩展里的主题、语法高亮、语言设置和代码片段，扩展自带的程序不会下载到电脑上，也不会运行。需要运行程序的扩展（比如调试器、Git 工具）装了也只有这几样能用。
        </p>

        <div className="ext-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : undefined} onClick={() => setTab("search")}>
            搜索
          </button>
          <button type="button" role="tab" aria-selected={tab === "installed"} className={tab === "installed" ? "on" : undefined} onClick={() => setTab("installed")}>
            已安装 · {installed.length}
          </button>
        </div>

        {error && (
          <p className="mobile-banner bad" role="alert">
            <Icon name="warning" />
            {error}
          </p>
        )}

        {tab === "search" && (
          <section className="ext-search">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search(query);
              }}
            >
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜主题或语言，比如 dracula、one dark、toml、vue" aria-label="搜索扩展" spellCheck={false} />
              <button type="submit" className="neu-btn primary" disabled={loading}>
                {loading ? "搜索中…" : "搜索"}
              </button>
            </form>
            {results && (
              <p className="ext-count">{query.trim() ? `找到 ${results.total} 个` : "下载最多的扩展"}</p>
            )}
            <ul className="ext-list">
              {results?.items.map((it) => {
                const have = isInstalled(it.id);
                return (
                  <li key={it.id}>
                    {it.iconUrl ? <img src={it.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="ext-icon-ph"><Icon name="plugin" /></span>}
                    <div className="ext-text">
                      <b>
                        {it.displayName}
                        {it.verified && <span className="ext-verified" title="Open VSX 验证过的发布者">已验证</span>}
                      </b>
                      <span className="ext-meta">
                        {it.namespace} · v{it.version}
                        {it.downloads !== undefined && ` · 下载 ${fmtCount(it.downloads)}`}
                      </span>
                      {it.description && <span className="ext-desc">{it.description}</span>}
                    </div>
                    {have ? (
                      <span className="ext-installed">已安装</span>
                    ) : (
                      <button type="button" className="neu-btn" disabled={!!working} onClick={() => void act(it.id, () => window.sweet.extInstall(it.id))}>
                        {working === it.id ? "安装中…" : "安装"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {working && <p className="ext-count">从 Open VSX 下载，网络慢的时候要等一会儿…</p>}
          </section>
        )}

        {tab === "installed" && (
          <section>
            {installed.length === 0 ? (
              <p className="ext-count">还没有安装扩展。去「搜索」里找个喜欢的主题试试。</p>
            ) : (
              <ul className="ext-list">
                {installed.map((e) => (
                  <li key={e.id} className={e.enabled ? undefined : "off"}>
                    <span className="ext-icon-ph">
                      <Icon name="plugin" />
                    </span>
                    <div className="ext-text">
                      <b>{e.displayName}</b>
                      <span className="ext-meta">
                        {e.publisher} · v{e.version}
                        {e.license && ` · ${e.license}`}
                      </span>
                      <span className="ext-desc">{summaryText(e)}</span>
                      {e.summary.hasCode && <span className="ext-warn">它还带程序部分，sikeoop 不运行，所以这部分功能没有。</span>}
                      {e.summary.iconThemes > 0 && <span className="ext-warn">文件图标主题暂时还用不了。</span>}
                      {e.licenseNote && <span className="ext-warn">{e.licenseNote}</span>}
                    </div>
                    <div className="mobile-actions">
                      <button type="button" className="neu-btn" disabled={!!working} onClick={() => void act(e.id, () => window.sweet.extSetEnabled(e.id, !e.enabled))}>
                        {e.enabled ? "停用" : "启用"}
                      </button>
                      <button type="button" className="neu-btn" disabled={!!working} onClick={() => void act(e.id, () => window.sweet.extInstall(e.id))}>
                        {working === e.id ? "更新中…" : "更新"}
                      </button>
                      {confirmRemove === e.id ? (
                        <>
                          <button type="button" className="neu-btn" onClick={() => setConfirmRemove(null)}>
                            算了
                          </button>
                          <button type="button" className="neu-btn danger" onClick={() => (setConfirmRemove(null), void act(e.id, () => window.sweet.extUninstall(e.id)))}>
                            确定卸载
                          </button>
                        </>
                      ) : (
                        <button type="button" className="neu-btn" onClick={() => setConfirmRemove(e.id)} aria-label={`卸载 ${e.displayName}`}>
                          <Icon name="trash" />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
