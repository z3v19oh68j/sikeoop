import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./Icon";
import "../styles/sidebar.css";

/**
 * The left bar as stacked bookmarks. Everyday entries (首页, 文件, 帮助, 设置) are pinned and always
 * visible; the rest sit in a few stacks that fan out into labelled bookmarks on hover or keyboard focus.
 * The bar keeps its old 48px width; fanned-out bookmarks float over the content.
 */

export type NavId =
  | "home"
  | "files"
  | "studio"
  | "wiki"
  | "graph"
  | "archive"
  | "group"
  | "partners"
  | "automation"
  | "resident"
  | "dispatch"
  | "research"
  | "papers"
  | "pv"
  | "toolbox"
  | "imgprompts"
  | "cheatshop"
  | "cluster"
  | "regress"
  | "usage"
  | "mobile"
  | "remote"
  | "android"
  | "plugins"
  | "resources"
  | "extensions"
  | "context"
  | "help"
  | "settings";

/** What App tells the bar about each entry. */
export interface NavEntry {
  /** This entry's page or dialog is showing. */
  on: boolean;
  disabled?: boolean;
  /** Not offered at all (unfinished features outside development). */
  hidden?: boolean;
  run(): void;
}

interface Meta {
  label: string;
  icon: string;
  /** Hover text. */
  title: string;
  /** Needs an open project (shown when disabled). */
  needsProject?: boolean;
}

const META: Record<NavId, Meta> = {
  home: { label: "首页", icon: "home", title: "首页" },
  files: { label: "文件", icon: "files", title: "文件", needsProject: true },
  studio: { label: "原型工坊", icon: "frame", title: "原型工坊", needsProject: true },
  wiki: { label: "项目百科", icon: "book", title: "项目百科：AI 写的项目说明书和架构图", needsProject: true },
  graph: { label: "知识图谱", icon: "graph", title: "知识图谱：把项目代码或开发文档拆成节点关系图", needsProject: true },
  archive: { label: "归档项目", icon: "archive", title: "归档项目：打包成一个 zip 存起来", needsProject: true },
  group: { label: "Agent 群聊", icon: "group", title: "Agent 群聊：几位 AI 一起讨论" },
  partners: { label: "全部伙伴", icon: "heart", title: "全部伙伴" },
  automation: { label: "自动化", icon: "clock", title: "自动化：按时间表自动运行的任务" },
  resident: { label: "超级常驻", icon: "refresh", title: "超级常驻：用订阅账号一轮接一轮地自己学习和迭代" },
  toolbox: { label: "百宝箱", icon: "panel-right", title: "百宝箱：一个问题同时问好几家 AI 搜索，并排对比" },
  imgprompts: { label: "提示词库", icon: "sparkle", title: "提示词库：精选的图片生成提示词，带配图和出处" },
  cheatshop: { label: "外挂工坊", icon: "hook", title: "外挂工坊：游戏逆向 / 自建 lab / CTF 模板集，章节化浏览与复制" },
  pv: { label: "PV 工坊", icon: "play", title: "PV 工坊：需求、脚本、分镜到出片，用 AI 做宣传片" },
  papers: { label: "论文工坊", icon: "file", title: "论文工坊：读论文、翻译总结、转证据库、润色写作" },
  research: { label: "深度科研", icon: "eye-search", title: "深度科研：几个 AI 围绕一个问题互相挑错，留下站得住的结论" },
  dispatch: { label: "调度台", icon: "rocket", title: "调度台：派给各个 AI 的任务、进度和验收结果" },
  cluster: { label: "鸿蒙集群", icon: "list-check", title: "鸿蒙集群控制台：查看分派出去的子代理" },
  regress: { label: "测试与回归", icon: "shield-check", title: "测试与回归：让 AI 帮你检查功能有没有改坏" },
  usage: { label: "用量统计", icon: "chart", title: "用量统计：每天用了多少 token" },
  mobile: { label: "手机", icon: "phone", title: "手机：用 sikeoop 安卓 App 遥控这台电脑" },
  remote: { label: "微信远程控制", icon: "send", title: "微信远程控制：在手机微信里给 AI 布置任务" },
  android: { label: "Android 模拟器", icon: "android", title: "Android 模拟器" },
  plugins: { label: "插件", icon: "plugin", title: "插件：技能和 MCP" },
  resources: { label: "资源库", icon: "gift", title: "资源库：一键安装好用的技能" },
  extensions: { label: "扩展", icon: "index", title: "扩展：从 Open VSX 装主题、语法高亮和代码片段" },
  context: { label: "记忆与代码索引", icon: "brain", title: "记忆与代码索引" },
  help: { label: "帮助", icon: "help", title: "帮助：新手手册和教程" },
  settings: { label: "设置", icon: "settings", title: "设置" },
};

interface Stack {
  id: string;
  label: string;
  icon: string;
  items: NavId[];
}

const PINNED_TOP: NavId[] = ["home", "files"];
const STACKS: Stack[] = [
  { id: "project", label: "项目", icon: "folder-open", items: ["studio", "pv", "wiki", "graph", "archive"] },
  { id: "ai", label: "AI 协作", icon: "thought", items: ["group", "partners", "automation", "resident", "dispatch", "cluster", "regress"] },
  // 科研: dev builds only for now (both entries are hidden otherwise, which hides the stack).
  { id: "science", label: "科研", icon: "stethoscope", items: ["papers", "research"] },
  { id: "devices", label: "连接设备", icon: "globe", items: ["mobile", "remote", "android"] },
  { id: "tools", label: "工具", icon: "point-up", items: ["toolbox", "imgprompts", "cheatshop", "usage"] },
  { id: "extend", label: "扩展能力", icon: "sparkle", items: ["plugins", "resources", "extensions", "context"] },
];
const PINNED_BOTTOM: NavId[] = ["help", "settings"];

const OPEN_DELAY = 70;
const CLOSE_DELAY = 180;

export function Sidebar({ entries }: { entries: Record<NavId, NavEntry> }) {
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const navRef = useRef<HTMLElement>(null);
  /** Focus we move ourselves (back to a stack after a click) must not fan it out again. */
  const quietFocus = useRef(false);

  const schedule = (id: string | null, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(id), delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const titleOf = (id: NavId) => (entries[id].disabled && META[id].needsProject ? "先打开一个项目" : META[id].title);

  /** Up / down walk every reachable bookmark; right opens a stack, left / Esc folds it back. */
  function onKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    const nav = navRef.current;
    if (!nav) return;
    const all = [...nav.querySelectorAll<HTMLButtonElement>("button[data-bm]")].filter(
      (b) => !b.disabled && !b.closest(".bm-flyout:not(.open)"),
    );
    const cur = document.activeElement as HTMLElement | null;
    const i = all.findIndex((b) => b === cur);
    const stackEl = cur?.closest<HTMLElement>(".bm-stack");
    const top = stackEl?.querySelector<HTMLButtonElement>(".bm-top");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!all.length) return;
      const next = all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length];
      next.focus();
    } else if (e.key === "ArrowRight" && cur === top && stackEl) {
      e.preventDefault();
      setOpen(stackEl.dataset.stack!);
      requestAnimationFrame(() => stackEl.querySelector<HTMLButtonElement>(".bm-flyout button[data-bm]:not(:disabled)")?.focus());
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && stackEl && cur !== top) {
      e.preventDefault();
      setOpen(null);
      quietFocus.current = true;
      top?.focus();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(null);
    }
  }

  const pinned = (id: NavId) => {
    const en = entries[id];
    if (en.hidden) return null;
    return (
      <button
        key={id}
        type="button"
        data-bm=""
        className={"bm-pin" + (en.on ? " on" : "")}
        title={titleOf(id)}
        aria-label={META[id].label}
        aria-current={en.on ? "page" : undefined}
        disabled={en.disabled}
        onClick={en.run}
      >
        <Icon name={META[id].icon} />
        <span className="bm-peek" aria-hidden="true">
          {META[id].label}
        </span>
      </button>
    );
  };

  const stack = (s: Stack, up = false) => {
    const items = s.items.filter((id) => !entries[id].hidden);
    if (!items.length) return null;
    const active = items.find((id) => entries[id].on);
    const isOpen = open === s.id;
    const layers = Math.min(items.length - 1, 2);
    return (
      <div
        key={s.id}
        className={"bm-stack" + (isOpen ? " open" : "") + (active ? " has-on" : "") + (up ? " up" : "")}
        data-stack={s.id}
        style={{ ["--layers" as string]: layers }}
        onMouseEnter={() => schedule(s.id, open ? 0 : OPEN_DELAY)}
        onMouseLeave={() => schedule(null, CLOSE_DELAY)}
        onFocus={(e) => {
          if (quietFocus.current) return void (quietFocus.current = false);
          if ((e.target as HTMLElement).matches(":focus-visible")) schedule(s.id, 0);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) schedule(null, 0);
        }}
      >
        <button
          type="button"
          data-bm=""
          className={"bm-top" + (active ? " on" : "")}
          title={active ? `${s.label}：${META[active].label}` : `${s.label}（${items.length} 项）`}
          aria-label={`${s.label}，${items.length} 项${active ? `，当前在「${META[active].label}」` : ""}`}
          aria-haspopup="true"
          aria-expanded={isOpen}
          onClick={() => {
            window.clearTimeout(timer.current);
            setOpen(isOpen ? null : s.id);
          }}
        >
          {Array.from({ length: layers }, (_, i) => (
            <span key={i} className="bm-layer" style={{ ["--d" as string]: i + 1 }} aria-hidden="true" />
          ))}
          <span className="bm-face">
            <Icon name={active ? META[active].icon : s.icon} />
          </span>
        </button>
        <div className={"bm-flyout" + (isOpen ? " open" : "")} role="group" aria-label={s.label}>
          <div className="bm-flyout-head" aria-hidden="true">
            <Icon name={s.icon} />
            {s.label}
            <span className="bm-flyout-count">{items.length}</span>
          </div>
          {items.map((id, i) => {
            const en = entries[id];
            return (
              <button
                key={id}
                type="button"
                data-bm=""
                className={"bm-item" + (en.on ? " on" : "")}
                style={{ ["--i" as string]: up ? items.length - 1 - i : i }}
                title={titleOf(id)}
                aria-label={META[id].label}
                aria-current={en.on ? "page" : undefined}
                disabled={en.disabled}
                tabIndex={isOpen ? 0 : -1}
                onClick={() => {
                  en.run();
                  window.clearTimeout(timer.current);
                  setOpen(null);
                  // Fold back and keep the keyboard on this stack.
                  quietFocus.current = true;
                  (navRef.current?.querySelector(`[data-stack="${s.id}"] .bm-top`) as HTMLButtonElement | null)?.focus();
                }}
              >
                <Icon name={META[id].icon} />
                <span className="bm-label">{META[id].label}</span>
                {id === "regress" && <span className="bm-tag">开发中</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <nav className="activitybar bm-bar" aria-label="导航" ref={navRef} onKeyDown={onKeyDown}>
      {PINNED_TOP.map(pinned)}
      <span className="bm-sep" aria-hidden="true" />
      {STACKS.map((s) => stack(s))}
      <span className="spacer" />
      {PINNED_BOTTOM.map(pinned)}
    </nav>
  );
}
