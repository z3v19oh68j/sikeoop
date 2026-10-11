import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CN_TOUCHES, MANUAL, type ManualGo, type ManualItem } from "@shared/manual";
import { Icon } from "./Icon";
import { TOUR_EVENT, type TourChapter } from "./Tour";

// 帮助: the beginner's manual (shared/manual.ts) with search, a "带我去" button on each feature, the
// tour replays, and the touches made for Chinese users. "带我去" presses the real button in the
// left bar, so each screen opens exactly as it does by hand.

const BUTTON: Record<Exclude<ManualGo, "tour-start" | "tour-work">, string> = {
  start: "首页",
  work: "文件",
  studio: "原型工坊",
  wiki: "项目百科",
  graph: "知识图谱",
  group: "Agent 群聊",
  automation: "自动化",
  cluster: "鸿蒙集群",
  usage: "用量统计",
  partners: "全部伙伴",
  resources: "资源库",
  plugins: "插件",
  android: "Android 模拟器",
  context: "记忆与代码索引",
  settings: "设置",
};

const CN = "cn";

function press(label: string): boolean {
  const b = document.querySelector<HTMLButtonElement>(`.activitybar [aria-label="${label}"]`);
  if (!b || b.disabled) return false;
  b.click();
  return true;
}

export function HelpCenter({ onClose }: { onClose(): void }) {
  const [section, setSection] = useState(MANUAL[0].id);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return MANUAL.flatMap((s) =>
      s.items.filter((i) => [i.title, i.body, i.where, i.try, i.keys].join(" ").toLowerCase().includes(q)).map((i) => ({ section: s.title, item: i })),
    );
  }, [query]);

  function go(target: ManualGo) {
    setNote("");
    if (target === "tour-start" || target === "tour-work") {
      const chapter: TourChapter = target === "tour-start" ? "start" : "work";
      if (!press(chapter === "start" ? "首页" : "文件")) return setNote("先打开一个项目，才能看项目里那一段教程。");
      onClose();
      // Let the screen render before the spotlight looks for its targets.
      setTimeout(() => window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: chapter })), 300);
      return;
    }
    if (!press(BUTTON[target])) return setNote("这个功能要先打开一个项目。");
    onClose();
  }

  const current = MANUAL.find((s) => s.id === section);
  return createPortal(
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="help-center" role="dialog" aria-label="帮助">
        <header>
          <Icon name="book" />
          <b>新手手册</b>
          <input
            id="help-search"
            className="help-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜一搜，比如：撤销、语音、Key"
            aria-label="搜索手册"
            autoFocus
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            <Icon name="close" />
          </button>
        </header>
        <div className="help-body">
          <nav className="help-nav" aria-label="手册目录">
            {MANUAL.map((s) => (
              <button key={s.id} type="button" className={!hits && section === s.id ? "on" : ""} onClick={() => (setQuery(""), setSection(s.id))}>
                {s.title}
              </button>
            ))}
            <button type="button" className={"cn" + (!hits && section === CN ? " on" : "")} onClick={() => (setQuery(""), setSection(CN))}>
              为华人准备的小巧思
            </button>
            <div className="help-tours">
              <span>重看教程</span>
              <button type="button" className="mini-btn" onClick={() => go("tour-start")}>
                首页那段
              </button>
              <button type="button" className="mini-btn" onClick={() => go("tour-work")}>
                项目里那段
              </button>
            </div>
          </nav>
          <div className="help-main">
            {note && <p className="err-text">{note}</p>}
            {hits ? (
              <>
                <p className="hint">{hits.length ? `找到 ${hits.length} 条` : "没找到。换个说法试试，比如「模型」「截图」「省钱」。"}</p>
                {hits.map(({ section: s, item }) => (
                  <Entry key={item.id} item={item} section={s} onGo={go} />
                ))}
              </>
            ) : section === CN ? (
              <>
                <h2>为华人准备的小巧思</h2>
                <p className="hint">这些是 sikeoop 特意为国内用户做的。</p>
                <div className="cn-list">
                  {CN_TOUCHES.map((t) => (
                    <div key={t.title} className="help-entry">
                      <b>{t.title}</b>
                      <p>{t.body}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              current && (
                <>
                  <h2>{current.title}</h2>
                  <p className="hint">{current.intro}</p>
                  {current.items.map((item) => (
                    <Entry key={item.id} item={item} onGo={go} />
                  ))}
                </>
              )
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Entry({ item, section, onGo }: { item: ManualItem; section?: string; onGo(g: ManualGo): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <article className="help-entry">
      <div className="help-entry-head">
        <b>{item.title}</b>
        {section && <span className="chip-soft">{section}</span>}
        <span className="spacer" />
        {item.go && (
          <button type="button" className="mini-btn" onClick={() => onGo(item.go!)}>
            {item.go.startsWith("tour") ? "开始" : "带我去"}
          </button>
        )}
      </div>
      <p>{item.body}</p>
      {item.where && <p className="help-where">在哪：{item.where}</p>}
      {item.try && (
        <div className="help-try">
          <span>试试这样说：</span>
          <code>{item.try}</code>
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              void navigator.clipboard.writeText(item.try!).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => {},
              )
            }
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}
    </article>
  );
}
