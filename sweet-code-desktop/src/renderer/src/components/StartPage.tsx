import { useEffect, useState } from "react";
import type { ProviderView, RecentProject } from "@shared/types";
import { characterFor } from "../home/characters";
import { Icon } from "./Icon";
import { isReady } from "./ProviderDialog";

interface Props {
  providers: ProviderView[];
  activeId: string;
  onOpenFolder(kind: "open" | "new"): void;
  onOpenRecent(path: string): void;
  onChoosePartner(id: string): void;
  onAllPartners(): void;
  /** Prefill the chat with a prompt (App switches to the work screen). */
  onAskAI?(text: string): void;
  /** Create and open a starter web project, then send the prompt to the AI. */
  onStartWeb?(title: string, prompt: string): Promise<void>;
}

const WEB_EXAMPLES = [
  { title: "奶茶店介绍页", emoji: "🧋", d: "菜单、地址、营业时间", prompt: "帮我做一个奶茶店的介绍网页：店名叫「甜甜奶茶」，要有招牌饮品菜单和价格、店铺地址、营业时间，整体可爱温暖一点，手机上看也要好看。" },
  { title: "个人主页", emoji: "🙋", d: "介绍自己、作品、联系方式", prompt: "帮我做一个个人主页：有我的名字和一句话介绍、几个兴趣爱好、作品展示区和联系方式，风格简洁清爽，手机上看也要好看。" },
  { title: "活动邀请函", emoji: "💌", d: "时间、地点、报名方式", prompt: "帮我做一个活动邀请函网页：写清楚活动主题、时间、地点和流程，加一个醒目的「我要参加」按钮，风格温馨有仪式感，手机上看也要好看。" },
];

/** The first screen: open a project, pick a partner, or reopen a recent project. */
export function StartPage({ providers, activeId, onOpenFolder, onOpenRecent, onChoosePartner, onAllPartners, onAskAI, onStartWeb }: Props) {
  const [webBusy, setWebBusy] = useState(false);

  const startWeb = async (title: string, prompt?: string) => {
    if (webBusy) return;
    setWebBusy(true);
    try {
      await onStartWeb?.(title, prompt ?? "帮我做一个网页，先问我几个简单的问题：这个网页是给谁看的、想放哪些内容、喜欢什么风格。");
    } finally {
      setWebBusy(false);
    }
  };

  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  useEffect(() => {
    void window.sweet.listRecent().then(setRecent);
  }, []);

  // The current partner first, then the ones ready to go, then the rest.
  const rank = (p: ProviderView) => (p.id === activeId ? 0 : isReady(p) ? 1 : 2);
  const cards = providers
    .filter((p) => characterFor(p.id))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 4);

  return (
    <main className="start">
      <div className="start-inner">
        <div className="start-hero">
          <span className="mark">
            <Icon name="heart" />
          </span>
          <div>
            <h1>sikeoop</h1>
            <p>说出你想做的东西，剩下的交给 AI。</p>
          </div>
        </div>

        <section className="start-web" aria-label="做一个网页">
          <button type="button" className="start-web-main" disabled={webBusy} onClick={() => void startWeb("我的网页")}>
            <span className="mark">
              <Icon name="globe" />
            </span>
            <span className="txt">
              <span className="t">{webBusy ? "正在准备…" : "做一个网页"}</span>
              <span className="d">不用懂代码，说说你想要什么，做好一键发到网上</span>
            </span>
            <Icon name="chevron-right" />
          </button>
          <div className="start-web-examples">
            <span className="hint">不知道做什么？试试这些：</span>
            <div className="cards">
              {WEB_EXAMPLES.map((x) => (
                <button key={x.title} type="button" className="start-web-card" disabled={webBusy} onClick={() => void startWeb(x.title, x.prompt)}>
                  <span className="e" aria-hidden="true">{x.emoji}</span>
                  <span className="t">{x.title}</span>
                  <span className="d">{x.d}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="start-actions">
          <button type="button" className="start-action" onClick={() => onOpenFolder("open")}>
            <Icon name="folder-open" />
            <span>
              <span className="t">打开项目</span>
              <br />
              <span className="d">选电脑上的一个文件夹</span>
            </span>
          </button>
          <button type="button" className="start-action" onClick={() => onOpenFolder("new")}>
            <Icon name="folder-plus" />
            <span>
              <span className="t">新建项目</span>
              <br />
              <span className="d">新建一个空文件夹，从一句话开始做</span>
            </span>
          </button>
        </div>

        <section className="start-section" aria-label="伙伴">
          <div className="start-section-head">
            <h2>今天让谁陪你写</h2>
            <span className="sub">每位伙伴对应一个模型，随时能换</span>
            <span className="spacer" />
            <button type="button" className="icon-btn" onClick={onAllPartners}>
              全部 {providers.filter((p) => characterFor(p.id)).length} 位 <Icon name="chevron-right" />
            </button>
          </div>
          <div className="partner-cards">
            {cards.map((p) => {
              const c = characterFor(p.id)!;
              const ready = isReady(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={p.id === activeId}
                  className={"partner-card" + (p.id === activeId ? " on" : "")}
                  onClick={() => onChoosePartner(p.id)}
                >
                  <span className="art" style={c.art ? undefined : { background: `linear-gradient(160deg, ${c.card[0]}, ${c.card[1]})` }}>
                    {c.art ? <img src={c.art} alt="" /> : <span className="initial">{c.name.slice(0, 1)}</span>}
                  </span>
                  <span className="info">
                    <span className="name">
                      {c.name}
                      <span className={"ready-dot" + (ready ? " on" : "")} title={ready ? "可以用" : "还没设置好"} />
                    </span>
                    <span className="sub">
                      {p.name} · {ready ? p.model : p.authMode === "login" ? "还没登录" : !p.model ? "还没选模型" : "还没填 Key"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {recent && recent.length > 0 && (
          <section className="start-section" aria-label="最近的项目">
            <div className="start-section-head">
              <h2>最近的项目</h2>
            </div>
            <div className="recent-list">
              {recent.map((r) => (
                <div key={r.path} className="recent-row">
                  <button
                    type="button"
                    className="open"
                    disabled={!r.exists}
                    title={r.exists ? r.path : "这个文件夹找不到了，可能被移动或删除了"}
                    onClick={() => onOpenRecent(r.path)}
                  >
                    <span className="n">{r.name}</span>
                    <span className="p">{tildify(r.path)}</span>
                    <span className="when">{r.exists ? timeAgo(r.openedAt) : "找不到了"}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn square"
                    aria-label={`从列表里移除 ${r.name}`}
                    title="从列表里移除（不会删除文件）"
                    onClick={() => void window.sweet.removeRecent(r.path).then(setRecent)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function tildify(p: string): string {
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/i, "~");
}

export function timeAgo(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d === 1 ? "昨天" : d < 30 ? `${d} 天前` : new Date(ts).toLocaleDateString();
}
