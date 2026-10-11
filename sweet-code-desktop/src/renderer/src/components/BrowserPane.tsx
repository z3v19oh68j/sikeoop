import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import type { BrowserFlow, BrowserAutomationState, BrowserEvent, BrowserHistoryItem, BrowserLogin, BrowserSettings } from "@shared/types";
import { Icon } from "./Icon";
import { FlowsPanel } from "./BrowserFlows";

// The built-in browser, a tab next to the code (or beside it in split view). The page is a
// <webview> in its own persistent session: cookies, site storage and logins are kept. The main
// process (browser/service.ts) keeps the history and the saved logins, and gives the agent its
// view of the page. Passwords never come here: this pane only learns that a login can be saved or
// filled, by origin and username.

const ENGINE_LABEL: Record<BrowserSettings["engine"], string> = { bing: "必应", baidu: "百度", google: "Google" };

interface Props {
  /** A page to show: set by the app (agent, terminal, a link); n changes on every request. */
  request: { url: string; n: number } | null;
  split: boolean;
  onToggleSplit(): void;
  onClose(): void;
}

export function BrowserPane({ request, split, onToggleSplit, onClose }: Props) {
  const view = useRef<WebviewTag | null>(null);
  const [ready, setReady] = useState(false);
  const [address, setAddress] = useState("");
  const [page, setPage] = useState({ url: "about:blank", title: "", loading: false, back: false, forward: false });
  const [login, setLogin] = useState<{ origin: string; logins: BrowserLogin[] } | null>(null);
  const [offer, setOffer] = useState<{ origin: string; username: string; update: boolean } | null>(null);
  const [menu, setMenu] = useState<null | "more" | "keys">(null);
  const [failed, setFailed] = useState("");
  const [flowsOpen, setFlowsOpen] = useState(false);
  /** The script being recorded, if any. */
  const [recording, setRecording] = useState<string | null>(null);
  const [recNote, setRecNote] = useState("");
  const editing = useRef(false);

  // Page events.
  useEffect(() => {
    const w = view.current;
    if (!w) return;
    const sync = () => {
      const url = w.getURL();
      setPage({ url, title: w.getTitle(), loading: w.isLoading(), back: w.canGoBack(), forward: w.canGoForward() });
      if (!editing.current) setAddress(url === "about:blank" ? "" : url);
    };
    const onReady = () => {
      setReady(true);
      sync();
    };
    const onFail = (e: Event) => {
      const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      // -3 is an aborted load (a new navigation started): not an error.
      if (ev.isMainFrame && ev.errorCode !== -3) setFailed(`打不开 ${ev.validatedURL}（${ev.errorDescription}）`);
    };
    const onStart = () => {
      setFailed("");
      setLogin(null);
      sync();
    };
    w.addEventListener("dom-ready", onReady);
    w.addEventListener("did-start-loading", onStart);
    w.addEventListener("did-stop-loading", sync);
    w.addEventListener("did-navigate", sync);
    w.addEventListener("did-navigate-in-page", sync);
    w.addEventListener("page-title-updated", sync);
    w.addEventListener("did-fail-load", onFail);
    return () => {
      w.removeEventListener("dom-ready", onReady);
      w.removeEventListener("did-start-loading", onStart);
      w.removeEventListener("did-stop-loading", sync);
      w.removeEventListener("did-navigate", sync);
      w.removeEventListener("did-navigate-in-page", sync);
      w.removeEventListener("page-title-updated", sync);
      w.removeEventListener("did-fail-load", onFail);
    };
  }, []);

  // Login forms and save offers, from the main process.
  useEffect(
    () =>
      window.sweet.onBrowser((e: BrowserEvent) => {
        if (e.type === "login-form") setLogin(e.present ? { origin: e.origin, logins: e.logins } : null);
        else if (e.type === "offer-login") setOffer({ origin: e.origin, username: e.username, update: e.update });
      }),
    [],
  );

  // A requested page, once the webview can load it.
  useEffect(() => {
    if (!request || !ready || !view.current) return;
    void view.current.loadURL(request.url).catch(() => {});
  }, [request, ready]);

  async function go(input: string) {
    const w = view.current;
    if (!w || !input.trim()) return;
    editing.current = false;
    const url = await window.sweet.browserToUrl(input);
    void w.loadURL(url).catch(() => {});
    w.focus();
  }

  const blank = page.url === "about:blank" && !page.loading;
  const host = (() => {
    try {
      return new URL(page.url).host;
    } catch {
      return "";
    }
  })();

  return (
    <section className={"browser-pane" + (split ? " split" : "")} aria-label="内置浏览器">
      <AutomationBar />
      {recording !== null && <RecordingBar onSaved={(f) => { setRecording(null); setRecNote(`已保存「${f.name}」，共 ${f.steps.length} 步。在「脚本」里可以运行。`); setTimeout(() => setRecNote(""), 5000); }} />}
      {recNote && <div className="rec-note" role="status">{recNote}</div>}
      <div className="browser-bar">
        <button type="button" className="icon-btn square" disabled={!page.back} onClick={() => view.current?.goBack()} title="后退" aria-label="后退">
          <Icon name="chevron-left" />
        </button>
        <button type="button" className="icon-btn square" disabled={!page.forward} onClick={() => view.current?.goForward()} title="前进" aria-label="前进">
          <Icon name="chevron-right" />
        </button>
        <button
          type="button"
          className="icon-btn square"
          onClick={() => (page.loading ? view.current?.stop() : view.current?.reload())}
          title={page.loading ? "停止" : "刷新"}
          aria-label={page.loading ? "停止" : "刷新"}
        >
          <Icon name={page.loading ? "close" : "refresh"} />
        </button>
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            void go(address);
          }}
        >
          {page.url.startsWith("https:") ? <Icon name="lock" /> : <Icon name="globe" />}
          <input
            id="browser-address"
            value={address}
            onFocus={(e) => {
              editing.current = true;
              e.target.select();
            }}
            onBlur={() => (editing.current = false)}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="输入网址，或者直接搜索"
            aria-label="网址或搜索"
            spellCheck={false}
          />
          {login && login.logins.length > 0 && (
            <button type="button" className="icon-btn square key" onClick={() => setMenu(menu === "keys" ? null : "keys")} title="填入保存的账号" aria-label="填入保存的账号">
              <Icon name="key" />
            </button>
          )}
        </form>
        <button type="button" className={"icon-btn square" + (flowsOpen ? " on" : "")} onClick={() => setFlowsOpen(!flowsOpen)} title="浏览器脚本：录制和重放" aria-label="浏览器脚本">
          <Icon name="play" />
        </button>
        <button type="button" className={"icon-btn square" + (split ? " on" : "")} onClick={onToggleSplit} title={split ? "只看浏览器" : "和代码左右分屏"} aria-label="分屏">
          <Icon name="panel-right" />
        </button>
        <button type="button" className="icon-btn square" onClick={() => setMenu(menu === "more" ? null : "more")} title="历史、密码、设置" aria-label="浏览器菜单">
          <Icon name="more" />
        </button>
        <button type="button" className="icon-btn square" onClick={onClose} title="关闭浏览器" aria-label="关闭浏览器">
          <Icon name="close" />
        </button>
        {menu === "keys" && login && (
          <div className="browser-pop keys" role="menu">
            <span className="hint">{new URL(login.origin).host} 保存的账号</span>
            {login.logins.map((l) => (
              <button
                key={l.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void window.sweet.browserFillLogin(l.id);
                }}
              >
                <Icon name="key" /> {l.username || "（没有用户名）"}
              </button>
            ))}
          </div>
        )}
        {menu === "more" && <BrowserMenu onOpen={(u) => (setMenu(null), void go(u))} onClose={() => setMenu(null)} />}
      </div>

      {offer && (
        <div className="browser-offer" role="alert">
          <Icon name="key" />
          <span>
            {offer.update ? "更新" : "保存"} {new URL(offer.origin).host} 上「{offer.username || "这个账号"}」的密码？密码用系统钥匙串加密存在这台电脑上，AI 看不到。
          </span>
          <span className="spacer" />
          <button type="button" className="mini-btn" onClick={() => (setOffer(null), void window.sweet.browserAnswerOffer(false))}>
            不保存
          </button>
          <button type="button" className="send" onClick={() => (setOffer(null), void window.sweet.browserAnswerOffer(true))}>
            保存
          </button>
        </div>
      )}
      {failed && (
        <div className="browser-offer warn" role="alert">
          <Icon name="warning" />
          <span>{failed}</span>
        </div>
      )}

      {flowsOpen && <FlowsPanel onClose={() => setFlowsOpen(false)} recording={recording} onRecording={setRecording} />}
      <div className="browser-view">
        <webview ref={view as unknown as React.Ref<HTMLWebViewElement>} src="about:blank" partition="persist:sikeoop-browser" />
        {blank && <BrowserHome onOpen={(u) => void go(u)} />}
      </div>
      <div className="browser-status" aria-live="polite">
        {page.loading ? "正在加载…" : host ? `${page.title || host}` : "内置浏览器 · 登录状态和 Cookie 会保存在这台电脑上"}
      </div>
    </section>
  );
}

/** The empty tab: recent local pages first (the dev servers), then the rest of the history. */
function BrowserHome({ onOpen }: { onOpen(url: string): void }) {
  const [recent, setRecent] = useState<BrowserHistoryItem[]>([]);
  useEffect(() => {
    void window.sweet.browserHistory("").then((h) => {
      const seen = new Set<string>();
      const uniq = h.filter((x) => {
        const k = x.url.replace(/[?#].*$/, "");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const local = uniq.filter((x) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(x.url));
      setRecent([...local.slice(0, 4), ...uniq.filter((x) => !local.includes(x)).slice(0, 6)]);
    });
  }, []);
  return (
    <div className="browser-home">
      <Icon name="globe" />
      <b>内置浏览器</b>
      <p>在上面输入网址或者直接搜索。开发服务器跑起来时会自动打开它的地址；让 AI 去看页面、点按钮、查控制台报错也在这里。</p>
      {recent.length > 0 && (
        <ul>
          {recent.map((h) => (
            <li key={h.url}>
              <button type="button" onClick={() => onOpen(h.url)} title={h.url}>
                <span className="t">{h.title || h.url}</span>
                <span className="u">{h.url}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** ⋯: history, saved logins, the search engine, clearing data, DevTools. */
function BrowserMenu({ onOpen, onClose }: { onOpen(url: string): void; onClose(): void }) {
  const [tab, setTab] = useState<"history" | "logins" | "settings">("history");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<BrowserHistoryItem[]>([]);
  const [logins, setLogins] = useState<BrowserLogin[]>([]);
  const [settings, setSettings] = useState<BrowserSettings | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    void window.sweet.browserState().then((s) => {
      setSettings(s.settings);
      setLogins(s.logins);
    });
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void window.sweet.browserHistory(query).then(setHistory), 120);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="browser-pop more" role="dialog" aria-label="浏览器菜单">
      <div className="seg">
        <button type="button" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          历史记录
        </button>
        <button type="button" className={tab === "logins" ? "on" : ""} onClick={() => setTab("logins")}>
          保存的密码
        </button>
        <button type="button" className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          设置
        </button>
      </div>
      {tab === "history" && (
        <>
          <input id="browser-history-search" className="pop-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜历史记录" autoFocus />
          <ul className="pop-list">
            {history.length === 0 && <li className="hint">还没有记录。</li>}
            {history.map((h, i) => (
              <li key={`${h.url}-${i}`}>
                <button type="button" onClick={() => onOpen(h.url)} title={h.url}>
                  <span className="t">{h.title || h.url}</span>
                  <span className="u">
                    {new Date(h.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {h.url}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={() => void window.sweet.browserClearHistory().then(() => setHistory([]))}>
            清除历史记录
          </button>
        </>
      )}
      {tab === "logins" && (
        <>
          <p className="hint">密码用系统钥匙串加密，只存在这台电脑上。只有你在登录框点钥匙图标时才会填入，AI 看不到也用不了。</p>
          <ul className="pop-list">
            {logins.length === 0 && <li className="hint">还没有保存的密码。登录网站后会问你要不要保存。</li>}
            {logins.map((l) => (
              <li key={l.id} className="row">
                <span className="t">{l.username || "（没有用户名）"}</span>
                <span className="u">{l.origin}</span>
                <button type="button" className="icon-btn square" title="删除" aria-label={`删除 ${l.origin} 的 ${l.username}`} onClick={() => void window.sweet.browserRemoveLogin(l.id).then(setLogins)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === "settings" && settings && (
        <div className="pop-settings">
          <label>
            地址栏搜索用
            <select id="browser-engine" value={settings.engine} onChange={(e) => void window.sweet.browserSetSettings({ engine: e.target.value as BrowserSettings["engine"] }).then(setSettings)}>
              {(Object.keys(ENGINE_LABEL) as BrowserSettings["engine"][]).map((k) => (
                <option key={k} value={k}>
                  {ENGINE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            AI 操作浏览器的速度
            <select
              id="browser-speed"
              value={settings.automationSpeed ?? "normal"}
              onChange={(e) => void window.sweet.browserSetSettings({ ...settings, automationSpeed: e.target.value as NonNullable<BrowserSettings["automationSpeed"]> }).then(setSettings)}
            >
              <option value="demo">演示（慢，看得清每一步）</option>
              <option value="normal">正常</option>
              <option value="fast">极速（不显示光标动画）</option>
            </select>
          </label>
          <button type="button" className="mini-btn" onClick={() => void window.sweet.browserDevTools()}>
            打开开发者工具
          </button>
          {confirmClear ? (
            <div className="confirm">
              <span>会清掉历史记录、Cookie 和所有网站的登录状态（保存的密码不动）。</span>
              <button type="button" className="mini-btn" onClick={() => setConfirmClear(false)}>
                算了
              </button>
              <button
                type="button"
                className="send"
                onClick={() =>
                  void window.sweet.browserClearData().then(() => {
                    setConfirmClear(false);
                    setNote("清理好了。");
                  })
                }
              >
                清除
              </button>
            </div>
          ) : (
            <button type="button" className="mini-btn" onClick={() => setConfirmClear(true)}>
              清除浏览数据
            </button>
          )}
          {note && <span className="hint">{note}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The thin bar on top while the AI drives the page: what it is doing, step i / n, pause / continue / stop.
 * If the user touches the page the backend pauses it; the bar then says so and offers to hand back.
 */
function AutomationBar() {
  const [st, setSt] = useState<BrowserAutomationState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.sweet.browserAutomationState().then(setSt);
    return window.sweet.onBrowserAutomation(setSt);
  }, []);
  // Finished runs fade out a moment later.
  useEffect(() => {
    if (st?.status !== "done") return;
    const t = setTimeout(() => setSt(null), 2500);
    return () => clearTimeout(t);
  }, [st]);
  if (!st || (st.status === "done" && !st.total && !st.description)) return null;
  const act = (fn: () => Promise<BrowserAutomationState>) => {
    setBusy(true);
    void fn().then(setSt).finally(() => setBusy(false));
  };
  // Structured reason first; older backends only had the text.
  const takenOver = st.status === "paused" && (st.pauseReason ? st.pauseReason === "user" : !!st.reason && /接手|user|input/i.test(st.reason));
  return (
    <div className={"auto-bar " + st.status} role="status" aria-live="polite">
      <span className="auto-dot" aria-hidden="true" />
      <span className="auto-text">
        {st.status === "paused"
          ? takenOver
            ? "你接手了，点「继续」交还给 AI"
            : st.pauseReason === "approval"
              ? `等你批准${st.reason ? `：${st.reason}` : ""}`
              : `已暂停${st.reason ? `：${st.reason}` : ""}`
          : st.status === "done"
            ? "做完了"
            : st.status === "error"
              ? `出错了${st.reason ? `：${st.reason}` : ""}`
              : `正在：${st.description || "操作网页"}`}
      </span>
      {st.total > 0 && (
        <span className="auto-step">
          第 {Math.max(1, st.step)}/{st.total} 步
        </span>
      )}
      <span className="auto-spacer" />
      {st.status === "running" && (
        <button type="button" className="auto-btn" disabled={busy} onClick={() => act(() => window.sweet.browserAutomationPause())}>
          暂停
        </button>
      )}
      {st.status === "paused" && st.pauseReason !== "approval" && (
        <button type="button" className="auto-btn" disabled={busy} onClick={() => act(() => window.sweet.browserAutomationResume())}>
          继续
        </button>
      )}
      {(st.status === "running" || st.status === "paused") && (
        <button type="button" className="auto-btn stop" disabled={busy} onClick={() => act(() => window.sweet.browserAutomationStop())}>
          停止
        </button>
      )}
      {st.status === "error" && (
        <button type="button" className="auto-btn" onClick={() => setSt(null)}>
          知道了
        </button>
      )}
    </div>
  );
}

/** While recording: a red bar; 「停止」 asks for the script's name, then saves (the backend checks the name). */
function RecordingBar({ onSaved }: { onSaved(f: BrowserFlow): void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setError("");
    setBusy(true);
    try {
      onSaved(await window.sweet.browserFlowStopRecording(name.trim()));
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rec-bar" role="status">
      <span className="bf-red pulse" aria-hidden="true" />
      {naming ? (
        <form className="rec-name" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
          <b>给脚本起个名字</b>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="比如：每日签到" autoFocus aria-label="脚本名字" />
          <button type="submit" className="auto-btn" disabled={!name.trim() || busy}>保存</button>
          <button type="button" className="auto-btn" onClick={() => { setNaming(false); setError(""); }}>继续录</button>
          {error && <span className="rec-err">{error}</span>}
        </form>
      ) : (
        <>
          <b>正在录制</b>
          <span className="rec-hint">你在这个网页上的点击和输入都会记下来（密码除外）</span>
          <span className="auto-spacer" />
          <button type="button" className="auto-btn stop" onClick={() => setNaming(true)}>停止</button>
        </>
      )}
    </div>
  );
}
