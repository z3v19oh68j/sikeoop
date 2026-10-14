import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DispatchBudget, DispatchCheck, DispatchExecutorKind, DispatchJob, DispatchJobStatus, DispatchOrigin, DispatchView, DispatchProgress, AgentPermissionCard, ResumePlan } from "@shared/types";
import { Icon } from "./Icon";
import "../styles/dispatch.css";

// The dispatch console (docs/调度核心-收拢方案.md 3.6): every job handed to a terminal CLI,
// a sikeoop session or a model, grouped into trees by rootId and indented by parentId.
// A row opens into its details: full input, result, error, acceptance checks and scope.

const STATUS: Record<DispatchJobStatus, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  waiting_approval: "等你批准",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
  exited: "已中断",
};

const KIND: Record<DispatchExecutorKind, string> = {
  cli: "终端 CLI",
  process: "外部程序",
  session: "sikeoop 会话",
  model: "模型",
  agent: "外部 agent",
};

const ORIGIN: Record<DispatchOrigin, string> = {
  user: "用户",
  chat: "主对话",
  agent: "AI 互发",
  automation: "自动化",
  cluster: "集群",
  wechat: "微信",
  session: "session",
};

const CHECK_KIND: Record<DispatchCheck["kind"], string> = {
  preflight: "派活前检查",
  files: "改动范围",
  owns: "文件归属",
  typecheck: "类型检查",
  claims: "汇报核对",
};

const CHECK_MARK: Record<DispatchCheck["level"], string> = { pass: "✓", warn: "⚠", fail: "✗" };

const LIVE: DispatchJobStatus[] = ["queued", "starting", "running", "waiting_approval"];
const BAD: DispatchJobStatus[] = ["failed", "timeout", "exited"];

type Filter = "all" | "live" | "problem";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "live", label: "进行中" },
  { id: "problem", label: "有问题" },
];

const EMPTY: DispatchView = { jobs: [], budgets: [], running: 0, queued: 0, maxRunning: 4 };
const LONG_TEXT = 600;

const isLive = (j: DispatchJob) => LIVE.includes(j.status);
const hasProblem = (j: DispatchJob) => BAD.includes(j.status) || !!j.checks?.some((c) => c.level === "fail");

function duration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/** Running time once started; while queued, how long it has waited. */
function elapsed(job: DispatchJob, now: number): string {
  if (job.startedAt) return duration((job.endedAt ?? now) - job.startedAt);
  if (job.status === "queued") return `已等 ${duration(now - job.createdAt)}`;
  return "—";
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summary(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

interface Tree {
  rootId: string;
  root?: DispatchJob;
  /** Jobs in display order with their depth. */
  rows: { job: DispatchJob; depth: number }[];
  budget?: DispatchBudget;
}

/** Group by rootId (in the order the view lists them), then walk parentId into an indented list. */
function buildTrees(view: DispatchView): Tree[] {
  const groups = new Map<string, DispatchJob[]>();
  for (const job of view.jobs) {
    const g = groups.get(job.rootId);
    if (g) g.push(job);
    else groups.set(job.rootId, [job]);
  }
  const trees: Tree[] = [];
  for (const [rootId, jobs] of groups) {
    const ids = new Set(jobs.map((j) => j.id));
    const children = new Map<string, DispatchJob[]>();
    const tops: DispatchJob[] = [];
    for (const j of jobs) {
      // A parent that is no longer listed: show the job at the top of its tree.
      if (j.parentId && ids.has(j.parentId)) {
        const c = children.get(j.parentId);
        if (c) c.push(j);
        else children.set(j.parentId, [j]);
      } else tops.push(j);
    }
    const byTime = (a: DispatchJob, b: DispatchJob) => a.createdAt - b.createdAt;
    const rows: Tree["rows"] = [];
    const walk = (j: DispatchJob, depth: number) => {
      rows.push({ job: j, depth });
      for (const c of (children.get(j.id) ?? []).sort(byTime)) walk(c, depth + 1);
    };
    for (const t of tops.sort(byTime)) walk(t, 0);
    trees.push({ rootId, root: jobs.find((j) => j.id === rootId), rows, budget: view.budgets.find((b) => b.rootId === rootId) });
  }
  return trees;
}

interface Props {
  hidden: boolean;
}

export function DispatchConsole({ hidden }: Props) {
  const [view, setView] = useState<DispatchView>(EMPTY);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [cancelError, setCancelError] = useState("");

  useEffect(() => {
    void window.sweet.dispatchView().then(setView);
    const offView = window.sweet.onDispatchChanged(setView);
    // External agents stream progress between view updates: append it to the job it belongs to.
    const offEvent = window.sweet.onDispatchEvent((e) => {
      if (e.type === "progress")
        setView((v) => ({ ...v, jobs: v.jobs.map((j) => (j.id === e.jobId ? { ...j, progress: [...(j.progress ?? []), e.progress].slice(-100) } : j)) }));
      else if (e.type === "job") setView((v) => ({ ...v, jobs: v.jobs.some((j) => j.id === e.job.id) ? v.jobs.map((j) => (j.id === e.job.id ? e.job : j)) : [e.job, ...v.jobs] }));
    });
    return () => {
      offView();
      offEvent();
    };
  }, []);

  const anyLive = view.jobs.some(isLive);
  // Running and queued rows tick once a second; nothing else needs the clock.
  useEffect(() => {
    if (!anyLive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const trees = useMemo(() => buildTrees(view), [view]);
  const match = (j: DispatchJob) => filter === "all" || (filter === "live" ? isLive(j) : hasProblem(j));
  const shown = trees.filter((t) => t.rows.some((r) => match(r.job)));
  const problems = view.jobs.filter(hasProblem).length;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function cancel(job: DispatchJob) {
    const ok = window.confirm(
      `取消派给「${job.executor.name}」的任务？\n\n会连同它派出去的任务一起取消；终端里正在跑的那一轮不会被打断，只是不再等它。`,
    );
    if (!ok) return;
    setCancelError("");
    try {
      await window.sweet.dispatchCancel(job.id);
    } catch (e) {
      setCancelError(`取消没成功：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <main className="group dispatch" hidden={hidden}>
      <div className="section-head dispatch-head">
        <div>
          <strong>调度台</strong>
          <span className="dispatch-counts">
            {" "}运行中 {view.running} / 上限 {view.maxRunning} · 排队 {view.queued}
          </span>
        </div>
        <div className="dispatch-filters" role="tablist" aria-label="筛选任务">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? "on" : undefined}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id === "problem" && problems > 0 && <span className="dispatch-filter-count">{problems}</span>}
            </button>
          ))}
        </div>
      </div>

      <ResumePlans />

      {cancelError && (
        <p className="dispatch-error-banner" role="alert">
          <Icon name="warning" /> {cancelError}
        </p>
      )}

      {view.jobs.length === 0 ? (
        <div className="wiki-empty">
          <p>还没有派过任务。</p>
          <p className="dispatch-hint">主对话、AI 之间互发、自动化和集群派出去的活，都会显示在这里。</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="wiki-empty">
          <p>{filter === "live" ? "现在没有进行中的任务。" : "没有出问题的任务。"}</p>
        </div>
      ) : (
        <div className="dispatch-trees">
          {shown.map((tree) => (
            <section key={tree.rootId} className="dispatch-tree">
              <TreeHead tree={tree} />
              <ul className="dispatch-rows">
                {tree.rows.map(({ job, depth }) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    depth={depth}
                    now={now}
                    dim={!match(job)}
                    open={open.has(job.id)}
                    onToggle={() => toggle(job.id)}
                    onCancel={() => void cancel(job)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function TreeHead({ tree }: { tree: Tree }) {
  const origin = tree.root?.origin ?? tree.rows[0]?.job.origin;
  const b = tree.budget;
  const exhausted = !!b && b.left <= 0;
  return (
    <div className="dispatch-tree-head">
      {origin && <span className={`dispatch-origin ${origin}`}>{ORIGIN[origin]}</span>}
      {tree.root && <span className="dispatch-tree-time">{clock(tree.root.createdAt)} 发起</span>}
      <span className="dispatch-tree-size">{tree.rows.length} 个任务</span>
      {b && (
        <span
          className={`dispatch-budget${exhausted ? " out" : ""}`}
          title="这棵任务树还能再派多少个任务。用完后会停下来等你在对话里发话。"
        >
          {exhausted ? (
            <>
              <Icon name="warning" /> 预算用完（0/{b.total}），等你发话
            </>
          ) : (
            <>
              预算 剩 {b.left}/{b.total}
            </>
          )}
        </span>
      )}
    </div>
  );
}

interface RowProps {
  job: DispatchJob;
  depth: number;
  now: number;
  dim: boolean;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
}

function JobRow({ job, depth, now, dim, open, onToggle, onCancel }: RowProps) {
  const failedChecks = job.checks?.filter((c) => c.level === "fail").length ?? 0;
  return (
    <li className={`dispatch-job ${job.status}${dim ? " dim" : ""}${open ? " open" : ""}`} style={{ marginLeft: depth * 22 }}>
      <div className="dispatch-job-line">
        <button type="button" className="dispatch-job-main" aria-expanded={open} onClick={onToggle}>
          <span className={`dispatch-chevron${open ? " on" : ""}`}>
            <Icon name="chevron-right" />
          </span>
          <span className={`dispatch-status ${job.status}`}>{STATUS[job.status]}</span>
          <span className="dispatch-exec">
            <strong>{job.executor.name}</strong>
            <span className="dispatch-kind">{KIND[job.executor.kind]}</span>
          </span>
          <span className="dispatch-route">
            {job.from} → {job.executor.name}
          </span>
          <span className="dispatch-input">{summary(job.input)}</span>
          {failedChecks > 0 && (
            <span className="dispatch-check-flag" title="有验收没通过">
              ✗ {failedChecks}
            </span>
          )}
          <span className="dispatch-time">{elapsed(job, now)}</span>
        </button>
        {isLive(job) && (
          <button type="button" className="dispatch-cancel" onClick={onCancel} title="取消这个任务和它派出去的任务">
            <Icon name="stop" /> 取消
          </button>
        )}
      </div>
      {job.executor.kind === "agent" && <AgentLive job={job} />}
      {open && <JobDetail job={job} />}
    </li>
  );
}

function JobDetail({ job }: { job: DispatchJob }) {
  return (
    <div className="dispatch-detail">
      <Field label="任务内容">
        <pre className="dispatch-pre">{job.input}</pre>
      </Field>

      {job.error && (
        <Field label="出错原因">
          <pre className="dispatch-pre bad">{job.error}</pre>
        </Field>
      )}

      {job.result && (
        <Field label={job.result.outcome ? `结果 · ${job.result.outcome}` : "结果"}>
          <LongText text={job.result.text} />
        </Field>
      )}

      {job.result?.files && (
        <Field label="实际改动的文件（按本地文件对比，不是 agent 自己说的）">
          <FileList files={job.result.files} />
        </Field>
      )}

      {job.progress && job.progress.length > 0 && (
        <Field label={`进度 · ${job.progress.length} 条`}>
          <AgentProgress items={job.progress} />
        </Field>
      )}

      {job.checks && job.checks.length > 0 && (
        <Field label="检查与验收">
          <ul className="dispatch-checks">
            {job.checks.map((c, i) => (
              <li key={i} className={`dispatch-check ${c.level}`}>
                <div className="dispatch-check-head">
                  <span className="dispatch-check-mark">{CHECK_MARK[c.level]}</span>
                  <span className="dispatch-check-kind">{CHECK_KIND[c.kind]}</span>
                  <span>{c.summary}</span>
                </div>
                {c.details && c.details.length > 0 && (
                  <ul className="dispatch-check-details">
                    {c.details.map((d, k) => (
                      <li key={k}>{d}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Field>
      )}

      <dl className="dispatch-meta">
        {job.scope && (
          <>
            <Meta label="可写目录" values={job.scope.roots} code />
            {job.scope.owns && job.scope.owns.length > 0 && <Meta label="负责的文件" values={job.scope.owns} code />}
          </>
        )}
        {job.needs && (
          <Meta
            label="运行需要"
            values={[
              ...(job.needs.network ? ["联网"] : []),
              ...(job.needs.deps ?? []).map((d) => `${d} 已装依赖`),
            ]}
          />
        )}
        {job.verify?.typecheck && <Meta label="结束后检查" values={[job.verify.typecheck]} code />}
        <Meta label="时间限制" values={[duration(job.limits.timeoutMs)]} />
        <Meta
          label="时间"
          values={[
            `创建 ${clock(job.createdAt)}`,
            ...(job.startedAt ? [`开始 ${clock(job.startedAt)}`] : []),
            ...(job.endedAt ? [`结束 ${clock(job.endedAt)}`] : []),
          ]}
        />
        <Meta label="任务编号" values={[job.id]} code />
      </dl>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dispatch-field">
      <div className="dispatch-field-label">{label}</div>
      {children}
    </div>
  );
}

function Meta({ label, values, code }: { label: string; values: string[]; code?: boolean }) {
  if (values.length === 0) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {values.map((v, i) => (
          <Fragment key={i}>{code ? <code>{v}</code> : <span>{v}</span>}</Fragment>
        ))}
      </dd>
    </>
  );
}

/** Long results start folded so one report doesn't push every other job off the screen. */
function LongText({ text }: { text: string }) {
  const long = text.length > LONG_TEXT || text.split("\n").length > 12;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="dispatch-long">
      <pre className={`dispatch-pre${long && !expanded ? " folded" : ""}`}>{text}</pre>
      {long && (
        <button type="button" className="dispatch-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}

// ---- 等待继续: plans to send 「继续」 after a usage limit resets (main/quota) ----------------------

const RESUME_SOURCE: Record<ResumePlan["source"], string> = {
  reset_time: "从提示里读到的重置时间",
  retry_after: "接口给的重试时间",
  default: "没读到时间，按默认等待",
};

function countdown(ms: number): string {
  if (ms <= 0) return "马上";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m} 分钟后`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分钟后` : `${h} 小时后`;
}

const resumeClock = (ts: number) => {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

const targetName = (p: ResumePlan) => (p.target.kind === "cli" ? `终端 · ${p.target.name}` : `对话 · ${p.target.title}`);

/** Shown only when there are plans: waiting ones on top, finished ones folded into 「最近」. */
function ResumePlans() {
  const [plans, setPlans] = useState<ResumePlan[]>([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void window.sweet.resumePlans().then(setPlans);
    return window.sweet.onResumePlans(setPlans);
  }, []);
  const waiting = plans.filter((p) => p.status === "waiting").sort((a, b) => a.resumeAt - b.resumeAt);
  const recent = plans.filter((p) => p.status !== "waiting").sort((a, b) => b.resumeAt - a.resumeAt);
  useEffect(() => {
    if (!waiting.length) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [waiting.length]);

  if (!plans.length) return null;

  async function act(id: string, fn: (id: string) => Promise<ResumePlan[]>) {
    setError("");
    setBusy(id);
    try {
      setPlans(await fn(id));
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="resume-plans" aria-label="等待继续">
      <div className="resume-head">
        <Icon name="clock" />
        <strong>等待继续</strong>
        <span className="dispatch-counts">{waiting.length ? `${waiting.length} 个会话在等额度恢复` : "现在没有在等的"}</span>
      </div>
      {waiting.length > 0 && (
        <ul className="resume-list">
          {waiting.map((p) => (
            <li key={p.id} className="resume-item">
              <div className="resume-main">
                <div className="resume-title">
                  <b>{targetName(p)}</b>
                  <span className="resume-reason">{p.reason}</span>
                </div>
                <div className="resume-when">
                  <span className="resume-countdown">{countdown(p.resumeAt - now)}</span>
                  <span>
                    {resumeClock(p.resumeAt)} 发送「{p.message}」
                  </span>
                  <span className={"resume-source " + p.source}>{RESUME_SOURCE[p.source]}</span>
                </div>
              </div>
              <div className="resume-actions">
                <button type="button" className="mini-btn" disabled={busy === p.id} onClick={() => void act(p.id, window.sweet.resumeNow)}>
                  <Icon name="play" /> 现在继续
                </button>
                <button type="button" className="mini-btn" disabled={busy === p.id} onClick={() => void act(p.id, window.sweet.cancelResumePlan)}>
                  取消
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <details className="resume-recent">
          <summary>最近 {recent.length} 条</summary>
          <ul>
            {recent.map((p) => (
              <li key={p.id}>
                <span className={"resume-status " + p.status}>{p.status === "done" ? "继续了" : p.status === "skipped" ? "跳过" : "已取消"}</span>
                <span className="resume-recent-target">{targetName(p)}</span>
                <span className="resume-recent-note">{p.note || p.reason}</span>
                <time>{resumeClock(p.resumeAt)}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="dispatch-error-banner" role="alert">{error}</p>}
    </section>
  );
}

// ---- 外部 agent (ACP): live line, permission card, progress list ---------------------------------
// Everything an external agent says is shown as plain text, never acted on.

const lastPermission = (job: DispatchJob): AgentPermissionCard | undefined =>
  [...(job.progress ?? [])].reverse().find((p) => p.type === "permission" && p.permission)?.permission;

function AgentLive({ job }: { job: DispatchJob }) {
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState("");
  const card = job.status === "waiting_approval" ? lastPermission(job) : undefined;
  const latest = [...(job.progress ?? [])].reverse().find((p) => p.type !== "permission");
  if (card && answered !== card.id) {
    const answer = (optionId: string | null) => {
      setError("");
      setAnswered(card.id);
      window.sweet.dispatchAgentPermission(card.id, optionId).catch((e: Error) => {
        setAnswered(null);
        setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      });
    };
    const tool = card.toolCall as { title?: unknown; kind?: unknown };
    return (
      <div className="agent-perm" role="alertdialog" aria-label={`${job.executor.name} 请求权限`}>
        <div className="agent-perm-head">
          <Icon name="shield-check" />
          <b>{job.executor.name} 想要：</b>
          <span className="agent-perm-title">{card.title || (typeof tool.title === "string" ? tool.title : "执行一个操作")}</span>
        </div>
        {typeof tool.kind === "string" && <p className="agent-perm-meta">操作类型：{tool.kind}</p>}
        <p className="agent-perm-meta">这些选项是外部 agent 给的，原样列出。看不懂就拒绝。</p>
        <div className="agent-perm-opts">
          {card.options.map((o) => (
            <button key={o.optionId} type="button" className={"agent-opt " + (/reject|deny/i.test(o.kind) ? "no" : /allow/i.test(o.kind) ? "yes" : "")} onClick={() => answer(o.optionId)} title={o.kind}>
              {o.name}
            </button>
          ))}
          <button type="button" className="agent-opt plain" onClick={() => answer(null)}>
            都不选（拒绝）
          </button>
        </div>
        {error && <p className="dispatch-error-banner">{error}</p>}
      </div>
    );
  }
  if (!isLive(job) || !latest) return null;
  return (
    <div className="agent-live" aria-live="polite">
      <span className="agent-live-dot" aria-hidden="true" />
      <span className="agent-live-text">{progressLine(latest)}</span>
    </div>
  );
}

function progressLine(p: DispatchProgress): string {
  if (p.type === "tool") return `工具：${p.title ?? p.toolCallId ?? "（未命名）"}${p.status ? ` · ${p.status}` : ""}`;
  if (p.type === "status") return `状态：${p.text ?? p.status ?? ""}`;
  if (p.type === "permission") return `请求权限：${p.permission?.title ?? ""}`;
  if (p.type === "file") return `文件：${p.text ?? ""}`;
  return p.text ?? "";
}

function AgentProgress({ items }: { items: DispatchProgress[] }) {
  // Consecutive text chunks read as one paragraph.
  const rows: DispatchProgress[] = [];
  for (const p of items) {
    const prev = rows[rows.length - 1];
    // A message for the main conversation (status "host-message", main/peer-host.ts) stands on its own.
    if (p.type === "text" && prev?.type === "text" && !p.status && !prev.status) rows[rows.length - 1] = { ...prev, text: (prev.text ?? "") + (p.text ?? "") };
    else rows.push(p);
  }
  return (
    <ol className="agent-progress">
      {rows.map((p, i) => (
        <li key={i} className={"agent-p " + p.type}>
          <time>{clock(p.at)}</time>
          {p.type === "text" ? (
            <pre className="agent-text">
              {p.status === "host-message" && <b>{p.title ?? "它"} → 主对话：</b>}
              {p.text}
            </pre>
          ) : (
            <span>{progressLine(p)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function FileList({ files }: { files: NonNullable<NonNullable<DispatchJob["result"]>["files"]> }) {
  const groups: [string, string[]][] = [
    ["改了", files.changed],
    ["新建", files.created],
    ["删除", files.deleted],
  ];
  if (groups.every(([, l]) => !l.length)) return <p className="dispatch-hint">没有文件变化。</p>;
  return (
    <div className="agent-files">
      {groups.filter(([, l]) => l.length).map(([k, l]) => (
        <div key={k}>
          <span className="agent-files-k">{k} {l.length}</span>
          <code>{l.join("\n")}</code>
        </div>
      ))}
    </div>
  );
}
