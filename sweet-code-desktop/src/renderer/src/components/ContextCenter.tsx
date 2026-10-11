import { useEffect, useState } from "react";
import type { ConsolidateReport, ContextSettings, MemoryItem, MemoryPending, ProviderView, RagStatus } from "@shared/types";
import { EMBEDDING_MODELS } from "@shared/embeddings";
import { Icon } from "./Icon";
import { timeAgo } from "./StartPage";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

interface Props {
  providers: ProviderView[];
  hasProject: boolean;
  onClose(): void;
}

/** What the AI knows beyond the conversation: long-term memories and the project's code index. */
export function ContextCenter({ providers, hasProject, onClose }: Props) {
  const [tab, setTab] = useState<"memory" | "index">("memory");
  const [settings, setSettings] = useState<ContextSettings | null>(null);
  useEffect(() => {
    void window.sweet.getContextSettings().then(setSettings);
  }, []);
  const change = async (c: Partial<ContextSettings>) => setSettings(await window.sweet.setContextSettings(c));

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plugin-modal" role="dialog" aria-label="记忆与索引">
        <div className="plugin-head">
          <h2>记忆与索引</h2>
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "on" : undefined} onClick={() => setTab("memory")}>
              记忆
            </button>
            <button type="button" role="tab" aria-selected={tab === "index"} className={tab === "index" ? "on" : undefined} onClick={() => setTab("index")}>
              代码索引
            </button>
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn square" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        {settings &&
          (tab === "memory" ? (
            <MemoryTab settings={settings} change={change} hasProject={hasProject} />
          ) : (
            <IndexTab settings={settings} change={change} providers={providers} hasProject={hasProject} />
          ))}
      </div>
    </div>
  );
}

interface TabProps {
  settings: ContextSettings;
  change(c: Partial<ContextSettings>): Promise<void>;
  hasProject: boolean;
}

function MemoryTab({ settings, change, hasProject }: TabProps) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"project" | "global">(hasProject ? "project" : "global");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<MemoryPending[]>([]);
  const [tidying, setTidying] = useState(false);
  const [report, setReport] = useState<ConsolidateReport | null>(null);
  useEffect(() => {
    void window.sweet.listMemories().then(setItems);
    void window.sweet.pendingMemories().then(setPending);
  }, []);

  async function tidy() {
    setTidying(true);
    setError("");
    try {
      const r = await window.sweet.consolidateMemory();
      setReport(r);
      setPending(r.pending);
      setItems(await window.sweet.listMemories());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setTidying(false);
    }
  }

  async function answer(id: string, accept: boolean) {
    setItems(await window.sweet.resolvePendingMemory(id, accept));
    setPending((ps) => ps.filter((p) => p.id !== id));
  }

  async function add() {
    setError("");
    try {
      setItems(await window.sweet.addMemory(text, scope));
      setText("");
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const active = items?.filter((m) => m.tier !== "c4") ?? [];
  const project = active.filter((m) => m.scope === "project");
  const global = active.filter((m) => m.scope === "global");
  const archive = items?.filter((m) => m.tier === "c4") ?? [];

  return (
    <div className="plugin-body">
      <p className="hint">
        AI 会把你的习惯、项目的约定和重要决定记成一句话，以后的新对话自动带上；记错了可以在这里删掉。不会记密钥。
      </p>
      <div className="toggle-list">
        <label className="toggle">
          <input type="checkbox" checked={settings.memory} onChange={(e) => void change({ memory: e.target.checked })} />
          开启长期记忆
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.autoRecall} disabled={!settings.memory} onChange={(e) => void change({ autoRecall: e.target.checked })} />
          每条消息自动带上相关的记忆
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.rules} onChange={(e) => void change({ rules: e.target.checked })} />
          读取项目规则文件（AGENTS.md、CLAUDE.md、.cursorrules）
        </label>
      </div>

      <form
        className="install-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void add();
        }}
      >
        <label htmlFor="memory-text" className="plugin-h3" style={{ margin: 0 }}>
          自己加一条
        </label>
        <div className="field-row">
          <input id="memory-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="比如：代码注释都用中文写" maxLength={500} />
          <select value={scope} onChange={(e) => setScope(e.target.value as "project" | "global")} aria-label="记在哪里" className="small-select">
            <option value="project" disabled={!hasProject}>
              只在本项目
            </option>
            <option value="global">所有项目</option>
          </select>
          <button type="submit" className="send" disabled={!text.trim()}>
            记住
          </button>
        </div>
        {error && <div className="err-text">{error}</div>}
      </form>

      <section className="tidy-box">
        <div className="field-row">
          <span className="hint" style={{ flex: 1 }}>
            聊完以后空闲 10 分钟，AI 会把最近几次对话里值得记的事整理进来：你亲口说要记的直接记；只提过一次的先放着，14 天内再提到才记；和已有记忆矛盾的、要用到所有项目的，等你点头。
          </span>
          <button type="button" className="mini-btn" disabled={tidying || !settings.memory} onClick={() => void tidy()}>
            {tidying ? "整理中…" : "现在整理记忆"}
          </button>
        </div>
        {report && <p className="hint">{describeReport(report)}</p>}
      </section>

      {pending.length > 0 && (
        <section>
          <h3 className="plugin-h3">
            等你确认 <span>{pending.length} 条</span>
          </h3>
          <ul className="plugin-list">
            {pending.map((p) => (
              <li key={p.id} className="plugin-item">
                <div className="main">
                  <span className="desc" style={{ color: "var(--ink)" }}>
                    {p.text}
                  </span>
                  <span className="hint">
                    {p.reason === "global" ? "想记成「所有项目」都适用的" : `和已有的「${p.conflict?.text}」矛盾：${p.conflict?.reason}`}
                  </span>
                </div>
                <button type="button" className="mini-btn" onClick={() => void answer(p.id, true)}>
                  {p.reason === "conflict" ? "换成新的" : "记住"}
                </button>
                <button type="button" className="mini-btn" onClick={() => void answer(p.id, false)}>
                  {p.reason === "conflict" ? "保留旧的" : "不要"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {items === null ? (
        <p className="hint">读取中…</p>
      ) : (
        <>
          <MemoryList title={hasProject ? "本项目" : "本项目（先打开一个项目）"} items={project} onChange={setItems} />
          <MemoryList title="所有项目" items={global} onChange={setItems} />
          {archive.length > 0 && (
            <details className="memory-archive">
              <summary className="plugin-h3">
                归档 <span>{archive.length} 条</span>
              </summary>
              <p className="hint">超过 90 天没用到、也很少用的记忆会放到这里。新对话不再自动带上，但 AI 用 recall 查找时还能找到，找到后会自动回到上面。</p>
              <MemoryList title="" items={archive} onChange={setItems} />
            </details>
          )}
        </>
      )}
    </div>
  );
}

const KIND = { preference: "偏好", fact: "事实", decision: "决定", note: "笔记", lesson: "经验" } as const;

function describeReport(r: ConsolidateReport): string {
  if (r.skipped && !r.sessions && !r.archived && !r.expired) return `没有整理：${r.skipped}。`;
  const parts = [`读了 ${r.sessions} 次对话的摘要`];
  if (r.added.length) parts.push(`新记住 ${r.added.length} 条`);
  if (r.merged.length) parts.push(`${r.merged.length} 条已有的又被提到`);
  if (r.candidates) parts.push(`${r.candidates} 条先放着，再提到就记`);
  if (r.expired) parts.push(`${r.expired} 条放了 14 天没再提，丢掉了`);
  if (r.archived) parts.push(`${r.archived} 条很久没用，放进了归档`);
  if (r.pending.length) parts.push(`${r.pending.length} 条等你确认`);
  return parts.join("，") + "。";
}

function MemoryList({ title, items, onChange }: { title: string; items: MemoryItem[]; onChange(items: MemoryItem[]): void }) {
  return (
    <section>
      {title && (
        <h3 className="plugin-h3">
          {title} <span>{items.length} 条</span>
        </h3>
      )}
      {items.length === 0 ? (
        <p className="hint">还没有。</p>
      ) : (
        <ul className="plugin-list">
          {items.map((m) => (
            <li key={m.id} className="plugin-item">
              <div className="main">
                <span className="desc" style={{ color: "var(--ink)" }}>
                  {m.text}
                </span>
                <span className="hint">
                  {KIND[m.kind] ?? "笔记"} · {timeAgo(m.updatedAt)}
                  {m.uses > 0 && ` · 用到过 ${m.uses} 次`}
                  {(m.evidence ?? 1) > 1 && ` · 在 ${m.evidence} 次对话里提到`}
                </span>
              </div>
              <button
                type="button"
                className="icon-btn square"
                title="删掉这条记忆"
                aria-label={`删掉记忆：${m.text}`}
                onClick={() => void window.sweet.deleteMemory(m.id).then(onChange)}
              >
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IndexTab({ settings, change, providers, hasProject }: TabProps & { providers: ProviderView[] }) {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [providerId, setProviderId] = useState(settings.embedding?.providerId ?? "");
  const [model, setModel] = useState(settings.embedding?.model ?? "");

  useEffect(() => {
    void window.sweet.ragStatus().then(setStatus);
    return window.sweet.onRagStatus(setStatus);
  }, []);

  async function rebuild() {
    setError("");
    setBusy(true);
    try {
      setStatus(await window.sweet.ragRebuild());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  // Claude has no embeddings model; every other provider speaks the OpenAI format.
  const choices = providers.filter((p) => p.kind === "openai");
  const saved = settings.embedding;
  const dirty = (saved?.providerId ?? "") !== providerId || (!!providerId && (saved?.model ?? "") !== model.trim());
  const sem = status?.semantic;

  return (
    <div className="plugin-body">
      <p className="hint">
        把项目代码切成小段建一个索引。AI 可以用它快速找到相关代码（search_code），你每次发消息时也会自动附上最相关的几段。
        索引在第一次用到时才建立，之后只更新改过的文件，全部在本机完成。
      </p>

      <div className="install-box">
        <div className="row">
          <Icon name="index" />
          <b>{!hasProject ? "还没打开项目" : !status || status.state === "empty" ? "还没建立（第一次用到时自动建立）" : status.state === "indexing" ? "正在建立…" : "已就绪"}</b>
          <span className="spacer" />
          <button type="button" className="mini-btn" disabled={!hasProject || busy} onClick={() => void rebuild()}>
            <Icon name="refresh" /> {busy ? "建立中…" : status?.state === "ready" ? "重新建立" : "现在建立"}
          </button>
        </div>
        {status && status.state !== "empty" && (
          <p className="hint">
            {status.files} 个文件，{status.chunks} 段代码{status.indexedAt ? ` · ${timeAgo(status.indexedAt)}更新` : ""}
          </p>
        )}
        {error && <div className="err-text">{error}</div>}
        <label className="toggle">
          <input type="checkbox" checked={settings.autoContext} onChange={(e) => void change({ autoContext: e.target.checked })} />
          每条消息自动附上相关代码（只在明显相关时才附，闲聊不花 token）
        </label>
      </div>

      <div className="install-box">
        <div className="row">
          <Icon name="sparkle" />
          <b>语义检索</b>
          <span className="hint">可选。用向量模型按“意思”找代码，中文提问也能找到英文写的代码。</span>
        </div>
        <div className="field-row">
          <select
            value={providerId}
            aria-label="向量模型的服务商"
            className="small-select"
            onChange={(e) => {
              setProviderId(e.target.value);
              setModel(EMBEDDING_MODELS[e.target.value] ?? "");
            }}
          >
            <option value="">关闭（只用关键词）</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {providerId && <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="向量模型名，如 text-embedding-3-small" aria-label="向量模型名" />}
          <button
            type="button"
            className="mini-btn"
            disabled={!dirty || (!!providerId && !model.trim())}
            onClick={() => void change({ embedding: providerId ? { providerId, model } : null })}
          >
            保存
          </button>
        </div>
        {saved && sem && (
          <>
            {sem.error ? (
              <p className="err-text">{sem.error}</p>
            ) : (
              <p className="hint">
                {sem.total ? `已向量化 ${sem.embedded} / ${sem.total} 段` : "建立索引后开始向量化"}
                {sem.running && "（后台进行中，期间先用关键词检索）"}
              </p>
            )}
            {sem.total > 0 && (
              <div className="plan-bar" aria-hidden="true">
                <span style={{ width: `${(sem.embedded / sem.total) * 100}%` }} />
              </div>
            )}
          </>
        )}
        <p className="hint">会把代码片段发给所选服务商计算向量，按它的价格计费（一般很便宜）。.env 和密钥文件不会被索引。</p>
      </div>
    </div>
  );
}
