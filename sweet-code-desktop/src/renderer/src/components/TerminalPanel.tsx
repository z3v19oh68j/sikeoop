import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { AgentCliId, AgentKinds, AgentSessionView, MemberExitCode } from "@shared/types";
import { Icon } from "./Icon";
import { CrossSessionDialog } from "./CrossSessionDialog";
import { CrossSessionMenu } from "./CrossSessionMenu";
import { CrossSessionPanel } from "./CrossSessionPanel";
import { getSkin, onSkinChange } from "../skin";
import { SHOW_UNFINISHED } from "../unfinished";
import { sessionApi, sessionTabId, type CrossSession } from "./crossSession";
import { emptyLine, startsCli, typeInto } from "./typedCommand";

/** Other parts of the app (chat code blocks) ask the terminal to run a command through this event. */
export const RUN_IN_TERMINAL = "sweet:run-in-terminal";

type Mode = "shell" | AgentCliId;
/** What each CLI is called. Extension CLIs are added when the list is loaded (termAgentKinds). */
const cliNames = new Map<string, string>([["claude", "Claude Code"], ["codex", "Codex"]]);
const cliName = (id: string) => cliNames.get(id) ?? id;

/** Asks the terminal panel to start Claude Code in workspace mode. */
export const START_CLAUDE = "sweet:start-claude";

/** Returns false when no terminal is open to take the command (no project yet). */
export function runInTerminal(command: string): boolean {
  const ev = new CustomEvent(RUN_IN_TERMINAL, { detail: command, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

interface Props {
  /** Fill the work area with the terminal, or go back. */
  maximized?: boolean;
  onMaximize?(): void;
  /** The project folder the terminal starts in, shown in the header. */
  cwd?: string;
  visible: boolean;
  onShow(): void;
  onHide(): void;
  /** Send the last screen of terminal output to the AI. */
  onAskAI(output: string): void;
}

// Matches the app's dark shell (styles/theme.css --bg). A full 16-colour palette tuned for the
// dark background: soft enough for long output, with the rose accent as magenta.
const THEME = {
  background: "#0f0f10",
  foreground: "#d4d4d9",
  cursor: "#f0789b",
  cursorAccent: "#0f0f10",
  selectionBackground: "rgba(240, 120, 155, 0.28)",
  selectionInactiveBackground: "rgba(240, 120, 155, 0.14)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.08)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.16)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
  black: "#2a2a30",
  red: "#f2767a",
  green: "#6fd69a",
  yellow: "#e8c27e",
  blue: "#82a8f5",
  magenta: "#f0789b",
  cyan: "#72c9d6",
  white: "#d4d4d9",
  brightBlack: "#6b6b74",
  brightRed: "#ff9a9d",
  brightGreen: "#94e6b5",
  brightYellow: "#f3d79f",
  brightBlue: "#a5c1ff",
  brightMagenta: "#ff9fbb",
  brightCyan: "#9be0ea",
  brightWhite: "#ffffff",
};

const HEIGHT_KEY = "sweet:terminal-height";
function savedHeight(): number {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || 240;
  } catch {
    return 240;
  }
}

interface Tab {
  id: string;
  mode: Mode;
  /** The agent session's name (Claude-1, Codex-2), its address for the others. */
  name?: string;
  exited: boolean;
  /** The CLI that couldn't start because it isn't installed: offer the one-click install. */
  missing: AgentCliId | null;
  /** Workspace-mode notes; kept above the terminal because the CLIs clear the screen. */
  notes: string[];
  /**
   * A cross-project session member's terminal (tab id s:<sessionId>:<agentId>), opened to watch.
   * The program is the session's, not this tab's: nothing is started, restarted or ended from
   * here, and keys go nowhere unless the user switches input on for a moment.
   */
  readOnly?: boolean;
  /** term:exit's code, kept for a read-only tab to say why the member is gone. */
  exitCode?: number;
  /** A shell tab where the user started a coding CLI by hand: sikeoop can't see it there. */
  byHand?: { id: AgentCliId; name: string };
}

/** CLIs the user has been told about once ("知道了"): not mentioned again until sikeoop restarts. */
const toldAbout = new Set<string>();

/** Why a member's program ended when sikeoop ended it; anything else means it exited by itself. */
const MEMBER_EXIT: Record<MemberExitCode, string> = { [-101]: "你把它移出了 session", [-102]: "这个 session 已经结束" };
const memberExitText = (code?: number) => MEMBER_EXIT[code as MemberExitCode] ?? `它自己退出了${code ? `（退出码 ${code}）` : ""}`;

const READ_ONLY_NOTE = "只读查看：这是跨项目 session 成员的终端，在这里打字不会发过去。它启动时如果在等你确认（比如是否信任目录），点右上角「临时允许输入」回答，答完再切回只读。";

let tabSeq = 0;
const newTab = (mode: Mode): Tab => ({ id: `t${++tabSeq}`, mode, exited: false, missing: null, notes: [] });

const STATUS_TEXT: Record<AgentSessionView["status"], string> = { starting: "启动中", working: "在干活", waiting: "等你", idle: "空闲" };

export function TerminalPanel({ cwd, visible, onShow, onHide, onAskAI, maximized, onMaximize }: Props) {
  /** Several tabs: shells, and Claude Code / Codex sessions that can message each other. */
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab("shell")]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [agents, setAgents] = useState<AgentSessionView[]>([]);
  /** 打开的跨项目 session 标签（id 为 cs:xxx，和终端的 t1、t2… 分开）。 */
  const [sessions, setSessions] = useState<{ id: string; title: string; ended: boolean }[]>([]);
  /** 当前显示的 session；有值时盖住终端标签。 */
  const [sessionOn, setSessionOn] = useState<string | null>(null);
  const [newSession, setNewSession] = useState(false);
  /** Claude Code, Codex and the extension CLIs; read again each time the "+" menu opens. */
  const [kinds, setKinds] = useState<AgentKinds | null>(null);
  const loadKinds = () =>
    void window.sweet.termAgentKinds().then(
      (k) => {
        for (const x of k.kinds) cliNames.set(x.id, x.name);
        setKinds(k);
      },
      () => {},
    );
  useEffect(loadKinds, []);
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  /** A command line entered in a shell tab: say so when it starts a CLI that the "+" menu could have started. */
  const onEntered = (tabId: string, command: string) => {
    const kind = startsCli(command, kindsRef.current?.kinds ?? []);
    if (kind && !toldAbout.has(kind.id)) patch(tabId, { byHand: { id: kind.id, name: kind.name } });
  };
  /** The read-only tab the user has let keys through to, for now. Off again as soon as they leave it. */
  const [typingIn, setTypingIn] = useState<string | null>(null);
  const [height, setHeight] = useState(savedHeight);
  const [resizing, setResizing] = useState(false);
  /** Each tab's xterm, for routing output and for the header buttons. */
  const terms = useRef(new Map<string, { term: Terminal; fit: FitAddon }>());
  // Terminals already open take the new colors when the skin changes.
  useEffect(
    () =>
      onSkinChange(() => {
        for (const { term } of terms.current.values()) term.options.theme = getSkin().terminal ?? THEME;
      }),
    [],
  );
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const openSession = (s: CrossSession) => {
    setSessions((xs) => (xs.some((x) => x.id === s.id) ? xs : [...xs, { id: s.id, title: s.title, ended: s.state === "ended" }]));
    setSessionOn(s.id);
    onShow();
  };
  const closeSessionTab = (id: string) => {
    setSessions((xs) => xs.filter((x) => x.id !== id));
    setSessionOn((cur) => (cur === id ? null : cur));
  };
  const onSessionChanged = (s: CrossSession) =>
    setSessions((xs) => xs.map((x) => (x.id === s.id ? { ...x, title: s.title, ended: s.state === "ended" } : x)));

  const patch = (id: string, change: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...change } : t)));

  // Output and exits arrive tagged with their tab.
  useEffect(() => {
    const offData = window.sweet.onTermData((tab, d) => terms.current.get(tab)?.term.write(d));
    const offExit = window.sweet.onTermExit((tab, code) => patch(tab, { exited: true, exitCode: code }));
    void window.sweet.termAgents().then(setAgents);
    const offAgents = window.sweet.onTermAgents(setAgents);
    // The main agent opens a Claude Code / Codex session to hand it work (start_agent).
    const offOpen = window.sweet.onTermOpenAgent((cli) => {
      onShow();
      addTab(cli);
    });
    // The island's session list: a click brings that tab forward.
    const offFocus = window.sweet.onTermFocus((tab) => {
      const known = tabsRef.current.find((t) => t.id === tab);
      if (!known) {
        if (tab.startsWith("s:")) void watchMember(tab);
        return;
      }
      onShow();
      setActiveId(tab);
      if (known.readOnly) {
        setSessionOn(null);
        // Its size again: the main process answers with the member's recent output.
        const t = terms.current.get(tab)?.term;
        if (t) window.sweet.termResize(tab, t.cols, t.rows);
      }
    });
    return () => {
      offData();
      offExit();
      offAgents();
      offFocus();
      offOpen();
    };
  }, [onShow]);

  // Code blocks in the chat can send a command here; the user clicked, so it runs in a shell tab.
  useEffect(() => {
    const onRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      e.preventDefault(); // tells runInTerminal the command was taken
      onShow();
      const shell = tabsRef.current.find((t) => t.id === activeId && t.mode === "shell") ?? tabsRef.current.find((t) => t.mode === "shell" && !t.exited);
      if (shell) {
        setActiveId(shell.id);
        window.sweet.termWrite(shell.id, cmd.replace(/\n+$/, "") + "\r");
        terms.current.get(shell.id)?.term.focus();
      } else {
        // No shell open: a new one, and the command once its prompt is up.
        const t = addTab("shell");
        setTimeout(() => window.sweet.termWrite(t.id, cmd.replace(/\n+$/, "") + "\r"), 700);
      }
    };
    window.addEventListener(RUN_IN_TERMINAL, onRun);
    const onClaude = () => {
      onShow();
      addTab("claude");
    };
    window.addEventListener(START_CLAUDE, onClaude);
    return () => {
      window.removeEventListener(RUN_IN_TERMINAL, onRun);
      window.removeEventListener(START_CLAUDE, onClaude);
    };
  }, [onShow, activeId]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const t = terms.current.get(activeId);
      t?.fit.fit();
      t?.term.focus();
    });
  }, [visible, activeId]);

  // Leaving a read-only tab (another tab, or a session panel on top) takes input away again.
  useEffect(() => {
    if (typingIn && (typingIn !== activeId || sessionOn)) setTypingIn(null);
  }, [typingIn, activeId, sessionOn]);

  /** Opens a read-only tab on a session member's terminal: who it is comes from the session. */
  async function watchMember(tab: string) {
    const sessionId = tab.split(":")[1] ?? "";
    const r = await sessionApi()?.get(sessionId);
    const agent = r?.ok ? r.data.meta.agents.find((a) => a.tab === tab) : undefined;
    if (!r?.ok || !agent || tabsRef.current.some((t) => t.id === tab)) return;
    // The same name the main process gives it in the agent list, so the status dot finds it.
    const t: Tab = { id: tab, mode: agent.cli, name: `${r.data.meta.title} · ${agent.name}`, exited: false, missing: null, notes: [READ_ONLY_NOTE], readOnly: true };
    setTabs((ts) => [...ts, t]);
    setActiveId(tab);
    setSessionOn(null);
    onShow();
  }

  function addTab(mode: Mode): Tab {
    const t = newTab(mode);
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    return t;
  }

  function closeTab(id: string) {
    // A read-only tab only stops watching: the member keeps running in its session.
    if (!tabsRef.current.find((t) => t.id === id)?.readOnly) window.sweet.termClose(id);
    terms.current.delete(id);
    const rest = tabsRef.current.filter((t) => t.id !== id);
    // Never empty: closing the last tab leaves a fresh shell.
    const next = rest.length ? rest : [newTab("shell")];
    setTabs(next);
    if (id === activeId) setActiveId(next[Math.max(0, tabsRef.current.findIndex((t) => t.id === id) - 1)]?.id ?? next[0].id);
  }

  async function launch(id: string, term: Terminal, mode: Mode) {
    patch(id, { exited: false, missing: null, mode, ...(mode === "shell" ? { name: undefined, notes: [] } : {}) });
    if (mode !== "shell") {
      let res: Awaited<ReturnType<typeof window.sweet.termStartAgent>>;
      try {
        res = await window.sweet.termStartAgent(id, mode, term.cols, term.rows);
      } catch (e) {
        // E.g. the window is newer than the main process after a hot reload: say so instead of a blank panel.
        res = { ok: false, message: `${cliName(mode)} 没能启动：${(e as Error).message}。如果刚更新过 sikeoop，请完全退出后重新打开。` };
      }
      patch(id, { notes: res.banner ?? [], name: res.name });
      if (!res.ok) {
        term.write(`\x1b[35m${res.message ?? `${cliName(mode)} 没能启动。`}\x1b[0m\r\n`);
        patch(id, { exited: true, missing: res.missing ? mode : null });
      }
      return;
    }
    const res = await window.sweet.termStart(id, term.cols, term.rows);
    if (!res.ok) {
      // E.g. Windows without Git Bash: explain instead of falling back to another shell.
      term.write(`\x1b[35m${res.message ?? "终端没能启动。"}\x1b[0m\r\n`);
      patch(id, { exited: true });
    }
  }

  function restart(id = active.id, mode: Mode = active.mode) {
    const t = terms.current.get(id);
    if (!t || tabsRef.current.find((x) => x.id === id)?.readOnly) return;
    t.term.reset();
    void launch(id, t.term, mode);
    requestAnimationFrame(() => t.term.focus());
  }

  /** In a shell tab, type the CLI's official install command for the user to watch. */
  async function install(cli: AgentCliId) {
    const cmd = await window.sweet.termInstallCommand(cli);
    if (!cmd) return;
    const t = active.mode === "shell" ? active : addTab("shell");
    if (t === active) restart(t.id, "shell");
    // Give the shell a moment to print its prompt before typing.
    setTimeout(() => {
      window.sweet.termWrite(t.id, cmd + "\r");
      terms.current.get(t.id)?.term.focus();
    }, 700);
  }

  /** Drag the top edge: the panel grows upward, within 120px and 80% of the window. */
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let h = startH;
    setResizing(true);
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(Math.max(startH + startY - ev.clientY, 120), window.innerHeight * 0.8));
      setHeight(h);
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(h));
      } catch {
        // Not remembered this time.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function lastScreen(): string {
    const term = terms.current.get(active.id)?.term;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buf.length - 80); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n").trim();
  }

  const agentOf = (t: Tab) => (t.name ? agents.find((a) => a.name === t.name) : undefined);
  const agentCount = tabs.filter((t) => t.mode !== "shell" && !t.exited && !t.readOnly).length;

  return (
    <section
      className={"terminal" + (active.mode !== "shell" ? " claude" : "") + (resizing ? " resizing" : "")}
      style={maximized ? undefined : { height }}
      hidden={!visible}
      aria-label="终端"
    >
      <div className="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="拖动调整终端高度" onPointerDown={startResize} />
      <div className="terminal-head">
        <div className="term-tabs" role="tablist" aria-label="终端标签页">
          {tabs.map((t) => {
            const a = agentOf(t);
            const label = t.mode === "shell" ? "终端" : (t.name ?? cliName(t.mode));
            return (
              <div key={t.id} className={"term-tab" + (!sessionOn && t.id === active.id ? " on" : "") + (t.mode !== "shell" ? " agent" : "")} role="presentation">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!sessionOn && t.id === active.id}
                  title={a ? `${label} · ${STATUS_TEXT[a.status]} · ${a.detail}` : label}
                  onClick={() => (setActiveId(t.id), setSessionOn(null))}
                >
                  <span className={"dot" + (t.exited ? " off" : a ? ` ${a.status}` : "")} aria-hidden="true" />
                  <Icon name={t.readOnly ? "eye-search" : t.mode !== "shell" ? "rocket" : "terminal"} />
                  {label}
                </button>
                <button type="button" className="x" title={t.readOnly ? "不看了（它还在 session 里继续运行）" : "关闭这个标签页"} aria-label={`关闭 ${label}`} onClick={() => closeTab(t.id)}>
                  <Icon name="close" />
                </button>
              </div>
            );
          })}
          {sessions.map((x) => (
            <div key={x.id} className={"term-tab agent" + (sessionOn === x.id ? " on" : "")} role="presentation" data-tab={sessionTabId(x.id)}>
              <button type="button" role="tab" aria-selected={sessionOn === x.id} title={`跨项目 session：${x.title}${x.ended ? "（已结束）" : ""}`} onClick={() => setSessionOn(x.id)}>
                <span className={"dot" + (x.ended ? " off" : "")} aria-hidden="true" />
                <Icon name={x.ended ? "history" : "group"} />
                {x.title}
              </button>
              <button type="button" className="x" title="关闭这个标签页（session 不会结束，可以从「+」菜单重新打开）" aria-label={`关闭 ${x.title}`} onClick={() => closeSessionTab(x.id)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          <details className="install-menu new-tab" onToggle={(e) => e.currentTarget.open && loadKinds()}>
            <summary className="icon-btn square" title="新开一个标签页：终端、Claude Code 或 Codex" aria-label="新标签页">
              <Icon name="plus" />
            </summary>
            <div className="install-pop">
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), addTab("shell"))}>
                终端
              </button>
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), addTab("claude"))}>
                Claude Code
                <span>工作区模式，可以和其他 AI 互相发消息</span>
              </button>
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), addTab("codex"))}>
                Codex
                <span>工作区模式，可以和其他 AI 互相发消息</span>
              </button>
              {kinds?.kinds
                .filter((k) => !k.builtin)
                .map((k) => (
                  <button key={k.id} type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), addTab(k.id))}>
                    {k.name}
                    <span>{k.installed ? (k.description ?? "扩展 CLI，可以和其他 AI 互相发消息") : `还没有安装${k.canInstall ? "，点开后可以一键安装" : ""}`}</span>
                  </button>
                ))}
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), void window.sweet.termOpenAgentKindsDir())}>
                添加其他 CLI…
                <span>打开扩展目录：放一个 JSON 定义文件，就能接入别的编程 CLI</span>
              </button>
              {kinds?.problems.map((x) => (
                <button key={x.file} type="button" disabled title={x.problems.join("\n")}>
                  {x.file} 没有加载
                  <span>{x.problems[0]}</span>
                </button>
              ))}
              {SHOW_UNFINISHED && (
                <>
                  <div
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button")) e.currentTarget.closest("details")!.open = false;
                    }}
                  >
                    <CrossSessionMenu openIds={sessions.map((x) => x.id)} onNew={() => setNewSession(true)} onOpen={openSession} />
                  </div>
                  <hr />
                </>
              )}
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), void install("claude"))}>
                安装 / 更新 Claude Code
              </button>
              <button type="button" onClick={(e) => ((e.currentTarget.closest("details")!.open = false), void install("codex"))}>
                安装 / 更新 Codex
                <span>需要 Node.js</span>
              </button>
            </div>
          </details>
        </div>
        {cwd && (
          <span className="cwd" title={cwd}>
            {cwd.split(/[\\/]/).filter(Boolean).pop()}
          </span>
        )}
        <span className="spacer" />
        {!sessionOn && agentCount >= 2 && <span className="hint-ok" title="这些 AI 可以用 list_peers / send_to 工具互相发消息">{agentCount} 个 AI 已互联</span>}
        {!sessionOn && active.mode === "shell" && (
          <>
            <button type="button" className="claude-btn" title="新开一个 Claude Code 标签页：只能直接改这个文件夹，命令先问你" onClick={() => addTab("claude")}>
              <Icon name="rocket" /> Claude Code
            </button>
            <button type="button" className="claude-btn" title="新开一个 Codex 标签页：运行在它自己的沙盒里，只能写这个文件夹" onClick={() => addTab("codex")}>
              <Icon name="rocket" /> Codex
            </button>
          </>
        )}
        {!sessionOn && active.readOnly && !active.exited && (
          <button
            type="button"
            className="claude-btn"
            aria-pressed={typingIn === active.id}
            title={typingIn === active.id ? "现在打的字会发给它。答完点这里切回只读" : "它在等你确认时用：打开后可以在这个终端里按键，离开这个标签页会自动关上"}
            onClick={() => {
              setTypingIn((cur) => (cur === active.id ? null : active.id));
              requestAnimationFrame(() => terms.current.get(active.id)?.term.focus());
            }}
          >
            <Icon name="lock" /> {typingIn === active.id ? "切回只读" : "临时允许输入"}
          </button>
        )}
        <span className="sep" aria-hidden="true" />
        {!sessionOn && (<>
        <button
          type="button"
          className="icon-btn square"
          title="把终端最近的输出发给 AI，让它帮你看是什么问题"
          aria-label="让 AI 看看"
          onClick={() => {
            const out = lastScreen();
            if (out) onAskAI(out);
          }}
        >
          <Icon name="stethoscope" />
        </button>
        <button type="button" className="icon-btn square" title="清屏" aria-label="清屏" onClick={() => terms.current.get(active.id)?.term.clear()}>
          <Icon name="broom" />
        </button>
        {!active.readOnly && (
        <button
          type="button"
          className="icon-btn square"
          title={active.mode !== "shell" ? `重新启动 ${cliName(active.mode)}` : "重新打开终端"}
          aria-label="重新打开"
          onClick={() => restart()}
        >
          <Icon name="refresh" />
        </button>
        )}
        </>)}
        {onMaximize && (
          <button type="button" className="icon-btn square" title={maximized ? "恢复布局" : "终端全屏"} aria-label={maximized ? "恢复布局" : "终端全屏"} onClick={onMaximize}>
            <Icon name={maximized ? "minimize" : "maximize"} />
          </button>
        )}
        <button type="button" className="icon-btn square" title="收起终端" aria-label="收起终端" onClick={onHide}>
          <Icon name="close" />
        </button>
      </div>
      {!sessionOn && active.mode !== "shell" && active.notes.length > 0 && (
        <div className="terminal-notes">
          {active.notes.map((n) => (
            <p key={n}>
              <Icon name="shield-check" /> {n}
            </p>
          ))}
        </div>
      )}
      {!sessionOn && active.mode === "shell" && active.byHand && (
        <div className="terminal-notes">
          <p>
            <Icon name="warning" />
            <span>
              你在普通终端里直接运行了 {active.byHand.name}。这样开，sikeoop 看不到它：灵动岛上没有它，别的 AI 也没法给它发消息。想让它互联，请从「+」菜单开。{" "}
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  const cli = active.byHand!.id;
                  patch(active.id, { byHand: undefined });
                  addTab(cli);
                }}
              >
                <Icon name="plus" /> 新开一个 {active.byHand.name} 标签
              </button>{" "}
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  toldAbout.add(active.byHand!.id);
                  patch(active.id, { byHand: undefined });
                }}
              >
                知道了
              </button>
            </span>
          </p>
        </div>
      )}
      {tabs.map((t) => (
        <TabTerm
          key={t.id}
          tab={t}
          onEntered={(command) => onEntered(t.id, command)}
          hidden={!!sessionOn || t.id !== active.id}
          canType={!t.readOnly || typingIn === t.id}
          register={(term, fit) => {
            terms.current.set(t.id, { term, fit });
            // A member's terminal is already running: report this view's size, and the main process
            // sends back its recent output, then whatever it prints from now on.
            if (t.readOnly) window.sweet.termResize(t.id, term.cols, term.rows);
            else void launch(t.id, term, t.mode);
          }}
          onRestart={() => restart(t.id, t.mode)}
          onInstall={(cli) => void install(cli)}
        />
      ))}
      {sessions.map((x) => (
        <div key={x.id} className="xsess-host" hidden={sessionOn !== x.id}>
          <CrossSessionPanel sessionId={x.id} onChanged={onSessionChanged} />
        </div>
      ))}
      {newSession && (
        <CrossSessionDialog
          currentRoot={cwd}
          onClose={() => setNewSession(false)}
          onCreated={(s) => {
            setNewSession(false);
            openSession(s);
          }}
        />
      )}
    </section>
  );
}

/** One tab's xterm. Created once; output comes in through the panel's router. */
function TabTerm({
  tab,
  hidden,
  canType,
  onEntered,
  register,
  onRestart,
  onInstall,
}: {
  /** A command line the user typed and entered in this tab, while it is a shell. */
  onEntered(command: string): void;
  tab: Tab;
  hidden: boolean;
  /** False for a read-only tab, unless the user has switched input on. */
  canType: boolean;
  register(term: Terminal, fit: FitAddon): void;
  onRestart(): void;
  onInstall(cli: AgentCliId): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const canTypeRef = useRef(canType);
  canTypeRef.current = canType;
  const typed = useRef(emptyLine());
  const live = useRef({ mode: tab.mode, onEntered });
  live.current = { mode: tab.mode, onEntered };
  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !canType;
  }, [canType]);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Geist Mono Variable', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      scrollback: 5000,
      disableStdin: !canTypeRef.current,
      theme: getSkin().terminal ?? THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    fit.fit();
    // Checked here as well as in xterm: a read-only tab sends no keys, pastes or mouse reports.
    const input = term.onData((d) => {
      if (!canTypeRef.current) return;
      window.sweet.termWrite(tab.id, d);
      if (live.current.mode !== "shell") return;
      const r = typeInto(typed.current, d);
      typed.current = r.line;
      for (const command of r.entered) live.current.onEntered(command);
    });
    const resized = term.onResize(({ cols, rows }) => window.sweet.termResize(tab.id, cols, rows));
    register(term, fit);
    const ro = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) fit.fit();
    });
    ro.observe(hostRef.current!);
    return () => {
      input.dispose();
      resized.dispose();
      ro.disconnect();
      term.dispose();
    };
    // One xterm for the tab's whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="terminal-host" ref={hostRef} hidden={hidden}>
      {tab.exited && (
        <div className="terminal-exited">
          {tab.missing
            ? `还没有安装 ${cliName(tab.missing)}`
            : tab.readOnly
              ? `${tab.name} 已退出：${memberExitText(tab.exitCode)}`
              : tab.mode !== "shell"
                ? `${tab.name ?? cliName(tab.mode)} 已退出`
                : "终端已退出"}
          {tab.missing ? (
            <button type="button" className="mini-btn" title="在终端里运行官方安装命令，过程都能看到" onClick={() => onInstall(tab.missing!)}>
              <Icon name="arrow-up" /> 一键安装
            </button>
          ) : tab.readOnly ? null : (
            <button type="button" className="mini-btn" onClick={onRestart}>
              <Icon name="refresh" /> 重新启动
            </button>
          )}
        </div>
      )}
    </div>
  );
}
