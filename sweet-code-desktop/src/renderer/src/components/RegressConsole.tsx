import { memo, useEffect, useMemo, useState } from "react";
import type { AgentCli, AgentSessionView, RegressCandidate, RegressDiffRow, RegressItem, RegressOwner, RegressRun, RegressSettings, RegressVerdict, RegressView } from "@shared/types";
import { Icon } from "./Icon";
import "../styles/regress.css";

// The regression panel: a session proposes checks, the user keeps the good ones, then any idle
// Claude Code / Codex session runs them. Each item shows the latest verdict per CLI; baselines
// snapshot those verdicts so a later round can be compared against them.

const EMPTY: RegressView = {
  root: null,
  items: [],
  latest: {},
  conflicts: [],
  baselines: [],
  busy: { sessions: [], runs: [] },
  settings: { runTimeoutSec: 600, generateTimeoutSec: 900, maxPerBatch: 50, maxCandidates: 30 },
};

const OWNER: Record<RegressOwner, string> = { frontend: "前端", backend: "后端", both: "前后端" };
const CLI: Record<AgentCli, string> = { claude: "Claude", codex: "Codex" };
const VERDICT: Record<RegressVerdict, string> = { pass: "通过", fail: "不通过", pending: "待定" };
const STATUS: Record<RegressRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  done: "完成",
  timeout: "超时",
  gone: "会话已关闭",
  cancelled: "已停止",
  error: "出错",
};
const DIFF: Record<RegressDiffRow["kind"], string> = { regressed: "退步", fixed: "修好了", same: "没变", new: "新增", missing: "这次没跑" };
const SETTING_RANGE: Record<keyof RegressSettings, [number, number, string]> = {
  runTimeoutSec: [30, 3600, "每条检查最多等（秒）"],
  generateTimeoutSec: [60, 3600, "出题最多等（秒）"],
  maxPerBatch: [1, 200, "一次最多运行几条"],
  maxCandidates: [1, 100, "一次最多出几道题"],
};

type Result<T> = T | { error: string };
const failed = <T,>(r: Result<T>): r is { error: string } => typeof r === "object" && r !== null && "error" in r;

function ago(t: number, now: number): string {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

function took(run: RegressRun, now: number): string {
  const s = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const live = (r?: RegressRun) => !!r && (r.status === "queued" || r.status === "running");

interface Props {
  hidden: boolean;
}

export const RegressConsole = memo(function RegressConsole({ hidden }: Props) {
  const [view, setView] = useState<RegressView>(EMPTY);
  const [sessions, setSessions] = useState<AgentSessionView[]>([]);
  const [session, setSession] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<null | "generate" | "baselines" | "settings">(null);
  const [reply, setReply] = useState<{ run: RegressRun; text: string | null } | null>(null);

  // Followed only while it is on screen (the terminal sessions change with every tool call they
  // make); fetched afresh each time it comes back.
  useEffect(() => {
    if (hidden) return;
    void window.sweet.regressView().then(setView);
    return window.sweet.onRegressChanged(setView);
  }, [hidden]);
  useEffect(() => {
    if (hidden) return;
    void window.sweet.termAgents().then(setSessions);
    return window.sweet.onTermAgents(setSessions);
  }, [hidden]);

  // Sessions the panel can use: open, and not already busy with the panel.
  const usable = sessions.filter((s) => !view.busy.sessions.includes(s.name));
  useEffect(() => {
    if (session && sessions.some((s) => s.name === session)) return;
    setSession(usable.find((s) => s.status === "idle")?.name ?? usable[0]?.name ?? "");
  }, [sessions, view.busy.sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = view.busy.runs.length;
  useEffect(() => {
    if ((!running && !view.busy.generate) || hidden) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, view.busy.generate, hidden]);

  // Forget selections of items that were deleted.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => view.items.some((i) => i.id === id))));
  }, [view.items]);

  const apply = (r: Result<RegressView>) => {
    if (failed(r)) setError(r.error);
    else {
      setError("");
      setView(r);
    }
  };

  async function run(ids: string[]) {
    if (!session) return setError("先在终端里开一个 Claude Code 或 Codex 会话，再来运行。");
    const max = view.settings.maxPerBatch;
    const batch = ids.slice(0, max);
    const r = await window.sweet.regressRun(batch, session);
    if (failed(r)) return setError(r.error);
    setError(ids.length > max ? `一次最多运行 ${max} 条，先排了前 ${max} 条。` : "");
  }

  const counts = useMemo(() => {
    let pass = 0;
    let fail = 0;
    let pending = 0;
    for (const item of view.items) {
      for (const r of Object.values(view.latest[item.id] ?? {})) {
        if (!r || live(r) || r.status !== "done") continue;
        if (r.verdict === "pass") pass++;
        else if (r.verdict === "fail") fail++;
        else pending++;
      }
    }
    return { pass, fail, pending };
  }, [view]);

  if (!view.root) {
    return (
      <main className="group regress" hidden={hidden}>
        <div className="regress-empty">
          <Icon name="list-check" />
          <b>回归测试</b>
          <p>先打开一个项目。检查清单和每次的结果存在项目的 .sikeoop/regress 里。</p>
        </div>
      </main>
    );
  }

  const allIds = view.items.map((i) => i.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  return (
    <main className="group regress" hidden={hidden}>
      <div className="section-head regress-head">
        <div className="regress-title">
          <strong>回归测试</strong>
          <span className="regress-counts">
            {view.items.length} 条检查
            {counts.pass > 0 && <span className="ok"> · 通过 {counts.pass}</span>}
            {counts.fail > 0 && <span className="bad"> · 不通过 {counts.fail}</span>}
            {counts.pending > 0 && <span className="warn"> · 待定 {counts.pending}</span>}
            {running > 0 && <span> · 运行中 {running}</span>}
            {view.conflicts.length > 0 && <span className="bad"> · 两边结论不一致 {view.conflicts.length}</span>}
          </span>
        </div>
        <label className="regress-session" title="出题和运行用哪个终端会话">
          <span>会话</span>
          <select id="regress-session" value={session} onChange={(e) => setSession(e.target.value)} disabled={usable.length === 0}>
            {usable.length === 0 && <option value="">（没有可用的会话）</option>}
            {usable.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name} · {s.status === "idle" ? "空闲" : s.status === "working" ? "忙" : s.status === "waiting" ? "等你回复" : "启动中"}
              </option>
            ))}
          </select>
        </label>
        <div className="regress-actions">
          <button type="button" className={"regress-btn" + (panel === "generate" ? " on" : "")} onClick={() => setPanel(panel === "generate" ? null : "generate")}>
            <Icon name="sparkle" /> 让会话出题
          </button>
          <button type="button" className="regress-btn primary" disabled={!session || view.items.length === 0} onClick={() => void run(selected.size ? [...selected] : allIds)}>
            <Icon name="play" /> {selected.size ? `运行选中的 ${selected.size} 条` : "全部运行"}
          </button>
          {running > 0 && (
            <button type="button" className="regress-btn" onClick={() => void window.sweet.regressCancel()}>
              <Icon name="stop" /> 全部停止
            </button>
          )}
          <button type="button" className={"regress-btn" + (panel === "baselines" ? " on" : "")} onClick={() => setPanel(panel === "baselines" ? null : "baselines")}>
            <Icon name="history" /> 基线
          </button>
          <button type="button" className={"regress-btn icon" + (panel === "settings" ? " on" : "")} onClick={() => setPanel(panel === "settings" ? null : "settings")} title="设置" aria-label="设置">
            <Icon name="settings" />
          </button>
        </div>
      </div>

      {error && (
        <div className="regress-error" role="alert">
          <Icon name="warning" /> {error}
          <button type="button" className="regress-x" onClick={() => setError("")} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
      )}

      {panel === "generate" && <Generate view={view} session={session} now={now} onAdded={(v) => (apply(v), setPanel(null))} onError={setError} />}
      {panel === "baselines" && <Baselines view={view} onView={apply} onError={setError} />}
      {panel === "settings" && <Settings settings={view.settings} onView={(v) => (apply(v), !failed(v) && setPanel(null))} />}

      {view.items.length === 0 ? (
        <div className="regress-empty">
          <Icon name="list-check" />
          <b>还没有检查项</b>
          <p>点「让会话出题」，让一个 Claude Code 或 Codex 会话读一遍代码，提出该检查的地方；你挑好的加进来，以后每次改完代码跑一遍。</p>
        </div>
      ) : (
        <>
          <label className="regress-select-all">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(allIds))} />
            全选
          </label>
          <ul className="regress-list">
            {view.items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                latest={view.latest[item.id] ?? {}}
                conflict={view.conflicts.includes(item.id)}
                selected={selected.has(item.id)}
                now={now}
                canRun={!!session}
                onSelect={(on) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (on) n.add(item.id);
                    else n.delete(item.id);
                    return n;
                  })
                }
                onRun={() => void run([item.id])}
                onView={apply}
                onReply={(r) => {
                  setReply({ run: r, text: null });
                  void window.sweet.regressReply(r.id).then((t) => setReply({ run: r, text: failed(t) ? `（读不到完整回复：${t.error}）` : t }));
                }}
              />
            ))}
          </ul>
        </>
      )}

      {reply && <ReplyDialog run={reply.run} text={reply.text} onClose={() => setReply(null)} />}
    </main>
  );
});

// ---- one item ----------------------------------------------------------------------------

interface ItemProps {
  item: RegressItem;
  latest: Partial<Record<AgentCli, RegressRun>>;
  conflict: boolean;
  selected: boolean;
  now: number;
  canRun: boolean;
  onSelect(on: boolean): void;
  onRun(): void;
  onView(r: Result<RegressView>): void;
  onReply(r: RegressRun): void;
}

function ItemCard({ item, latest, conflict, selected, now, canRun, onSelect, onRun, onView, onReply }: ItemProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runs = (Object.keys(CLI) as AgentCli[]).map((cli) => latest[cli]).filter((r): r is RegressRun => !!r);
  const busy = runs.some(live);

  if (editing) {
    return (
      <li className="regress-item editing">
        <CandidateForm
          value={item}
          submitLabel="保存"
          onCancel={() => setEditing(false)}
          onSubmit={async (patch) => {
            const r = await window.sweet.regressUpdateItem(item.id, patch);
            onView(r);
            if (!failed(r)) setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className={"regress-item" + (conflict ? " conflict" : "")}>
      <input type="checkbox" className="regress-check" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`选中 ${item.title}`} />
      <div className="regress-main">
        <div className="regress-item-head">
          <b>{item.title}</b>
          <span className={`regress-owner ${item.owner}`}>{OWNER[item.owner]}</span>
          {conflict && <span className="regress-conflict">Claude 和 Codex 结论不一致</span>}
        </div>
        {item.detail && <p className="regress-detail">{item.detail}</p>}
        {item.criteria && (
          <p className="regress-criteria">
            <span>通过条件</span>
            {item.criteria}
          </p>
        )}
        {runs.length > 0 && (
          <div className="regress-runs">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} now={now} onView={onView} onReply={() => onReply(r)} />
            ))}
          </div>
        )}
      </div>
      <div className="regress-item-actions">
        <button type="button" className="regress-btn small" disabled={!canRun || busy} onClick={onRun} title={busy ? "正在运行" : "用选中的会话运行这一条"}>
          <Icon name="play" /> 运行
        </button>
        <button type="button" className="regress-btn small icon" onClick={() => setEditing(true)} title="编辑" aria-label={`编辑 ${item.title}`}>
          <Icon name="list-check" />
        </button>
        {confirmDelete ? (
          <span className="regress-confirm">
            <button type="button" className="regress-btn small danger" onClick={() => void window.sweet.regressDeleteItem(item.id).then(onView)}>
              删掉
            </button>
            <button type="button" className="regress-btn small" onClick={() => setConfirmDelete(false)}>
              算了
            </button>
          </span>
        ) : (
          <button type="button" className="regress-btn small icon" onClick={() => setConfirmDelete(true)} title="删除" aria-label={`删除 ${item.title}`}>
            <Icon name="trash" />
          </button>
        )}
      </div>
    </li>
  );
}

function RunRow({ run, now, onView, onReply }: { run: RegressRun; now: number; onView(r: Result<RegressView>): void; onReply(): void }) {
  const active = live(run);
  const state = active ? run.status : run.status === "done" ? run.verdict : run.status;
  return (
    <div className={`regress-run ${state}`}>
      <span className="regress-cli">{CLI[run.cli]}</span>
      <span className="regress-session-name">{run.session}</span>
      <span className={`regress-verdict ${state}`}>
        {active && <span className="regress-spinner" aria-hidden="true" />}
        {active ? STATUS[run.status] : run.status === "done" ? VERDICT[run.verdict] : STATUS[run.status]}
        {run.overridden && <em>（人工改判）</em>}
      </span>
      <span className="regress-time">{active ? took(run, now) : ago(run.endedAt ?? run.startedAt, now)}</span>
      {(run.reason || run.error) && <span className="regress-reason" title={run.reason || run.error}>{run.reason || run.error}</span>}
      <span className="regress-run-actions">
        {active ? (
          <button type="button" className="link-btn" onClick={() => void window.sweet.regressCancel(run.id)}>
            停止
          </button>
        ) : (
          <>
            {run.status === "done" && run.verdict !== "pass" && (
              <button type="button" className="link-btn" onClick={() => void window.sweet.regressOverride(run.id, "pass").then(onView)} title="人工判定为通过">
                判通过
              </button>
            )}
            {run.status === "done" && run.verdict !== "fail" && (
              <button type="button" className="link-btn" onClick={() => void window.sweet.regressOverride(run.id, "fail").then(onView)} title="人工判定为不通过">
                判不通过
              </button>
            )}
            <button type="button" className="link-btn" onClick={onReply}>
              看回复
            </button>
          </>
        )}
      </span>
    </div>
  );
}

// ---- generate ----------------------------------------------------------------------------

function Generate({ view, session, now, onAdded, onError }: { view: RegressView; session: string; now: number; onAdded(v: Result<RegressView>): void; onError(e: string): void }) {
  const [focus, setFocus] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [candidates, setCandidates] = useState<(RegressCandidate & { keep: boolean })[] | null>(null);
  const [raw, setRaw] = useState("");
  const gen = view.busy.generate;

  async function ask() {
    if (!session) return onError("先在终端里开一个 Claude Code 或 Codex 会话。");
    setWaiting(true);
    setCandidates(null);
    setRaw("");
    const r = await window.sweet.regressGenerate(session, focus.trim() || undefined);
    setWaiting(false);
    if (failed(r)) {
      onError(r.error);
      setRaw(r.rawExcerpt ?? "");
      return;
    }
    setRaw(r.rawExcerpt);
    setCandidates(r.candidates.map((c) => ({ ...c, keep: true })));
  }

  const kept = candidates?.filter((c) => c.keep) ?? [];
  return (
    <section className="regress-panel">
      <h3>让会话出题</h3>
      <p className="hint">选中的会话会读一遍项目代码，提出最多 {view.settings.maxCandidates} 条值得反复检查的地方，每条带一个能客观判断的通过条件。出完你挑着加。</p>
      <div className="regress-row">
        <input id="regress-focus" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="只看某一块？比如：内置浏览器、记忆整理（可以不填）" disabled={waiting} />
        <button type="button" className="regress-btn primary" disabled={!session || waiting || !!gen} onClick={() => void ask()}>
          <Icon name="sparkle" /> {waiting || gen ? "出题中…" : `让 ${session || "会话"} 出题`}
        </button>
      </div>
      {gen && <p className="hint">{gen.session} 正在读代码，已经 {Math.max(0, Math.floor((now - gen.startedAt) / 1000))} 秒，最多等 {view.settings.generateTimeoutSec} 秒。</p>}
      {candidates && candidates.length === 0 && <p className="hint">这次没有提出检查项。换个范围试试。</p>}
      {candidates && candidates.length > 0 && (
        <>
          <ul className="regress-candidates">
            {candidates.map((c, i) => (
              <li key={i} className={c.keep ? "" : "off"}>
                <input type="checkbox" checked={c.keep} onChange={(e) => setCandidates((cs) => cs!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} aria-label={`保留 ${c.title}`} />
                <div>
                  <div className="regress-item-head">
                    <b>{c.title}</b>
                    <span className={`regress-owner ${c.owner}`}>{OWNER[c.owner]}</span>
                  </div>
                  {c.detail && <p className="regress-detail">{c.detail}</p>}
                  {c.criteria && (
                    <p className="regress-criteria">
                      <span>通过条件</span>
                      {c.criteria}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="regress-row end">
            <button type="button" className="regress-btn" onClick={() => setCandidates(null)}>
              都不要
            </button>
            <button type="button" className="regress-btn primary" disabled={kept.length === 0} onClick={() => void window.sweet.regressAddItems(kept.map(({ keep: _keep, ...c }) => c)).then(onAdded)}>
              <Icon name="plus" /> 加入 {kept.length} 条
            </button>
          </div>
        </>
      )}
      {raw && (!candidates || candidates.length === 0) && (
        <details className="regress-raw">
          <summary>看会话的原始回复</summary>
          <pre>{raw}</pre>
        </details>
      )}
      <details className="regress-raw">
        <summary>自己加一条</summary>
        <CandidateForm value={{ title: "", detail: "", owner: "both", criteria: "" }} submitLabel="加入" onSubmit={async (c) => onAdded(await window.sweet.regressAddItems([c]))} />
      </details>
    </section>
  );
}

function CandidateForm({ value, submitLabel, onSubmit, onCancel }: { value: RegressCandidate; submitLabel: string; onSubmit(c: RegressCandidate): Promise<void>; onCancel?(): void }) {
  const [c, setC] = useState<RegressCandidate>({ title: value.title, detail: value.detail, owner: value.owner, criteria: value.criteria });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof RegressCandidate) => (e: { target: { value: string } }) => setC((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      className="regress-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!c.title.trim()) return;
        setSaving(true);
        await onSubmit({ ...c, title: c.title.trim(), detail: c.detail.trim(), criteria: c.criteria.trim() });
        setSaving(false);
      }}
    >
      <div className="regress-row">
        <input value={c.title} onChange={set("title")} placeholder="检查什么，比如：内置浏览器能打开 localhost" aria-label="标题" autoFocus />
        <select value={c.owner} onChange={set("owner")} aria-label="属于哪一边">
          {(Object.keys(OWNER) as RegressOwner[]).map((o) => (
            <option key={o} value={o}>
              {OWNER[o]}
            </option>
          ))}
        </select>
      </div>
      <textarea value={c.detail} onChange={set("detail")} placeholder="怎么检查：打开哪里、做什么操作" rows={2} aria-label="怎么检查" />
      <input value={c.criteria} onChange={set("criteria")} placeholder="通过条件：一句能客观判断的话，比如「typecheck 没有报错」" aria-label="通过条件" />
      <div className="regress-row end">
        {onCancel && (
          <button type="button" className="regress-btn" onClick={onCancel}>
            取消
          </button>
        )}
        <button type="submit" className="regress-btn primary" disabled={!c.title.trim() || saving}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---- baselines ---------------------------------------------------------------------------

function Baselines({ view, onView, onError }: { view: RegressView; onView(r: Result<RegressView>): void; onError(e: string): void }) {
  const [name, setName] = useState("");
  const [diff, setDiff] = useState<{ id: string; rows: RegressDiffRow[] } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const title = (id: string) => view.items.find((i) => i.id === id)?.title ?? "（已删除的检查）";
  const order: RegressDiffRow["kind"][] = ["regressed", "fixed", "new", "missing", "same"];

  return (
    <section className="regress-panel">
      <h3>基线</h3>
      <p className="hint">把现在每条检查的最新结论存成一份基线。以后改了代码再跑一遍，和基线对比，就知道哪些退步了、哪些修好了。</p>
      <form
        className="regress-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onView(await window.sweet.regressSnapshot(name.trim()));
          setName("");
        }}
      >
        <input id="regress-baseline-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="基线名字，比如：4.1 发布前" />
        <button type="submit" className="regress-btn primary" disabled={!name.trim()}>
          存为基线
        </button>
      </form>
      {view.baselines.length === 0 ? (
        <p className="hint">还没有基线。</p>
      ) : (
        <ul className="regress-baselines">
          {view.baselines.map((b) => (
            <li key={b.id}>
              <b>{b.name}</b>
              <span className="regress-time">{new Date(b.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="spacer" />
              <button
                type="button"
                className="regress-btn small"
                onClick={async () => {
                  const r = await window.sweet.regressDiff(b.id);
                  if (failed(r)) return onError(r.error);
                  setDiff({ id: b.id, rows: [...r].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind)) });
                }}
              >
                和现在对比
              </button>
              {confirm === b.id ? (
                <>
                  <button type="button" className="regress-btn small danger" onClick={() => void window.sweet.regressDeleteBaseline(b.id).then((v) => (onView(v), setConfirm(null), diff?.id === b.id && setDiff(null)))}>
                    删掉
                  </button>
                  <button type="button" className="regress-btn small" onClick={() => setConfirm(null)}>
                    算了
                  </button>
                </>
              ) : (
                <button type="button" className="regress-btn small icon" onClick={() => setConfirm(b.id)} aria-label={`删除基线 ${b.name}`} title="删除">
                  <Icon name="trash" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="regress-diff">
          <div className="regress-diff-sum">
            {order
              .map((k) => [k, diff.rows.filter((r) => r.kind === k).length] as const)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <span key={k} className={`regress-kind ${k}`}>
                  {DIFF[k]} {n}
                </span>
              ))}
          </div>
          {diff.rows.length === 0 ? (
            <p className="hint">没有可以对比的结果。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>检查</th>
                  <th>会话</th>
                  <th>基线</th>
                  <th>现在</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {diff.rows.map((r) => (
                  <tr key={`${r.itemId}-${r.cli}`} className={r.kind}>
                    <td>{title(r.itemId)}</td>
                    <td>{CLI[r.cli]}</td>
                    <td>{r.base ? VERDICT[r.base] : "—"}</td>
                    <td>{r.now ? VERDICT[r.now] : "—"}</td>
                    <td>
                      <span className={`regress-kind ${r.kind}`}>{DIFF[r.kind]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ---- settings ----------------------------------------------------------------------------

function Settings({ settings, onView }: { settings: RegressSettings; onView(r: Result<RegressView>): void }) {
  const [draft, setDraft] = useState<Record<keyof RegressSettings, string>>(() =>
    Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])) as Record<keyof RegressSettings, string>,
  );
  const keys = Object.keys(SETTING_RANGE) as (keyof RegressSettings)[];
  const bad = keys.filter((k) => {
    const v = Number(draft[k]);
    const [min, max] = SETTING_RANGE[k];
    return !Number.isInteger(v) || v < min || v > max;
  });
  return (
    <section className="regress-panel">
      <h3>设置</h3>
      <form
        className="regress-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          if (bad.length) return;
          onView(await window.sweet.regressSetSettings(Object.fromEntries(keys.map((k) => [k, Number(draft[k])])) as Partial<RegressSettings>));
        }}
      >
        {keys.map((k) => {
          const [min, max, label] = SETTING_RANGE[k];
          return (
            <label key={k} className={bad.includes(k) ? "bad" : ""}>
              <span>{label}</span>
              <input id={`regress-${k}`} type="number" min={min} max={max} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
              <small>
                {min}–{max}
              </small>
            </label>
          );
        })}
        <div className="regress-row end">
          <button type="submit" className="regress-btn primary" disabled={bad.length > 0}>
            保存
          </button>
        </div>
      </form>
    </section>
  );
}

// ---- full reply --------------------------------------------------------------------------

function ReplyDialog({ run, text, onClose }: { run: RegressRun; text: string | null; onClose(): void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="regress-reply" role="dialog" aria-label={`${run.session} 的完整回复`}>
        <header>
          <b>{run.session} 的完整回复</b>
          <span className="regress-time">
            {CLI[run.cli]} · {STATUS[run.status]}
            {run.status === "done" && ` · ${VERDICT[run.verdict]}`}
          </span>
          <span className="spacer" />
          <button type="button" className="regress-x" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <pre>{text ?? "读取中…"}</pre>
      </div>
    </div>
  );
}
