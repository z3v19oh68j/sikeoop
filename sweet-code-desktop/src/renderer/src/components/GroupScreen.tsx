import { useEffect, useRef, useState } from "react";
import { GROUP_MIN_CANDIDATES, type GroupCandidate, type GroupChat, type GroupMember, type GroupSummary } from "@shared/types";
import { characterFor } from "../home/characters";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

interface Props {
  hidden: boolean;
  /** Open settings to configure more members. */
  onSettings(): void;
  /** Hand a conclusion to the main Agent chat. dispatch: a settled division of work, sent in super-dispatch mode. */
  onHandOff(text: string, dispatch?: boolean): void;
}

/** A member's default name: the partner's, plus the model when the provider has several members. */
function defaultName(c: GroupCandidate, all: GroupCandidate[]): string {
  const base = characterFor(c.providerId)?.name ?? c.providerName;
  return all.filter((x) => x.providerId === c.providerId).length > 1 ? `${base}·${c.model}` : base;
}

const key = (c: GroupCandidate) => `${c.providerId}::${c.model}`;

/** Agent group chat: several AI members discuss with the user; members only read. */
export function GroupScreen({ hidden, onSettings, onHandOff }: Props) {
  const [candidates, setCandidates] = useState<GroupCandidate[] | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [chat, setChat] = useState<GroupChat | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    const [c, g] = await Promise.all([window.sweet.groupCandidates(), window.sweet.groupList()]);
    setCandidates(c);
    setGroups(g);
    return g;
  };

  // Members may have been configured in settings meanwhile: re-check whenever the screen shows.
  useEffect(() => {
    if (!hidden) void refresh();
  }, [hidden]);

  if (!candidates) return <main className="group" hidden={hidden} />;

  const locked = candidates.length < GROUP_MIN_CANDIDATES;

  return (
    <main className="group" hidden={hidden}>
      <aside className="group-list">
        <div className="section-head">
          群聊
          <span className="spacer" />
          <button type="button" className="icon-btn square" title="新建群聊" aria-label="新建群聊" disabled={locked} onClick={() => setCreating(true)}>
            <Icon name="chat-plus" />
          </button>
        </div>
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            className={"group-item" + (chat?.id === g.id ? " on" : "")}
            onClick={() => void window.sweet.groupLoad(g.id).then(setChat, (e) => setError(cleanError(e)))}
          >
            <span className="faces">
              {g.members.slice(0, 3).map((m) => (
                <Avatar key={m.id} providerId={m.providerId} name={m.name} />
              ))}
            </span>
            <span className="t">{g.title}</span>
            <span className="n">{g.members.length}</span>
          </button>
        ))}
        {!groups.length && !locked && <p className="hint">还没有群聊，点右上角新建一个。</p>}
      </aside>

      <section className="group-main">
        {error && (
          <div className="studio-error" role="alert">
            <Icon name="warning" /> {error}
            <button type="button" className="icon-btn square" aria-label="关闭" onClick={() => setError("")}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {locked ? (
          <Locked count={candidates.length} onSettings={onSettings} />
        ) : chat ? (
          <ChatView
            key={chat.id}
            chat={chat}
            onHandOff={onHandOff}
            onDelete={async () => {
              if (!window.confirm(`删除群聊「${chat.title}」？聊天记录会一起删掉。`)) return;
              await window.sweet.groupDelete(chat.id);
              setChat(null);
              void refresh();
            }}
            onUpdated={() => void refresh()}
          />
        ) : (
          <div className="wiki-empty">
            <Icon name="partners" />
            <h2>Agent 群聊</h2>
            <p>把几位 AI 拉进一个群，一起讨论方案、互相挑问题。群成员只看代码不动手，结论可以一键交给 Agent 去做。</p>
            <button type="button" className="neu-btn primary" onClick={() => setCreating(true)}>
              <Icon name="chat-plus" /> 新建群聊
            </button>
          </div>
        )}
      </section>

      {creating && (
        <CreateDialog
          candidates={candidates}
          onClose={() => setCreating(false)}
          onCreated={(g) => {
            setCreating(false);
            setChat(g);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

function Locked({ count, onSettings }: { count: number; onSettings(): void }) {
  return (
    <div className="wiki-empty">
      <Icon name="lock" />
      <h2>还差 {GROUP_MIN_CANDIDATES - count} 位成员就能开群聊</h2>
      <div className="archive-bar group-progress" aria-label={`已有 ${count}/${GROUP_MIN_CANDIDATES} 位可用成员`}>
        <span style={{ width: `${Math.min(100, (count / GROUP_MIN_CANDIDATES) * 100)}%` }} />
      </div>
      <p>
        已有 {count}/{GROUP_MIN_CANDIDATES} 位可用成员。每个配置好的「服务商 × 模型」算一位：可以配置更多服务商，也可以在一个服务商（比如中转站）的设置里写上这个 Key 能用的其他模型。
      </p>
      <button type="button" className="neu-btn primary" onClick={onSettings}>
        <Icon name="settings" /> 去配置模型
      </button>
    </div>
  );
}

function CreateDialog({ candidates, onClose, onCreated }: { candidates: GroupCandidate[]; onClose(): void; onCreated(g: GroupChat): void }) {
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.slice(0, 5).map(key)));
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const create = async () => {
    const members = candidates
      .filter((c) => picked.has(key(c)))
      .map((c) => ({ ...c, name: names[key(c)]?.trim() || defaultName(c, candidates) }));
    try {
      onCreated(await window.sweet.groupCreate(title, members));
    } catch (e) {
      setError(cleanError(e));
    }
  };

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal group-create" role="dialog" aria-label="新建群聊">
        <h2>新建群聊</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="群名，比如：登录功能评审" maxLength={40} />
        <p>选 2 到 8 位成员，名字可以改：</p>
        <ul className="group-candidates">
          {candidates.map((c) => {
            const k = key(c);
            return (
              <li key={k} className={picked.has(k) ? "on" : undefined}>
                <input
                  type="checkbox"
                  checked={picked.has(k)}
                  aria-label={`选择 ${c.providerName} ${c.model}`}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(k);
                      else n.delete(k);
                      return n;
                    })
                  }
                />
                <Avatar providerId={c.providerId} name={names[k] || defaultName(c, candidates)} />
                <input
                  className="member-name"
                  value={names[k] ?? defaultName(c, candidates)}
                  onChange={(e) => setNames((n) => ({ ...n, [k]: e.target.value }))}
                  maxLength={24}
                />
                <span className="meta">
                  {c.providerName} · {c.model}
                </span>
              </li>
            );
          })}
        </ul>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <span className="hint">已选 {picked.size} 位</span>
          <span className="spacer" />
          <button type="button" className="neu-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="neu-btn primary" disabled={picked.size < 2 || picked.size > 8} onClick={() => void create()}>
            建群
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatView({
  chat: initial,
  onHandOff,
  onDelete,
  onUpdated,
}: {
  chat: GroupChat;
  onHandOff(text: string, dispatch?: boolean): void;
  onDelete(): void;
  onUpdated(): void;
}) {
  const [chat, setChat] = useState(initial);
  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  /** The member speaking now and their reply so far. */
  const [live, setLive] = useState<{ memberId: string; messageId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const byId = new Map(chat.members.map((m) => [m.id, m]));

  useEffect(
    () =>
      window.sweet.onGroupEvent((e) => {
        if (e.groupId !== chat.id) return;
        if (e.type === "speaking") setLive({ memberId: e.memberId, messageId: e.messageId, text: "" });
        else if (e.type === "delta") setLive((l) => (l && l.messageId === e.messageId ? { ...l, text: l.text + e.text } : l));
        else if (e.type === "message") {
          setLive((l) => (l?.messageId === e.message.id ? null : l));
          setChat((c) => (c.messages.some((m) => m.id === e.message.id) ? c : { ...c, messages: [...c.messages, e.message] }));
        } else if (e.type === "plan") {
          setChat((c) => ({ ...c, plan: e.plan }));
        } else if (e.type === "idle") {
          setLive(null);
          setBusy(false);
          onUpdated();
        }
      }),
    [chat.id],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.messages.length, live?.text]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    setBusy(true);
    try {
      await window.sweet.groupSend(chat.id, text, mentions);
      setMentions([]);
    } catch (e) {
      setError(cleanError(e));
      setBusy(false);
    }
  };

  const handOff = () => {
    const names = new Map(chat.members.map((m) => [m.id, m.name]));
    const recent = chat.messages
      .slice(-12)
      .map((m) => `【${m.from === "user" ? "我" : names.get(m.memberId ?? "")}】${m.text}`)
      .join("\n\n");
    onHandOff(`下面是群聊「${chat.title}」里的讨论。请根据大家的结论动手实现；有分歧的地方先问我：\n\n${recent}`);
  };

  // The group's own channel to the main conversation: settle the division of work, then hand it over as is.
  const finalize = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await window.sweet.groupFinalize(chat.id, mentions.length === 1 ? mentions[0] : undefined);
    } catch (e) {
      setError(cleanError(e));
      setBusy(false);
    }
  };
  const dispatchPlan = async () => {
    setError("");
    try {
      onHandOff((await window.sweet.groupHandoff(chat.id)).text, true);
    } catch (e) {
      setError(cleanError(e));
    }
  };
  // The plan is stale once anyone has spoken after it.
  const planFresh = !!chat.plan && chat.plan.feasible && !chat.messages.some((m) => m.at > chat.plan!.at);

  return (
    <div className="group-chat">
      <div className="studio-bar">
        <span className="studio-title">{chat.title}</span>
        <span className="group-faces">
          {chat.members.map((m) => (
            <span key={m.id} title={`${m.name} · ${m.providerName} · ${m.model}`} className={live?.memberId === m.id ? "speaking" : undefined}>
              <Avatar providerId={m.providerId} name={m.name} />
            </span>
          ))}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="mini-btn"
          disabled={busy || !chat.messages.some((m) => m.from === "member")}
          onClick={() => void finalize()}
          title="让一位成员把讨论结论整理成分工方案：可不可行、谁负责什么（先点一个头像可以指定由谁整理）"
        >
          <Icon name="check-circle" /> 整理分工
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={busy || !planFresh}
          onClick={() => void dispatchPlan()}
          title={planFresh ? "把定好的分工交给主对话：它只按表派活和验收，不重新规划" : "先整理分工；整理后群里又聊了新内容的话要重新整理"}
        >
          <Icon name="rocket" /> 按分工派活
        </button>
        <button type="button" className="mini-btn" disabled={busy || !chat.messages.length} onClick={handOff} title="把最近的讨论交给主对话里的 Agent 去实现">
          <Icon name="rocket" /> 交给 Agent
        </button>
        <button type="button" className="icon-btn square" title="删除群聊" aria-label="删除群聊" onClick={onDelete}>
          <Icon name="trash" />
        </button>
      </div>

      <div className="group-messages" ref={listRef}>
        {!chat.messages.length && <p className="hint center">说点什么开始讨论。默认每位成员轮流发言，也可以先点下面的头像只问某几位。</p>}
        {chat.messages.map((m) => (
          <Bubble key={m.id} member={m.memberId ? byId.get(m.memberId) : undefined} text={m.text} error={m.error} mine={m.from === "user"} />
        ))}
        {live && <Bubble member={byId.get(live.memberId)} text={live.text} typing />}
      </div>

      {error && <p className="err group-err">{error}</p>}
      <form
        className="composer group-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="composer-box">
          <div className="mention-row" aria-label="只让这些成员回答">
            <span className="hint">{mentions.length ? "只让他们回答：" : "所有人轮流回答 · 点头像只问某几位："}</span>
            {chat.members.map((m) => (
              <button
                key={m.id}
                type="button"
                className={"mention" + (mentions.includes(m.id) ? " on" : "")}
                onClick={() => setMentions((s) => (s.includes(m.id) ? s.filter((x) => x !== m.id) : [...s, m.id]))}
                title={`@${m.name}`}
              >
                <Avatar providerId={m.providerId} name={m.name} /> {m.name}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={input}
            placeholder="在群里说点什么，Enter 发送"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="row">
            <span className="spacer" />
            {busy ? (
              <button type="button" className="stop-btn" onClick={() => void window.sweet.groupStop(chat.id)}>
                停下
              </button>
            ) : (
              <button type="submit" className="send-btn" aria-label="发送" disabled={!input.trim()}>
                <Icon name="arrow-up" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function Bubble({ member, text, error, mine, typing }: { member?: GroupMember; text: string; error?: string; mine?: boolean; typing?: boolean }) {
  if (mine) {
    return (
      <div className="g-msg mine">
        <div className="g-body">{text}</div>
      </div>
    );
  }
  return (
    <div className="g-msg">
      <Avatar providerId={member?.providerId ?? ""} name={member?.name} />
      <div className="g-col">
        <span className="g-name">
          {member?.name ?? "成员"} <span className="meta">{member?.model}</span>
        </span>
        <div className="g-body">
          {text ? <Markdown text={text} /> : typing ? <span className="typing">正在输入…</span> : null}
          {error && <p className="wiki-warn bad">{error}</p>}
        </div>
      </div>
    </div>
  );
}
