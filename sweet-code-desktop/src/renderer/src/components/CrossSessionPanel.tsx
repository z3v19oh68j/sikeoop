import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  MAX_SESSION_AGENTS,
  SCOPE_NOTE,
  sessionApi,
  type CrossSession,
  type SessionAgent,
  type SessionAgentStatus,
  type TimelineEvent,
} from "./crossSession";

const STATUS_TEXT: Record<SessionAgentStatus, string> = { starting: "启动中", idle: "空闲", busy: "发言中", queued: "排队中", exited: "已退出" };
const CLI_NAME = { claude: "Claude Code", codex: "Codex" } as const;
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const clock = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 一个跨项目 session 标签页：成员条、时间线、输入框。 */
export function CrossSessionPanel({ sessionId, onChanged }: { sessionId: string; onChanged?(s: CrossSession): void }) {
  const api = sessionApi();
  const [meta, setMeta] = useState<CrossSession | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  /** 已点过“加入此目录”的事件，值是结果提示。 */
  const [added, setAdded] = useState<Record<number, string>>({});
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!api) return setError("当前版本还没接上跨项目 session，请更新 sikeoop 后再试。");
    let alive = true;
    void api.get(sessionId).then((r) => {
      if (!alive) return;
      if (!r.ok) return setError(r.message);
      setMeta(r.data.meta);
      setEvents((cur) => {
        const seen = new Set(r.data.events.map((e) => e.seq));
        return [...r.data.events, ...cur.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
      });
      setMore(r.data.events.length >= 200);
    });
    const offE = api.onEvent((id, e) => {
      if (id !== sessionId) return;
      setEvents((cur) => (cur.some((x) => x.seq === e.seq) ? cur : [...cur, e]));
    });
    const offC = api.onChanged((s) => {
      if (s.id !== sessionId) return;
      setMeta(s);
      onChanged?.(s);
    });
    return () => {
      alive = false;
      offE();
      offC();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const agents = meta?.agents ?? [];
  const ended = meta?.state === "ended";
  const nameOf = (who?: string) => {
    if (!who || who === "user") return "你";
    const a = agents.find((x) => x.id === who || x.name === who);
    return a?.name ?? who;
  };
  const speaking = agents.some((a) => a.status === "busy" || a.status === "queued");

  // @ 补全：光标前最近一个 @ 到光标之间没有空白时弹出。
  const mention = useMemo(() => {
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null;
  }, [text, caret]);
  const candidates = mention && !menuOff && !ended ? agents.filter((a) => a.name.toLowerCase().startsWith(mention.query)) : [];

  function pick(a: SessionAgent) {
    if (!mention) return;
    const next = text.slice(0, mention.start) + `@${a.name} ` + text.slice(caret);
    const pos = mention.start + a.name.length + 2;
    setText(next);
    setCaret(pos);
    setMenuIdx(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  }

  function mentionIds(s: string): string[] {
    const ids = new Set<string>();
    for (const m of s.matchAll(/@([^\s@]+)/g)) {
      const a = agents.find((x) => x.name.toLowerCase() === m[1].toLowerCase());
      if (a) ids.add(a.id);
    }
    return [...ids];
  }

  async function send() {
    const body = text.trim();
    if (!api || !body || ended) return;
    const ids = mentionIds(body);
    setError("");
    const r = await api.send(sessionId, body, ids);
    if (!r.ok) return setError(r.message);
    setText("");
    setCaret(0);
    setNotice(
      ids.length > 0
        ? ""
        : agents.length === 0
          ? "这条只记录在时间线里。先点上面的“拉入 AI”，再用 @ 点名它。"
          : "这条没有点名任何 AI，只记录在时间线里。想让谁回答，就在话里 @ 它的名字。",
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (candidates.length > 0) {
      if (e.key === "ArrowDown") (e.preventDefault(), setMenuIdx((i) => (i + 1) % candidates.length));
      else if (e.key === "ArrowUp") (e.preventDefault(), setMenuIdx((i) => (i - 1 + candidates.length) % candidates.length));
      else if (e.key === "Enter" || e.key === "Tab") (e.preventDefault(), pick(candidates[Math.min(menuIdx, candidates.length - 1)]));
      else if (e.key === "Escape") (e.preventDefault(), setMenuOff(true));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function run(p: Promise<{ ok: boolean; message?: string }>) {
    const r = await p;
    if (!r.ok) setError(r.message ?? "操作没成功。");
    return r.ok;
  }

  async function addAgent(cli: "claude" | "codex") {
    if (!api) return;
    setAdding(false);
    setError("");
    await run(api.addAgent(sessionId, cli));
  }

  async function addRoot(e: TimelineEvent) {
    if (!api || !e.dir) return;
    const r = await api.addRoot(sessionId, e.dir);
    setAdded((a) => ({ ...a, [e.seq]: r.ok ? "已提交。已经在运行的 AI 要重启后才会生效。" : r.message }));
  }

  async function loadEarlier() {
    if (!api || events.length === 0) return;
    const r = await api.get(sessionId, events[0].seq);
    if (!r.ok) return setError(r.message);
    setEvents((cur) => [...r.data.events, ...cur].sort((a, b) => a.seq - b.seq));
    setMore(r.data.events.length >= 200);
  }

  function card(e: TimelineEvent) {
    switch (e.kind) {
      case "user":
      case "agent":
        return (
          <div key={e.seq} className={"xs-msg " + e.kind}>
            <div className="who">
              <b>{nameOf(e.from)}</b>
              {e.to && e.to.length > 0 && <span className="to">发给 {e.to.map(nameOf).join("、")}</span>}
              <time>{clock(e.at)}</time>
            </div>
            <div className="body">{e.text}</div>
          </div>
        );
      case "outOfScope": {
        const res = added[e.seq];
        return (
          <div key={e.seq} className="xs-card warn">
            <Icon name="warning" />
            <div className="c">
              <p>
                <b>{nameOf(e.from)}</b> 想访问不在本 session 范围内的位置，已被拦下。
              </p>
              {e.path && <code title={e.path}>{e.path}</code>}
              {e.text && <p className="dim">{e.text}</p>}
              {e.dir && !ended && !res && (
                <div className="act">
                  <button type="button" className="mini-btn" onClick={() => void addRoot(e)} title={e.dir}>
                    <Icon name="folder-plus" /> 加入此目录
                  </button>
                  <span className="dim">会弹出确认框，加入后 AI 才能碰这个目录</span>
                </div>
              )}
              {res && <p className="dim">{res}</p>}
            </div>
          </div>
        );
      }
      case "lockDenied":
        return (
          <div key={e.seq} className="xs-card warn">
            <Icon name="lock" />
            <div className="c">
              <p>
                <b>{nameOf(e.from)}</b> 想改的文件正被别的 AI 占着，已先拦下，等对方改完再试。
              </p>
              {e.path && <code title={e.path}>{e.path}</code>}
              {e.text && <p className="dim">{e.text}</p>}
            </div>
          </div>
        );
      case "hopLimit":
        return (
          <div key={e.seq} className="xs-card stop">
            <Icon name="stop" />
            <div className="c">
              <p>
                <b>AI 之间互相派活的次数用完了，先停住了。</b>
              </p>
              <p className="dim">{e.text ?? "怕它们聊个没完。你看一眼进展，发一条消息（记得 @ 点名）就会重新计数、继续干。"}</p>
            </div>
          </div>
        );
      case "agentJoined":
      case "agentExited":
        return (
          <div key={e.seq} className="xs-line">
            {e.kind === "agentJoined" ? "加入了" : "退出了"}：<b>{nameOf(e.from)}</b>
            {e.text ? `（${e.text}）` : ""}
            <time>{clock(e.at)}</time>
          </div>
        );
      default:
        return (
          <div key={e.seq} className="xs-line">
            {e.text}
            <time>{clock(e.at)}</time>
          </div>
        );
    }
  }

  if (!meta) return <div className="xsess-panel"><p className="xs-empty">{error || "正在加载…"}</p></div>;

  return (
    <div className="xsess-panel">
      <div className="xs-members">
        <div className="xs-roots" title={meta.roots.join("\n")}>
          <Icon name="folder-open" />
          {meta.roots.map((r) => (
            <span key={r} className="chip" title={r}>
              {baseName(r)}
            </span>
          ))}
        </div>
        <div className="xs-agents">
          {agents.length === 0 && <span className="dim">还没有 AI 成员</span>}
          {agents.map((a) => (
            <span key={a.id} className={"xs-agent " + a.status}>
              <span className="dot" aria-hidden="true" />
              <b>{a.name}</b>
              <i>{CLI_NAME[a.cli]}</i>
              <em>{STATUS_TEXT[a.status]}</em>
              <button
                type="button"
                className="x"
                title="在终端里查看它在干什么（只读，不能在里面输入）"
                aria-label={`在终端里查看 ${a.name}`}
                disabled={a.status === "exited"}
                onClick={() => api && void run(api.openTerminal(sessionId, a.id))}
              >
                <Icon name="eye-search" />
              </button>
              {!ended && (
                <button type="button" className="x" title="把它移出这个 session" aria-label={`移除 ${a.name}`} onClick={() => api && void run(api.removeAgent(sessionId, a.id))}>
                  <Icon name="close" />
                </button>
              )}
            </span>
          ))}
          {!ended && (
            <span className="xs-add">
              <button
                type="button"
                className="mini-btn"
                disabled={agents.length >= MAX_SESSION_AGENTS}
                title={agents.length >= MAX_SESSION_AGENTS ? `最多 ${MAX_SESSION_AGENTS} 个 AI` : "拉一个新的 AI 进来"}
                onClick={() => setAdding((v) => !v)}
              >
                <Icon name="plus" /> 拉入 AI（{agents.length}/{MAX_SESSION_AGENTS}）
              </button>
              {adding && (
                <div className="xs-pop">
                  <button type="button" onClick={() => void addAgent("claude")}>Claude Code</button>
                  <button type="button" onClick={() => void addAgent("codex")}>Codex</button>
                </div>
              )}
            </span>
          )}
        </div>
        <div className="xs-tools">
          {speaking && !ended && (
            <button type="button" className="mini-btn warn" title="让正在发言的 AI 马上停下，并清空排队" onClick={() => api && void run(api.stop(sessionId))}>
              <Icon name="stop" /> 全部停下
            </button>
          )}
          {!ended &&
            (confirmEnd ? (
              <>
                <button type="button" className="mini-btn warn" onClick={() => (setConfirmEnd(false), api && void run(api.end(sessionId)))}>
                  确定结束
                </button>
                <button type="button" className="mini-btn" onClick={() => setConfirmEnd(false)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" className="mini-btn" title="结束后 session 变成只读，AI 会退出" onClick={() => setConfirmEnd(true)}>
                结束 session
              </button>
            ))}
        </div>
      </div>
      <p className="xs-note">
        <Icon name="shield-check" /> {SCOPE_NOTE}
      </p>

      <div
        className="xs-timeline"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {more && (
          <button type="button" className="mini-btn xs-more" onClick={() => void loadEarlier()}>
            加载更早的记录
          </button>
        )}
        {events.length === 0 && <p className="xs-empty">还没有消息。用 @ 点名一个 AI，把活儿派给它。</p>}
        {events.map(card)}
        {speaking && (
          <div className="xs-line live">
            {agents
              .filter((a) => a.status === "busy" || a.status === "queued")
              .map((a) => `${a.name}${a.status === "busy" ? " 正在发言" : " 排队中"}`)
              .join("，")}
            …
          </div>
        )}
      </div>

      {ended && (
        <p className="xs-ended">
          <Icon name="lock" /> 这个 session 已结束，只能查看记录，不能再发消息。
        </p>
      )}
      {(error || notice) && (
        <p className={"xs-hint" + (error ? " err" : "")} role="status">
          {error || notice}
        </p>
      )}
      <div className="xs-composer">
        {candidates.length > 0 && (
          <ul className="xs-mentions" role="listbox" aria-label="点名成员">
            {candidates.map((a, i) => (
              <li key={a.id} role="option" aria-selected={i === menuIdx} className={i === menuIdx ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), pick(a))}>
                <b>@{a.name}</b>
                <span>{CLI_NAME[a.cli]} · {STATUS_TEXT[a.status]}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={text}
          disabled={ended}
          rows={2}
          placeholder={ended ? "session 已结束，不能再发消息" : "输入消息，用 @ 点名要谁来做（回车发送，Shift+回车换行）"}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setMenuOff(false);
            setMenuIdx(0);
            setNotice("");
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="send" disabled={ended || !text.trim()} aria-label="发送" onClick={() => void send()}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
