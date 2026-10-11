import { useEffect, useState } from "react";
import {
  AUTOMATION_END,
  AUTOMATION_FAIL,
  AUTOMATION_OK,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationState,
  type AutomationView,
  type Effort,
} from "@shared/types";
import { Icon } from "./Icon";
import { FlowStepConfig, flowStepSummary } from "./BrowserFlows";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

interface Props {
  hidden: boolean;
  hasProject: boolean;
  /** Show a run's conversation in the chat. */
  onOpenSession(id: string): void;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "每天 09:00", "每 2 小时"…: the schedule in words. */
export function describeSchedule(s: AutomationSchedule): string {
  switch (s.kind) {
    case "manual":
      return "只手动运行";
    case "interval":
      return s.minutes % 60 === 0 ? `每 ${s.minutes / 60} 小时` : `每 ${s.minutes} 分钟`;
    case "daily": {
      const days = [...s.days].sort();
      const which =
        !days.length || days.length === 7 ? "每天" : days.join() === "1,2,3,4,5" ? "工作日" : `每周${days.map((d) => WEEKDAYS[d]).join("、")}`;
      return `${which} ${s.time}`;
    }
    case "once":
      return `${when(s.at)} 运行一次`;
  }
}

function when(t: number): string {
  return new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function outcomeLabel(o: string): string {
  return o === AUTOMATION_OK ? "成功" : o === AUTOMATION_FAIL ? "失败" : o;
}

const RUN_STATUS: Record<AutomationRun["status"], string> = {
  running: "运行中",
  ok: "完成",
  failed: "没成功",
  cancelled: "停下了",
  missed: "错过了",
};

/** Ready-made machines to start from: a beginner rarely draws one from nothing. */
const TEMPLATES: { title: string; detail: string; make(): AutomationInput }[] = [
  {
    title: "每天跑测试，失败了让 AI 修",
    detail: "命令步骤跑测试 → 失败时交给 AI 修 → 再跑一次确认",
    make: () => {
      const [test, fix, again] = [newId(), newId(), newId()];
      return {
        name: "每日测试",
        enabled: false,
        schedule: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] },
        start: test,
        effort: "medium",
        states: [
          { id: test, name: "跑测试", kind: "command", text: "npm test", next: [{ on: AUTOMATION_FAIL, to: fix }] },
          {
            id: fix,
            name: "让 AI 修",
            kind: "agent",
            text: "上一步的测试失败了。找到失败的原因并修好，不要为了让测试通过去改测试本身的预期。",
            next: [{ on: AUTOMATION_OK, to: again }],
          },
          { id: again, name: "再跑一次", kind: "command", text: "npm test", next: [] },
        ],
      };
    },
  },
  {
    title: "每日代码巡检",
    detail: "AI 看最近的改动，有问题就写进报告",
    make: () => {
      const [check, report] = [newId(), newId()];
      return {
        name: "每日巡检",
        enabled: false,
        schedule: { kind: "daily", time: "18:00", days: [] },
        start: check,
        effort: "medium",
        states: [
          {
            id: check,
            name: "检查最近的改动",
            kind: "agent",
            text: "用 git log 和 git diff 看看今天的改动，检查有没有明显的 bug、遗漏的错误处理或者忘了删的调试代码。只看不改。",
            next: [{ on: "有问题", to: report }],
          },
          {
            id: report,
            name: "写报告",
            kind: "agent",
            text: "把上一步发现的问题按严重程度写进 docs/daily-report.md（没有就新建），每条写清楚文件、位置和建议怎么改。",
            next: [],
          },
        ],
      };
    },
  },
];

function blank(): AutomationInput {
  const id = newId();
  return {
    name: "",
    enabled: false,
    schedule: { kind: "daily", time: "09:00", days: [] },
    start: id,
    effort: "medium",
    states: [{ id, name: "第一步", kind: "agent", text: "", next: [] }],
  };
}

/** Automations: steps the AI (or a command) does on a schedule, going on by each step's outcome. */
export function AutomationScreen({ hidden, hasProject, onOpenSession }: Props) {
  const [view, setView] = useState<AutomationView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The automation being edited (new ones have no id). */
  const [draft, setDraft] = useState<AutomationInput | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => window.sweet.onAutomations(setView), []);
  useEffect(() => {
    if (!hidden) void window.sweet.automations().then(setView, (e) => setError(cleanError(e)));
  }, [hidden, hasProject]);

  const act = async (p: Promise<AutomationView | void>) => {
    setError("");
    try {
      const v = await p;
      if (v) setView(v);
    } catch (e) {
      setError(cleanError(e));
    }
  };

  if (!hasProject) {
    return (
      <main className="group automation" hidden={hidden}>
        <div className="wiki-empty">
          <Icon name="clock" />
          <h2>自动化任务</h2>
          <p>自动化任务是跟着项目走的。先打开一个项目，再给它设定时任务。</p>
        </div>
      </main>
    );
  }

  const list = view?.automations ?? [];
  const current = list.find((a) => a.id === selected) ?? null;
  const startNew = () => {
    setSelected(null);
    setDraft(null);
    setPicking(true);
  };

  return (
    <main className="group automation" hidden={hidden}>
      <aside className="group-list">
        <div className="section-head">
          自动化
          <span className="spacer" />
          <button type="button" className="icon-btn square" title="新建自动化任务" aria-label="新建自动化任务" onClick={startNew}>
            <Icon name="plus" />
          </button>
        </div>
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className={"group-item auto-item" + (current?.id === a.id && !draft && !picking ? " on" : "")}
            onClick={() => {
              setDraft(null);
              setPicking(false);
              setSelected(a.id);
            }}
          >
            <span className={"auto-dot" + (view?.runningId === a.id ? " running" : a.enabled ? " on" : "")} />
            <span className="t">{a.name}</span>
            <span className="n">{view?.runningId === a.id ? "运行中" : a.enabled && a.nextRunAt ? when(a.nextRunAt) : a.enabled ? "" : "已关"}</span>
          </button>
        ))}
        {!list.length && <p className="hint">还没有自动化任务，点右上角新建一个。</p>}
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
        {picking ? (
          <TemplatePicker
            onPick={(input) => {
              setPicking(false);
              setDraft(input);
            }}
          />
        ) : draft ? (
          <Editor
            key={draft.id ?? "new"}
            initial={draft}
            onCancel={() => setDraft(null)}
            onSave={async (input) => {
              setError("");
              try {
                const v = await window.sweet.saveAutomation(input);
                setView(v);
                setDraft(null);
                // A new one is the newest; an edited one keeps its place.
                setSelected(input.id ?? v.automations[v.automations.length - 1]?.id ?? null);
              } catch (e) {
                setError(cleanError(e));
              }
            }}
          />
        ) : current ? (
          <Detail
            a={current}
            runs={(view?.runs ?? []).filter((r) => r.automationId === current.id)}
            running={view?.runningId === current.id}
            busy={!!view?.runningId}
            onToggle={(on) => void act(window.sweet.setAutomationEnabled(current.id, on))}
            onRun={() => void act(window.sweet.runAutomation(current.id))}
            onStop={() => void act(window.sweet.stopAutomation())}
            onEdit={() => setDraft(structuredClone(current))}
            onDelete={() => {
              if (!window.confirm(`删除自动化任务「${current.name}」？`)) return;
              setSelected(null);
              void act(window.sweet.deleteAutomation(current.id));
            }}
            onOpenSession={onOpenSession}
          />
        ) : (
          <div className="wiki-empty">
            <Icon name="clock" />
            <h2>自动化任务</h2>
            <p>
              把一件事拆成几个步骤，每一步交给 AI 或者运行一条命令，按结果决定下一步去哪，再定好什么时候自动运行。
              <br />
              运行时 AI 用懒人模式自己做完（推送、发布和危险命令会被拦下），只在这个项目打开时运行。
            </p>
            <button type="button" className="neu-btn primary" onClick={startNew}>
              <Icon name="plus" /> 新建自动化任务
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function TemplatePicker({ onPick }: { onPick(input: AutomationInput): void }) {
  return (
    <div className="auto-scroll">
      <h2 className="auto-h">从哪里开始？</h2>
      <div className="auto-templates">
        {TEMPLATES.map((t) => (
          <button key={t.title} type="button" className="auto-template" onClick={() => onPick(t.make())}>
            <b>{t.title}</b>
            <span>{t.detail}</span>
          </button>
        ))}
        <button type="button" className="auto-template" onClick={() => onPick(blank())}>
          <b>空白</b>
          <span>从一个 AI 步骤开始自己搭</span>
        </button>
      </div>
    </div>
  );
}

function Detail({
  a,
  runs,
  running,
  busy,
  onToggle,
  onRun,
  onStop,
  onEdit,
  onDelete,
  onOpenSession,
}: {
  a: Automation;
  runs: AutomationRun[];
  running: boolean;
  busy: boolean;
  onToggle(on: boolean): void;
  onRun(): void;
  onStop(): void;
  onEdit(): void;
  onDelete(): void;
  onOpenSession(id: string): void;
}) {
  const names = new Map(a.states.map((s) => [s.id, s.name]));
  const target = (to: string) => (to === AUTOMATION_END ? "结束" : (names.get(to) ?? "（已删除的步骤）"));
  const ordered = [...a.states].sort((x, y) => Number(y.id === a.start) - Number(x.id === a.start));
  return (
    <div className="group-chat">
      <div className="studio-bar">
        <Icon name="clock" />
        <span className="studio-title">{a.name}</span>
        <span className="hint">
          {describeSchedule(a.schedule)}
          {a.enabled && a.nextRunAt ? ` · 下次 ${when(a.nextRunAt)}` : ""}
        </span>
        <span className="spacer" />
        {a.schedule.kind !== "manual" && (
          <label className="toggle" title="关掉以后不会按时间表运行，手动运行不受影响">
            <input type="checkbox" checked={a.enabled} onChange={(e) => onToggle(e.target.checked)} /> 按时间表运行
          </label>
        )}
        {running ? (
          <button type="button" className="mini-btn" onClick={onStop}>
            <Icon name="stop" /> 停下
          </button>
        ) : (
          <button type="button" className="mini-btn" disabled={busy} onClick={onRun} title={busy ? "另一个自动化任务正在运行" : "不等时间表，现在就运行一次"}>
            <Icon name="play" /> 立即运行
          </button>
        )}
        <button type="button" className="mini-btn" disabled={running} onClick={onEdit}>
          编辑
        </button>
        <button type="button" className="icon-btn square" title="删除" aria-label="删除" onClick={onDelete}>
          <Icon name="trash" />
        </button>
      </div>

      <div className="auto-scroll">
        <h3 className="auto-h">步骤</h3>
        <ol className="auto-flow">
          {ordered.map((s) => (
            <li key={s.id} className="auto-state">
              <div className="auto-state-head">
                <Icon name={s.kind === "command" ? "terminal" : s.kind === "browser_flow" ? "globe" : "sparkle"} />
                <b>{s.name}</b>
                {s.id === a.start && <span className="auto-tag">起点</span>}
              </div>
              <p className={s.kind === "command" ? "auto-text code" : "auto-text"}>{s.kind === "browser_flow" ? flowStepSummary(s.text) : s.text}</p>
              <div className="auto-edges">
                {[AUTOMATION_OK, AUTOMATION_FAIL, ...s.next.map((t) => t.on).filter((o) => o !== AUTOMATION_OK && o !== AUTOMATION_FAIL)].map((o) => (
                  <span key={o} className={"auto-edge" + (o === AUTOMATION_FAIL ? " fail" : "")}>
                    {outcomeLabel(o)} → {target(s.next.find((t) => t.on === o)?.to ?? AUTOMATION_END)}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>

        <h3 className="auto-h">最近运行</h3>
        {!runs.length && <p className="hint">还没有运行过。</p>}
        <ul className="auto-runs">
          {runs.map((r) => (
            <li key={r.id} className={`auto-run ${r.status}`}>
              <div className="auto-run-head">
                <span className="auto-status">{RUN_STATUS[r.status]}</span>
                <span>{when(r.startedAt)}</span>
                <span className="hint">{r.trigger === "manual" ? "手动" : "定时"}</span>
                <span className="spacer" />
                {r.sessionId && r.status !== "running" && (
                  <button type="button" className="mini-btn" onClick={() => onOpenSession(r.sessionId!)}>
                    在对话里查看
                  </button>
                )}
              </div>
              {r.note && <p className="hint">{r.note}</p>}
              {r.steps.map((s, i) => (
                <details key={i} className="auto-step">
                  <summary>
                    <span className="auto-step-n">{i + 1}</span> {s.name}
                    {s.outcome ? <span className={"auto-edge" + (s.outcome === AUTOMATION_FAIL ? " fail" : "")}>{outcomeLabel(s.outcome)}</span> : <span className="hint">{s.activity ?? "…"}</span>}
                  </summary>
                  {s.summary && <pre className="auto-summary">{s.summary}</pre>}
                </details>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Editor({ initial, onCancel, onSave }: { initial: AutomationInput; onCancel(): void; onSave(a: AutomationInput): Promise<void> }) {
  const [a, setA] = useState<AutomationInput>(initial);
  const [saving, setSaving] = useState(false);
  const set = (change: Partial<AutomationInput>) => setA((x) => ({ ...x, ...change }));
  const setState = (id: string, change: Partial<AutomationState>) =>
    setA((x) => ({ ...x, states: x.states.map((s) => (s.id === id ? { ...s, ...change } : s)) }));

  const addState = () => {
    const id = newId();
    setA((x) => {
      // The step that used to end on success now leads to the new one.
      const last = x.states[x.states.length - 1];
      const states = x.states.map((s) =>
        s === last && !s.next.some((t) => t.on === AUTOMATION_OK && t.to !== AUTOMATION_END)
          ? { ...s, next: [...s.next.filter((t) => t.on !== AUTOMATION_OK), { on: AUTOMATION_OK, to: id }] }
          : s,
      );
      return { ...x, states: [...states, { id, name: `第 ${x.states.length + 1} 步`, kind: "agent", text: "", next: [] }] };
    });
  };
  const removeState = (id: string) =>
    setA((x) => {
      const states = x.states
        .filter((s) => s.id !== id)
        .map((s) => ({ ...s, next: s.next.map((t) => (t.to === id ? { ...t, to: AUTOMATION_END } : t)) }));
      return { ...x, states, start: x.start === id ? (states[0]?.id ?? "") : x.start };
    });

  const s = a.schedule;
  return (
    <form
      className="group-chat auto-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void onSave(a).finally(() => setSaving(false));
      }}
    >
      <div className="studio-bar">
        <Icon name="clock" />
        <span className="studio-title">{initial.id ? "编辑自动化任务" : "新建自动化任务"}</span>
        <span className="spacer" />
        <button type="button" className="mini-btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="mini-btn primary" disabled={saving}>
          保存
        </button>
      </div>

      <div className="auto-scroll">
        <div className="auto-row">
          <label className="auto-field grow">
            <span>名字</span>
            <input value={a.name} maxLength={40} placeholder="比如：每日测试" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="auto-field">
            <span>思考深度</span>
            <select value={a.effort} onChange={(e) => set({ effort: e.target.value as Effort })}>
              <option value="low">浅</option>
              <option value="medium">中</option>
              <option value="high">深</option>
            </select>
          </label>
        </div>

        <h3 className="auto-h">什么时候运行</h3>
        <div className="auto-row">
          <label className="auto-field">
            <span>方式</span>
            <select
              value={s.kind}
              onChange={(e) => {
                const kind = e.target.value as AutomationSchedule["kind"];
                const schedule: AutomationSchedule =
                  kind === "interval"
                    ? { kind, minutes: 60 }
                    : kind === "daily"
                      ? { kind, time: "09:00", days: [] }
                      : kind === "once"
                        ? { kind, at: Date.now() + 3600_000 }
                        : { kind };
                set({ schedule, enabled: kind !== "manual" });
              }}
            >
              <option value="daily">每天 / 每周几</option>
              <option value="interval">每隔一段时间</option>
              <option value="once">只在某个时间运行一次</option>
              <option value="manual">不定时，只手动运行</option>
            </select>
          </label>
          {s.kind === "interval" && (
            <label className="auto-field">
              <span>间隔（分钟，至少 5）</span>
              <input type="number" min={5} value={s.minutes} onChange={(e) => set({ schedule: { kind: "interval", minutes: Number(e.target.value) } })} />
            </label>
          )}
          {s.kind === "daily" && (
            <>
              <label className="auto-field">
                <span>时间</span>
                <input type="time" value={s.time} onChange={(e) => set({ schedule: { ...s, time: e.target.value } })} />
              </label>
              <div className="auto-field">
                <span>星期（都不选 = 每天）</span>
                <div className="auto-days">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={"auto-day" + (s.days.includes(d) ? " on" : "")}
                      onClick={() => set({ schedule: { ...s, days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] } })}
                    >
                      {WEEKDAYS[d]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {s.kind === "once" && (
            <label className="auto-field">
              <span>时间</span>
              <input type="datetime-local" value={localInput(s.at)} onChange={(e) => set({ schedule: { kind: "once", at: new Date(e.target.value).getTime() } })} />
            </label>
          )}
        </div>
        {s.kind !== "manual" && (
          <label className="toggle">
            <input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 保存后就按时间表运行
          </label>
        )}

        <h3 className="auto-h">步骤</h3>
        <p className="hint">每一步结束时有一个结果：「成功」「失败」，AI 步骤还可以加自己的结果（比如「有问题」）。每个结果指向下一步；没指定的结果就结束这次运行。</p>
        <ol className="auto-flow">
          {a.states.map((st, i) => (
            <StateEditor
              key={st.id}
              state={st}
              index={i}
              all={a.states}
              isStart={a.start === st.id}
              onChange={(c) => setState(st.id, c)}
              onStart={() => set({ start: st.id })}
              onRemove={a.states.length > 1 ? () => removeState(st.id) : undefined}
            />
          ))}
        </ol>
        <button type="button" className="neu-btn" onClick={addState} disabled={a.states.length >= 20}>
          <Icon name="plus" /> 加一步
        </button>
      </div>
    </form>
  );
}

function StateEditor({
  state: st,
  index,
  all,
  isStart,
  onChange,
  onStart,
  onRemove,
}: {
  state: AutomationState;
  index: number;
  all: AutomationState[];
  isStart: boolean;
  onChange(c: Partial<AutomationState>): void;
  onStart(): void;
  onRemove?: () => void;
}) {
  const custom = st.next.filter((t) => t.on !== AUTOMATION_OK && t.on !== AUTOMATION_FAIL);
  const targetOf = (on: string) => st.next.find((t) => t.on === on)?.to ?? AUTOMATION_END;
  const setTarget = (on: string, to: string) => onChange({ next: [...st.next.filter((t) => t.on !== on), { on, to }] });
  const targets = (
    <>
      {all.map((x) => (
        <option key={x.id} value={x.id}>
          {x.id === st.id ? `${x.name}（再来一次）` : x.name}
        </option>
      ))}
      <option value={AUTOMATION_END}>结束</option>
    </>
  );
  const edge = (on: string, label: string) => (
    <div className="auto-edge-row" key={on}>
      <span className={"auto-edge" + (on === AUTOMATION_FAIL ? " fail" : "")}>{label}</span>→
      <select value={targetOf(on)} onChange={(e) => setTarget(on, e.target.value)}>
        {targets}
      </select>
    </div>
  );

  return (
    <li className="auto-state editing">
      <div className="auto-state-head">
        <span className="auto-step-n">{index + 1}</span>
        <input className="auto-name" value={st.name} maxLength={40} onChange={(e) => onChange({ name: e.target.value })} />
        <select
          value={st.kind}
          onChange={(e) => {
            const kind = e.target.value as AutomationState["kind"];
            // Commands and browser scripts only end in success or failure; a script's text is its JSON config.
            onChange({
              kind,
              text: kind === "browser_flow" ? (st.kind === "browser_flow" ? st.text : JSON.stringify({ name: "" })) : st.kind === "browser_flow" ? "" : st.text,
              next: kind === "agent" ? st.next : st.next.filter((t) => t.on === AUTOMATION_OK || t.on === AUTOMATION_FAIL),
            });
          }}
        >
          <option value="agent">交给 AI</option>
          <option value="command">运行命令</option>
          <option value="browser_flow">运行浏览器脚本</option>
        </select>
        {isStart ? (
          <span className="auto-tag">起点</span>
        ) : (
          <button type="button" className="mini-btn" onClick={onStart}>
            设为起点
          </button>
        )}
        <span className="spacer" />
        {onRemove && (
          <button type="button" className="icon-btn square" title="删除这一步" aria-label="删除这一步" onClick={onRemove}>
            <Icon name="trash" />
          </button>
        )}
      </div>
      {st.kind === "browser_flow" ? (
        <FlowStepConfig text={st.text} onChange={(text) => onChange({ text })} />
      ) : (
      <textarea
        className={st.kind === "command" ? "code" : undefined}
        rows={st.kind === "command" ? 2 : 4}
        value={st.text}
        placeholder={st.kind === "command" ? "bash 命令，比如：npm test（成功 = 退出码 0）" : "要 AI 做什么，像在对话里跟它说一样"}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      )}
      <div className="auto-edges">
        {edge(AUTOMATION_OK, "成功")}
        {edge(AUTOMATION_FAIL, "失败")}
        {custom.map((t, i) => (
          <div className="auto-edge-row" key={i}>
            <input
              className="auto-outcome"
              value={t.on}
              maxLength={30}
              placeholder="结果名"
              onChange={(e) => onChange({ next: st.next.map((x) => (x === t ? { ...x, on: e.target.value } : x)) })}
            />
            →
            <select value={t.to} onChange={(e) => onChange({ next: st.next.map((x) => (x === t ? { ...x, to: e.target.value } : x)) })}>
              {targets}
            </select>
            <button type="button" className="icon-btn square" aria-label="删掉这个结果" onClick={() => onChange({ next: st.next.filter((x) => x !== t) })}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        {st.kind === "agent" && custom.length < 8 && (
          <button
            type="button"
            className="mini-btn"
            onClick={() => onChange({ next: [...st.next, { on: `结果${custom.length + 1}`, to: AUTOMATION_END }] })}
          >
            <Icon name="plus" /> 加一个结果
          </button>
        )}
      </div>
    </li>
  );
}

/** A timestamp as the value of <input type="datetime-local"> (local time, to the minute). */
function localInput(t: number): string {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
