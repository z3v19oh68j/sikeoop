import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  ApprovalResponse,
  ApprovalSubject,
  EditorContext,
  Effort,
  FileChip,
  HookOutcomeKind,
  LoadedSession,
  PlanItem,
  ReviewDecision,
  SessionSummary,
  TranscriptItem,
  UndoResult,
  AskAnswer,
  AskQuestion,
} from "@shared/types";
import { type FileAttachment, formatSize, prepareFile } from "../files";
import { type Attachment, prepareImage } from "../images";
import { ShareCard } from "../publish/ShareCard";
import type { PublishRecord } from "@shared/types";
import { ApprovalCard, type ApprovalState, type CommandRun } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./QuestionCard";
import { Icon, fileIconName } from "./Icon";
import { Avatar } from "./Avatar";
import { characterFor } from "../home/characters";
import "../styles/tool-stream.css";

type Part =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  /** preparing: the model is still writing the call's arguments; partial is the latest of them. */
  | { kind: "tool"; id: string; summary: string; state: "preparing" | "running" | "ok" | "fail"; preview?: string; partial?: string }
  | { kind: "notice"; text: string; icon?: string; error?: boolean }
  | { kind: "vision"; state: "start" | "done" | "error"; model: string; count: number; text?: string }
  | {
      kind: "approval";
      id: string;
      subject: ApprovalSubject;
      state: ApprovalState;
      auto: boolean;
      /** Long-task mode: the reviewer answers first; review is its verdict once it arrives. */
      reviewing: boolean;
      review?: { decision: ReviewDecision; reason: string; model: string };
      run?: CommandRun;
      error?: string;
    }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "question"; id: string; intro?: string; questions: AskQuestion[]; answered?: { answers: AskAnswer[]; usedDefaults: boolean } }
  | { kind: "hook"; event: string; name: string; outcome: HookOutcomeKind; message: string; detail?: string }
  | { kind: "memory"; id: string; text: string; scope: "project" | "global"; updated: boolean; lesson?: boolean; forgotten?: boolean }
  | {
      kind: "changes";
      turnId: number;
      files: { path: string; created: boolean }[];
      undo: "idle" | "working" | "done";
      result?: UndoResult;
      error?: string;
    };

type Turn = { role: "user"; text: string; images?: string[]; files?: FileChip[] } | { role: "ai"; parts: Part[] };

const MAX_IMAGES = 6;
const MAX_FILES = 10;

interface Props {
  /** The active provider has a model, address and key. */
  ready: boolean;
  /** The active provider, whose partner greets the user. */
  partnerId?: string;
  /** Show the thinking-depth selector (Claude, DeepSeek). */
  supportsEffort: boolean;
  editor: EditorContext;
  onNeedSetup(): void;
  /** Save unsaved editor tabs, so the AI reads and edits what the user sees. */
  beforeSend(): Promise<void>;
  /** A message another part of the app wants sent, e.g. from "帮我看看". New nonce = send again. */
  /** dispatch: a settled division of work from a group chat, sent in super-dispatch mode whatever mode is on. */
  injected?: { text: string; nonce: number; dispatch?: boolean };
  /** A saved conversation to show; the panel is remounted for each one. */
  loaded?: LoadedSession;
  onLoadSession(id: string): void;
  onNewChat(): void;
  /** Layout controls: fill the work area with the chat, or hide it. */
  maximized?: boolean;
  onMaximize?(): void;
  onHide?(): void;
  /** Make a read-only conversation continuable: switch provider, or open the settings. */
  onUnlock(locked: NonNullable<LoadedSession["locked"]>): void;
  onUsage(e: Extract<AgentEvent, { type: "usage" }>): void;
}

const QUICK = [
  "这个项目是做什么的？",
  "帮我解释一下选中的代码",
  "帮我看看当前文件有没有 bug",
  "我想加一个新功能，应该从哪里开始？",
];

const EFFORT_LABEL: Record<Effort, string> = { low: "快速", medium: "正常", high: "深入思考" };
const AUTOPILOT_KEY = "sweet.autopilot";
const MODE_KEY = "sweet.mode";
type ChatMode = "agent" | "autopilot" | "lazy" | "super";

/** Tell the user when a long task needs them or is finished while they are looking elsewhere. */
function notify(body: string) {
  if (document.hasFocus() || typeof Notification === "undefined") return;
  const show = () => new Notification("sikeoop", { body, silent: false });
  if (Notification.permission === "granted") show();
  else if (Notification.permission !== "denied") void Notification.requestPermission().then((p) => p === "granted" && show());
}

export function ChatPanel(props: Props) {
  const { ready, supportsEffort, editor, onNeedSetup, beforeSend, injected, loaded, onUsage } = props;
  const [turns, setTurns] = useState<Turn[]>(() => (loaded ? fromTranscript(loaded.transcript) : []));
  const [historyOpen, setHistoryOpen] = useState(false);
  const locked = loaded?.locked;
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [docs, setDocs] = useState<FileAttachment[]>([]);
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"thinking" | "running_tools" | "compacting" | "idle">("idle");
  const [effort, setEffort] = useState<Effort>("low");
  const [mode, setModeState] = useState<ChatMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "agent" || saved === "autopilot" || saved === "lazy" || saved === "super") return saved;
      return localStorage.getItem(AUTOPILOT_KEY) === "1" ? "autopilot" : "agent";
    } catch {
      return "agent";
    }
  });
  const autopilot = mode !== "agent";
  const lazy = mode === "lazy";
  // Super dispatch: the agent hands the work to other AIs. It runs unattended, as lazy mode does.
  const superMode = mode === "super";
  const [confirmLazy, setConfirmLazy] = useState<"lazy" | "super" | false>(false);
  function setMode(m: ChatMode) {
    setModeState(m);
    setConfirmLazy(false);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Not remembered; fine.
    }
  }
  const listRef = useRef<HTMLDivElement>(null);
  // F4: local-only share cards after a publish; not sent to the model or saved in history.
  const [shareCards, setShareCards] = useState<{ key: number; record: PublishRecord }[]>([]);
  useEffect(
    () =>
      window.sweet.onPublishEvent((ev) => {
        if (ev.type === "done") setShareCards((cs) => [...cs.filter((c) => c.record.siteId !== ev.record.siteId), { key: Date.now(), record: ev.record }]);
      }),
    [],
  );
  const onUsageRef = useRef(onUsage);
  onUsageRef.current = onUsage;

  useEffect(() => {
    // Streamed pieces (a few characters each) arrive many times a frame. Re-rendering the panel
    // and re-parsing the growing Markdown for every one gets slow on long replies, so they are
    // collected and applied together once per frame. Any other event flushes them first, so the
    // order never changes.
    let pending: AgentEvent[] = [];
    let frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setTurns((ts) => {
        const last = ts[ts.length - 1];
        if (!last || last.role !== "ai") return ts;
        return [...ts.slice(0, -1), { role: "ai", parts: batch.reduce(applyEvent, last.parts) }];
      });
    };
    const off = window.sweet.onAgentEvent((e) => {
        if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "tool_preview") {
          pending.push(e);
          frame ||= requestAnimationFrame(flush);
          return;
        }
        flush();
        if (e.type === "status") {
          setPhase(e.state);
          if (e.state === "idle") setBusy(false);
          return;
        }
        if (e.type === "usage") return onUsageRef.current(e);
        if (e.type === "remote_message") {
          setBusy(true);
          return setTurns((ts) => [...ts, { role: "user", text: `📱 微信：${e.text}` }, { role: "ai", parts: [] }]);
        }
        if (e.type === "review" && e.decision === "ask_human") notify(`长任务需要你看一眼：${e.reason}`);
        if (e.type === "question") notify(`AI 开始之前想问你 ${e.questions.length} 个问题`);
        if (e.type === "done" && e.autopilot && e.reason !== "cancelled") notify("长任务做完啦，回来看看总结吧～");
        if (e.type === "error") notify(`出错停下了：${e.message.slice(0, 80)}`);
        // An undo updates the reply that made those changes, which may be further up.
        if (e.type === "turn_undone") {
          return setTurns((ts) => ts.map((t) => (t.role === "ai" ? { ...t, parts: applyEvent(t.parts, e) } : t)));
        }
        setTurns((ts) => {
          const last = ts[ts.length - 1];
          if (!last || last.role !== "ai") return ts;
          return [...ts.slice(0, -1), { role: "ai", parts: applyEvent(last.parts, e) }];
        });
      });
    return () => {
      off();
      flush();
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [turns, shareCards]);

  useEffect(() => {
    if (injected) void send(injected.text, injected.dispatch);
    // Only a new nonce should send; send itself changes every render.
  }, [injected?.nonce]);

  /**
   * Add pasted, dropped or picked files. Images are resized here and read by the vision model on
   * send; text, code and PDFs are read into text and go into the message itself.
   */
  async function attach(files: File[]) {
    setAttachError("");
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    const imageRoom = MAX_IMAGES - attachments.length;
    const fileRoom = MAX_FILES - docs.length;
    if (images.length > imageRoom) setAttachError(`一次最多 ${MAX_IMAGES} 张图片`);
    if (others.length > fileRoom) setAttachError(`一次最多 ${MAX_FILES} 个文件`);
    const todo = [...images.slice(0, Math.max(imageRoom, 0)), ...others.slice(0, Math.max(fileRoom, 0))];
    setReading((n) => n + todo.length);
    for (const f of todo) {
      try {
        if (f.type.startsWith("image/")) {
          const a = await prepareImage(f, f.name || "截图");
          setAttachments((xs) => [...xs, a]);
        } else {
          const d = await prepareFile(f);
          setDocs((xs) => [...xs, d]);
        }
      } catch (e) {
        setAttachError((e as Error).message);
      } finally {
        setReading((n) => n - 1);
      }
    }
  }

  async function send(text: string, dispatch = false) {
    const t = text.trim();
    const imgs = attachments;
    // Typed messages wait for files still being read; an injected one ("帮我看看") goes alone.
    const files = text === input ? docs.map((d) => d.file) : [];
    if ((!t && !imgs.length && !files.length) || busy || (text === input && reading > 0)) return;
    if (!ready) return onNeedSetup();
    setInput("");
    setAttachments([]);
    if (files.length) setDocs([]);
    setAttachError("");
    setBusy(true);
    const thumbs = imgs.map((a) => a.thumb);
    const chips = files.map((f) => ({ name: f.name, size: f.size }));
    setTurns((ts) => [...ts, { role: "user", text: t, images: thumbs, files: chips }, { role: "ai", parts: [] }]);
    try {
      await beforeSend();
      await window.sweet.sendChat({
        text: t,
        editor,
        effort,
        ...(autopilot || dispatch ? { autopilot: true } : {}),
        ...(lazy || superMode || dispatch ? { lazy: true } : {}),
        ...(superMode || dispatch ? { orchestrate: true } : {}),
        ...(imgs.length ? { images: imgs.map((a) => a.image), thumbs } : {}),
        ...(files.length ? { files } : {}),
      });
    } catch (err) {
      setBusy(false);
      setTurns((ts) => {
        const last = ts[ts.length - 1];
        const msg = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        if (!last || last.role !== "ai") return ts;
        return [...ts.slice(0, -1), { role: "ai", parts: [...last.parts, { kind: "notice", text: msg, error: true }] }];
      });
    }
  }

  /** Apply a change to one part, wherever it is in the conversation. */
  function updatePart(match: (p: Part) => boolean, change: (p: Part) => Part) {
    setTurns((ts) => ts.map((t) => (t.role === "ai" ? { ...t, parts: t.parts.map((p) => (match(p) ? change(p) : p)) } : t)));
  }

  function respond(r: ApprovalResponse) {
    void window.sweet.respondApproval(r);
  }

  async function undo(turnId: number) {
    const isIt = (p: Part) => p.kind === "changes" && p.turnId === turnId;
    updatePart(isIt, (p) => ({ ...p, undo: "working" }) as Part);
    try {
      // The result arrives as a turn_undone event, which also goes into the saved conversation.
      await window.sweet.undoTurn(turnId);
    } catch (err) {
      const error = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      updatePart(isIt, (p) => ({ ...p, undo: "idle", error }) as Part);
    }
  }


  const selLabel = editor.selection?.trim() && `选中的 ${editor.selection.split("\n").length} 行`;
  const partner = props.partnerId ? characterFor(props.partnerId) : undefined;
  const firstAsk = turns.find((t) => t.role === "user")?.text.split("\n")[0];

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className={"title" + (firstAsk ? "" : " idle")} title={firstAsk}>
          {firstAsk || "新对话"}
        </span>
        {(turns.length > 0 || locked) && (
          <button type="button" className="icon-btn square" onClick={props.onNewChat} disabled={busy} title="新对话" aria-label="新对话">
            <Icon name="chat-plus" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn square"
          onClick={() => setHistoryOpen(!historyOpen)}
          disabled={busy}
          aria-expanded={historyOpen}
          title="这个项目的历史对话"
          aria-label="历史对话"
        >
          <Icon name="history" />
        </button>
        {props.onMaximize && (
          <button type="button" className="icon-btn square" onClick={props.onMaximize} title={props.maximized ? "恢复布局" : "对话全屏"} aria-label={props.maximized ? "恢复布局" : "对话全屏"}>
            <Icon name={props.maximized ? "minimize" : "maximize"} />
          </button>
        )}
        {props.onHide && (
          <button type="button" className="icon-btn square" onClick={props.onHide} title="收起对话栏" aria-label="收起对话栏">
            <Icon name="close" />
          </button>
        )}
        {historyOpen && (
          <HistoryList
            currentId={loaded?.id}
            onPick={(id) => {
              setHistoryOpen(false);
              props.onLoadSession(id);
            }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      <div className="messages" ref={listRef}>
        {turns.length === 0 && (
          <div className="welcome">
            <div className="hello">
              {props.partnerId && <Avatar providerId={props.partnerId} size="lg" />}
              嗨，我是{partner?.name ?? "你的代码小助手"}
            </div>
            <div>我能读你的项目、改代码、跑命令、找 bug。说说你想做什么，或者从这里开始：</div>
            <div className="quick">
              {QUICK.map((q) => (
                <button key={q} type="button" onClick={() => void send(q)}>
                  <Icon name="chevron-right" /> {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="msg-user">
              {t.images?.length ? (
                <div className="msg-images">
                  {t.images.map((src, j) => (
                    <img key={j} src={src} alt={`图片 ${j + 1}`} />
                  ))}
                </div>
              ) : null}
              {t.files?.length ? (
                <div className="msg-files">
                  {t.files.map((f, j) => (
                    <FileChipView key={j} name={f.name} size={f.size} />
                  ))}
                </div>
              ) : null}
              {t.text}
            </div>
          ) : (
            <div key={i} className="msg-ai">
              {group(t.parts, busy && i === turns.length - 1).map((g, j) =>
                g.kind === "activity" ? (
                  <ActivityGroup key={j} parts={g.parts} busy={busy} onRespond={respond} onUndo={(id) => void undo(id)} />
                ) : (
                  <PartView
                    key={j}
                    part={g.part}
                    busy={busy}
                    // The reply's last text while the turn runs: it is still being written.
                    streaming={busy && i === turns.length - 1 && g.part === t.parts[t.parts.length - 1]}
                    onRespond={respond}
                    onUndo={(id) => void undo(id)}
                  />
                ),
              )}
              {busy && i === turns.length - 1 && (
                <div className="notice working">
                  {t.parts.some((p) => p.kind === "approval" && p.state === "pending" && (!p.reviewing || p.review))
                    ? <>等你确认上面的操作 <Icon name="point-up" /></>
                    : t.parts.some((p) => p.kind === "approval" && p.state === "pending")
                      ? <><Icon name="shield-check" /> 审批小助手正在看…</>
                    : phase === "compacting"
                      ? "上下文满了，压缩助手正在整理之前的工作…"
                    : phase === "running_tools"
                      ? "正在干活…"
                      : "思考中…"}
                </div>
              )}
            </div>
          ),
        )}
        {shareCards.map((c) => (
          <ShareCard key={c.key} record={c.record} onDismiss={() => setShareCards((cs) => cs.filter((x) => x.key !== c.key))} />
        ))}
      </div>

      {locked ? (
        <div className="locked">
          <p>
            {locked.reason === "other_provider"
              ? `这段对话是和 ${locked.providerName} 聊的。每家模型的记忆格式不一样，要接着聊需要切换回 ${locked.providerName}。`
              : `${locked.providerName} 还没设置好，暂时不能接着聊。${locked.message ?? ""}`}
          </p>
          <div className="row">
            <button type="button" className="send" onClick={() => props.onUnlock(locked)}>
              {locked.reason === "other_provider" ? `切换到 ${locked.providerName} 继续` : "去设置"}
            </button>
            <button type="button" className="mini-btn" onClick={props.onNewChat}>
              开始新对话
            </button>
          </div>
        </div>
      ) : (
      <form
        className={"composer" + (dragging ? " dragging" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void attach([...e.dataTransfer.files]);
        }}
      >
        <div className="composer-box">
        {(editor.activeFile || selLabel) && (
          <div className="ctx-chips" title="AI 能看到这些">
            {editor.activeFile && (
              <span className="ctx-chip">
                <Icon name={fileIconName(editor.activeFile.split("/").pop() ?? "")} className="ft" />
                <span>{editor.activeFile.split("/").pop()}</span>
              </span>
            )}
            {selLabel && <span className="ctx-chip"><span>{selLabel}</span></span>}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <div key={a.id} className="attachment" title={a.name}>
                <img src={a.thumb} alt={a.name} />
                <button
                  type="button"
                  aria-label={`移除 ${a.name}`}
                  onClick={() => setAttachments((xs) => xs.filter((x) => x.id !== a.id))}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}
        {(docs.length > 0 || reading > 0) && (
          <div className="file-chips">
            {docs.map((d) => (
              <FileChipView
                key={d.id}
                name={d.file.name}
                size={d.file.size}
                note={d.file.truncated ? "太长，只附上了前面一部分" : undefined}
                onRemove={() => setDocs((xs) => xs.filter((x) => x.id !== d.id))}
              />
            ))}
            {reading > 0 && <span className="file-chip reading">正在读取 {reading} 个文件…</span>}
          </div>
        )}
        {attachError && <div className="err-text">{attachError}</div>}
        <textarea
          id="chat-input"
          value={input}
          placeholder={
            docs.length
              ? "想问这些文件什么？不写也可以"
              : attachments.length
                ? "想问这张图什么？不写也可以"
                : superMode
                  ? "超级调度：说要做的整件事，本鲸拆开派给在线的 AI 们并行做，做完给你汇总～"
                  : lazy
                  ? "懒人模式：说一句要干嘛就行，本鲸全自动做完，不会再问你～"
                  : autopilot
                  ? "长任务模式：把要做的整件事说清楚，我做完叫你～"
                  : "想问什么都可以，Enter 发送。截图和文件可以直接粘贴或拖进来"
          }
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void attach(files);
            }
          }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {confirmLazy && (
          <div className="lazy-confirm" role="alertdialog" aria-label={confirmLazy === "super" ? "开启超级调度" : "开启懒人模式"}>
            <b>{confirmLazy === "super" ? "开启超级调度？" : "开启懒人模式？"}</b>
            <p>
              {confirmLazy === "super"
                ? "AI 只当指挥官：把任务拆开，派给终端里的 Claude Code / Codex 和已配置好的模型并行去做，自己不改文件、不跑命令。派活和子代理的操作都不再问你，会同时消耗多个模型的额度。管理员权限、删项目外的东西、改系统设置、碰密钥、推送发布会被自动拦下。进度在「调度台」里看。"
                : "AI 会完全自己做：改文件、装依赖、跑命令都不再问你，问题也自动按推荐回答。改坏的文件能撤销，命令做的事撤不回来。管理员权限、删项目外的东西、改系统设置、碰密钥、推送发布会被自动拦下。"}
            </p>
            <div className="actions">
              <button type="button" className="mini-btn" onClick={() => setConfirmLazy(false)}>
                算了
              </button>
              <button type="button" className="send" onClick={() => setMode(confirmLazy)}>
                {confirmLazy === "super" ? "开，你来指挥" : "开，全交给你"}
              </button>
            </div>
          </div>
        )}
        <div className="row">
          <span className={"select-pill strong" + (superMode ? " super" : lazy ? " lazy" : autopilot ? " autopilot" : "")}>
            <select
              id="chat-mode"
              value={mode}
              disabled={busy}
              onChange={(e) => {
                const m = e.target.value as ChatMode;
                // Lazy mode and super dispatch run everything unattended: say so once before switching.
                if (m === "lazy" || m === "super") setConfirmLazy(m);
                else setMode(m);
              }}
              aria-label="工作方式"
              title={
                superMode
                  ? "超级调度：AI 只当指挥官，把任务拆开派给在线的 AI（终端会话和已配置的模型）并行做，自己不动手；全程不问你，危险操作自动拦下"
                  : lazy
                  ? "懒人：完全自主，改文件、跑命令都不问你，一口气做完；管理员权限、动系统、推送发布这类会被自动拦下"
                  : autopilot
                  ? "长任务：AI 一口气做完整件事，改文件和跑命令由审批小助手把关；拿不准的、推送发布这类操作还是会叫你"
                  : "Agent：每次改文件、跑命令都先问你"
              }
            >
              <option value="agent">Agent</option>
              <option value="autopilot">长任务</option>
              <option value="lazy">懒人</option>
              <option value="super">超级调度</option>
            </select>
            <Icon name="chevron-down" />
          </span>
          {/* Claude (effort) and DeepSeek (reasoning_effort) have an adjustable thinking depth. */}
          {supportsEffort && (
            <span className="select-pill">
              <select id="effort" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} aria-label="思考深度">
                {(Object.keys(EFFORT_LABEL) as Effort[]).map((k) => (
                  <option key={k} value={k}>
                    {EFFORT_LABEL[k]}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </span>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn square"
            title="添加图片或文件：代码、文本、PDF（也可以粘贴或拖进来）"
            aria-label="添加图片或文件"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="attach" />
          </button>
          <input
            ref={fileRef}
            id="chat-image-input"
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {busy ? (
            <button type="button" className="stop-btn" onClick={() => void window.sweet.cancelChat()}>
              停下
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              aria-label="发送"
              title="发送（Enter）"
              disabled={(!input.trim() && !attachments.length && !docs.length) || reading > 0}
            >
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
        </div>
      </form>
      )}
    </aside>
  );
}

function applyEvent(parts: Part[], e: AgentEvent): Part[] {
  const last = parts[parts.length - 1];
  switch (e.type) {
    case "thinking_delta":
      if (last?.kind === "thinking") return [...parts.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...parts, { kind: "thinking", text: e.text }];
    case "text_delta":
      if (last?.kind === "text") return [...parts.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...parts, { kind: "text", text: e.text }];
    case "tool_preview": {
      // The card appears as soon as the call starts, and fills in as its arguments arrive.
      const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
      if (i === -1) return [...parts, { kind: "tool", id: e.id, summary: e.name, state: "preparing", partial: e.partial }];
      const p = parts[i];
      if (p.kind !== "tool") return parts;
      return [...parts.slice(0, i), { ...p, partial: e.partial }, ...parts.slice(i + 1)];
    }
    case "tool_start": {
      // The same card as its preview, if there was one: it switches from preparing to running.
      const summary = { kind: "tool" as const, id: e.id, summary: e.summary, state: "running" as const };
      const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
      if (i === -1) return [...parts, summary];
      return [...parts.slice(0, i), summary, ...parts.slice(i + 1)];
    }
    case "tool_end":
      return parts.map((p) => {
        if (p.kind === "tool" && p.id === e.id) return { ...p, state: e.ok ? "ok" : "fail", preview: e.preview };
        // An approved action that still failed (e.g. the file changed meanwhile).
        if (p.kind === "approval" && p.id === e.id && !e.ok) return { ...p, error: e.preview };
        return p;
      });
    case "approval_request": {
      // The diff card replaces the plain "修改 xxx" chip of the same tool call.
      const card: Part = {
        kind: "approval",
        id: e.id,
        subject: e.subject,
        state: "pending",
        auto: e.autoApproved,
        reviewing: !!e.reviewing,
      };
      const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
      return i === -1 ? [...parts, card] : [...parts.slice(0, i), card, ...parts.slice(i + 1)];
    }
    case "question": {
      // The card replaces the "问你 N 个问题" chip of the same tool call.
      const card: Part = { kind: "question", id: e.id, intro: e.intro, questions: e.questions };
      const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
      return i === -1 ? [...parts, card] : [...parts.slice(0, i), card, ...parts.slice(i + 1)];
    }
    case "question_answered":
      return parts.map((p) => (p.kind === "question" && p.id === e.id ? { ...p, answered: { answers: e.answers, usedDefaults: e.usedDefaults } } : p));
    case "hook":
      return [...parts, { kind: "hook", event: e.event, name: e.name, outcome: e.outcome, message: e.message, detail: e.detail }];
    case "memory_saved":
      return [...parts, { kind: "memory", id: e.id, text: e.text, scope: e.scope, updated: e.updated, lesson: e.lesson }];
    case "review":
      return parts.map((p) =>
        p.kind === "approval" && p.id === e.id ? { ...p, review: { decision: e.decision, reason: e.reason, model: e.model } } : p,
      );
    case "plan": {
      // One checklist per reply, updated in place.
      const i = parts.findIndex((p) => p.kind === "plan");
      const plan: Part = { kind: "plan", items: e.items };
      return i === -1 ? [...parts, plan] : [...parts.slice(0, i), plan, ...parts.slice(i + 1)];
    }
    case "approval_result":
      return parts.map((p) => (p.kind === "approval" && p.id === e.id ? { ...p, state: e.approved ? "approved" : "rejected" } : p));
    case "command_output":
      return parts.map((p) => {
        if (p.kind !== "approval" || p.id !== e.id) return p;
        // Keep the card light: the model gets the full output, the card shows the recent part.
        const output = ((p.run?.output ?? "") + e.chunk).slice(-20_000);
        return { ...p, run: { output, done: false } };
      });
    case "command_done":
      return parts.map((p) =>
        p.kind === "approval" && p.id === e.id
          ? { ...p, run: { output: p.run?.output ?? "", exitCode: e.exitCode, timedOut: e.timedOut, done: true } }
          : p,
      );
    case "turn_changes":
      return [...parts, { kind: "changes", turnId: e.turnId, files: e.files, undo: "idle" }];
    case "turn_undone":
      return parts.map((p) => (p.kind === "changes" && p.turnId === e.turnId ? { ...p, undo: "done", result: e.result } : p));
    case "vision": {
      // One part per batch of images: "reading…" becomes the result or the error.
      const part: Part = { kind: "vision", state: e.state, model: e.model, count: e.count, text: e.text };
      const i = parts.findIndex((p) => p.kind === "vision" && p.state === "start");
      return i === -1 ? [...parts, part] : [...parts.slice(0, i), part, ...parts.slice(i + 1)];
    }
    case "context_trimmed":
      return [
        ...parts,
        {
          kind: "notice",
          icon: e.how === "compacted" ? "archive" : "broom",
          text:
            e.how === "compacted"
              ? `上下文满了${e.tokens ? `（约 ${Math.round(e.tokens / 1000)}K）` : ""}，压缩助手把前面的工作整理成了摘要，计划和改过的文件都记着，接着往下做。`
              : `清理了一些旧的文件内容和命令输出${e.tokens ? `（约 ${Math.round(e.tokens / 1000)}K tokens）` : ""}，需要时我会重新读取。`,
        },
      ];
    case "model_switched": {
      const why = { manual: "换了模型", failover: "原来的模型出错了，自动换了模型", route: "按任务难度换了模型", reopen: "接着用当前模型" }[e.reason];
      const files = e.omitted ? `，${e.omitted} 段较早的文件内容放不下，用到时会重新读` : "，读过的文件不用重读";
      return [...parts, { kind: "notice", icon: "refresh", text: `${why}：${e.from} → ${e.to}。之前的工作记录都交给了新模型${files}。${e.detail ? `（${e.detail}）` : ""}` }];
    }
    case "done":
      if (e.reason === "cancelled") return [...parts, { kind: "notice", text: "已经停下了。这一轮不会被记住，可以换个说法重新问。" }];
      if (e.reason === "refusal") return [...parts, { kind: "notice", text: "这个问题我没法回答，换个问法试试？", error: true }];
      if (e.reason === "step_limit") return [...parts, { kind: "notice", text: "这个任务步骤太多，我先停在这里。说「继续」我就接着做。" }];
      return parts;
    case "error":
      return [...parts, { kind: "notice", text: e.message, error: true }];
    default:
      return parts;
  }
}

type Block = { kind: "part"; part: Part } | { kind: "activity"; parts: Part[] };

/** A finished tool call or decided approval: nothing left for the user to look at or answer. */
const settled = (p: Part) =>
  (p.kind === "tool" && p.state !== "running") ||
  // Context the hooks added is informational; blocks and failures stay visible.
  (p.kind === "hook" && (p.outcome === "context" || p.outcome === "allowed")) ||
  (p.kind === "approval" && p.state !== "pending" && !p.error && p.review?.decision !== "ask_human" && (p.subject.kind !== "command" || p.run?.done !== false));

/**
 * Fold runs of three or more settled steps into one "did N things" line, like Cursor. While the
 * reply is still streaming, the newest run stays open so the user can watch it.
 */
function group(parts: Part[], live: boolean): Block[] {
  const out: Block[] = [];
  let run: Part[] = [];
  const flush = (atEnd: boolean) => {
    if (run.length >= 3 && !(atEnd && live)) out.push({ kind: "activity", parts: run });
    else out.push(...run.map((part) => ({ kind: "part" as const, part })));
    run = [];
  };
  for (const p of parts) {
    if (settled(p)) run.push(p);
    else {
      flush(false);
      out.push({ kind: "part", part: p });
    }
  }
  flush(true);
  return out;
}

function ActivityGroup({ parts, ...rest }: { parts: Part[] } & Omit<PartViewProps, "part">) {
  const approvals = parts.filter((p): p is Extract<Part, { kind: "approval" }> => p.kind === "approval");
  const files = approvals.filter((p) => p.subject.kind === "file" && p.state === "approved").length;
  const commands = approvals.filter((p) => p.subject.kind === "command" && p.state === "approved").length;
  const passed = approvals.filter((p) => p.review?.decision === "approve").length;
  const blocked = approvals.filter((p) => p.review?.decision === "reject").length;
  const detail = [files && `改了 ${files} 个文件`, commands && `跑了 ${commands} 条命令`].filter(Boolean).join("，");
  return (
    <details className="activity">
      <summary>
        <span className="chev">
          <Icon name="chevron-right" />
        </span>
        <span className="spacer">
          做了 {parts.length} 件事{detail && `：${detail}`}
        </span>
        {passed + blocked > 0 && (
          <span className="reviews" title="审批小助手同意 / 拦下的次数">
            <Icon name="shield-check" /> 批 {passed}
            {blocked > 0 && ` · 拦 ${blocked}`}
          </span>
        )}
      </summary>
      <div className="items">
        {parts.map((p, i) => (
          <PartView key={i} part={p} {...rest} />
        ))}
      </div>
    </details>
  );
}

interface PartViewProps {
  part: Part;
  busy: boolean;
  /** A text part that is still growing. */
  streaming?: boolean;
  onRespond(r: ApprovalResponse): void;
  onUndo(turnId: number): void;
}

function PartView({ part, busy, streaming, onRespond, onUndo }: PartViewProps) {
  switch (part.kind) {
    case "approval":
      return (
        <>
          <ApprovalCard
            id={part.id}
            subject={part.subject}
            state={part.state}
            auto={part.auto}
            reviewing={part.reviewing}
            review={part.review}
            run={part.run}
            onRespond={onRespond}
          />
          {part.error && (
            <div className="notice error">
              {part.subject.kind === "file" ? "没有写进去：" : part.subject.kind === "tool" ? "调用失败：" : "没有运行："}
              {part.error}
            </div>
          )}
        </>
      );
    case "plan":
      return <PlanView items={part.items} />;
    case "question":
      return (
        <QuestionCard
          id={part.id}
          intro={part.intro}
          questions={part.questions}
          answered={part.answered}
          onAnswer={(r) => void window.sweet.answerQuestion(r)}
        />
      );
    case "hook":
      return <HookLine part={part} />;
    case "memory":
      return <MemoryLine part={part} />;
    case "changes":
      return <ChangesBar part={part} busy={busy} onUndo={onUndo} />;
    case "vision":
      if (part.state === "start") return <div className="notice">
          <Icon name="eye-search" /> 正在识别 {part.count} 张图片…</div>;
      if (part.state === "error") return <div className="notice error">
          <Icon name="eye-search" /> 识图失败：{part.text}</div>;
      return (
        <details className="thinking vision-result">
          <summary>
            <Icon name="eye-search" /> 识图结果（{part.model}，{part.count} 张）
          </summary>
          <div>{part.text}</div>
        </details>
      );
    case "thinking":
      return (
        <details className="thinking">
          <summary>
            <Icon name="thought" /> 想了想
          </summary>
          <div>{part.text}</div>
        </details>
      );
    case "text":
      return <Markdown text={part.text} streaming={streaming} />;
    case "tool":
      return (
        <div className={`tool-chip ${part.state}`} title={part.preview}>
          <span className="dot" />
          <span>{part.summary}</span>
          {part.state === "fail" && part.preview && <span className="err">· {part.preview.slice(0, 80)}</span>}
          {part.state === "preparing" && part.partial && <pre className="tool-partial">{part.partial}</pre>}
        </div>
      );
    case "notice":
      return (
        <div className={"notice" + (part.error ? " error" : "")} role={part.error ? "alert" : undefined}>
          {part.icon && <Icon name={part.icon} />} {part.text}
        </div>
      );
  }
}

const HOOK_ICON: Record<HookOutcomeKind, string> = {
  context: "hook",
  allowed: "check-circle",
  ask: "point-up",
  continue: "refresh",
  denied: "shield-check",
  blocked: "shield-check",
  error: "warning",
};

/** One line for what a hook did; the details (what it added, its error output) fold out. */
function HookLine({ part }: { part: Extract<Part, { kind: "hook" }> }) {
  const builtin = ["项目规则", "长期记忆", "相关记忆", "自动找相关代码"].includes(part.name);
  const label = (
    <>
      <Icon name={builtin && part.outcome === "context" ? (part.name === "自动找相关代码" ? "index" : "brain") : HOOK_ICON[part.outcome]} />
      <span>
        {part.message}
        {!builtin && <span className="hook-name"> · {part.name}</span>}
      </span>
    </>
  );
  const cls = `hook-line ${part.outcome}`;
  if (!part.detail) return <div className={cls}>{label}</div>;
  return (
    <details className={cls}>
      <summary>{label}</summary>
      <pre>{part.detail}</pre>
    </details>
  );
}

/** A memory the agent saved, with a way to take it back. */
function MemoryLine({ part }: { part: Extract<Part, { kind: "memory" }> }) {
  const [gone, setGone] = useState(!!part.forgotten);
  return (
    <div className={"memory-line" + (gone ? " gone" : "")}>
      <Icon name="brain" />
      <span className="t">
        <b>{gone ? "已忘掉" : part.lesson ? (part.updated ? "更新了经验" : "记下了经验") : part.updated ? "更新了记忆" : "记住了"}</b>
        <span className="scope">{part.scope === "global" ? "所有项目" : "本项目"}</span>
        {part.text}
      </span>
      {!gone && (
        <button
          type="button"
          className="icon-btn"
          title="删掉这条记忆，以后的对话不会再用到它"
          onClick={() => void window.sweet.deleteMemory(part.id).then(() => setGone(true))}
        >
          忘掉
        </button>
      )}
    </div>
  );
}

const PLAN_MARK: Record<PlanItem["status"], string> = { pending: "待做", in_progress: "进行中", done: "完成", skipped: "跳过" };

function PlanView({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === "done").length;
  return (
    <div className="plan" aria-label="任务计划">
      <div className="plan-head">
        <Icon name="list-check" /> 计划
        <span className="spacer" />
        <span className="count">
          {done}/{items.length}
        </span>
      </div>
      <div className="plan-bar" aria-hidden="true">
        <span style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ol>
        {items.map((it, i) => (
          <li key={i} className={it.status}>
            <span className="mark" aria-label={PLAN_MARK[it.status]} />
            <span className="t">{it.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChangesBar({ part, busy, onUndo }: { part: Extract<Part, { kind: "changes" }>; busy: boolean; onUndo(id: number): void }) {
  const names = part.files.map((f) => f.path.split("/").pop()).join("、");
  if (part.undo === "done" && part.result) {
    const { restored, skipped } = part.result;
    return (
      <div className="changes-bar done">
        <span>{restored.length ? `已撤销，${restored.length} 个文件恢复原样` : "没有文件被恢复"}</span>
        {skipped.map((s) => (
          <span key={s.path} className="skip">
            {s.path ? `${s.path}：` : ""}
            {s.reason}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="changes-bar">
      <span title={part.files.map((f) => f.path).join("\n")}>
        这一轮改了 {part.files.length} 个文件：{names}
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="mini-btn"
        disabled={busy || part.undo === "working"}
        title={busy ? "AI 停下以后才能撤销" : "把这些文件恢复成这一轮之前的样子"}
        onClick={() => onUndo(part.turnId)}
      >
        {part.undo === "working" ? "撤销中…" : <><Icon name="undo" /> 撤销这一轮</>}
      </button>
      {part.error && <span className="skip">{part.error}</span>}
    </div>
  );
}

/** Rebuild the chat from a saved conversation. */
function FileChipView({ name, size, note, onRemove }: { name: string; size: number; note?: string; onRemove?: () => void }) {
  return (
    <span className="file-chip" title={note ? `${name}：${note}` : name}>
      <Icon name={fileIconName(name)} className="ft" />
      <span className="name">{name}</span>
      <span className="size">{note ? "部分" : formatSize(size)}</span>
      {onRemove && (
        <button type="button" aria-label={`移除 ${name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      )}
    </span>
  );
}

function fromTranscript(items: TranscriptItem[]): Turn[] {
  return items.map((t) =>
    t.role === "user"
      ? t
      : {
          role: "ai",
          // A card still waiting when the app closed was never applied.
          parts: t.events
            .reduce(applyEvent, [] as Part[])
            .map((p) => (p.kind === "approval" && p.state === "pending" ? { ...p, state: "rejected" } : p)),
        },
  );
}

function HistoryList({ currentId, onPick, onClose }: { currentId?: string; onPick(id: string): void; onClose(): void }) {
  const [items, setItems] = useState<SessionSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    void window.sweet.listSessions().then(setItems);
  }, []);

  async function remove(id: string) {
    await window.sweet.deleteSession(id);
    setConfirmId(null);
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  }

  return (
    <div className="history" role="dialog" aria-label="历史对话">
      <div className="history-head">
        这个项目的对话
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
      </div>
      {items === null && <p className="hint">读取中…</p>}
      {items?.length === 0 && <p className="hint">还没有保存的对话。聊过的内容会自动保存在这里。</p>}
      <ul>
        {items?.map((x) => (
          <li key={x.id} className={x.id === currentId ? "current" : undefined}>
            <button type="button" className="history-item" onClick={() => onPick(x.id)}>
              <span className="t">{x.title}</span>
              <span className="meta">
                {timeAgo(x.updatedAt)} · {x.providerName}
              </span>
            </button>
            {confirmId === x.id ? (
              <button type="button" className="reject-btn small" onClick={() => void remove(x.id)}>
                确定删除
              </button>
            ) : (
              <button type="button" className="icon-btn" title="删除这段对话" aria-label="删除这段对话" onClick={() => setConfirmId(x.id)}>
                <Icon name="trash" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function timeAgo(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} 天前` : new Date(ts).toLocaleDateString();
}
