import { useEffect, useState, type ReactNode } from "react";
import type { ResidentAccount, ResidentRound, ResidentSettings, ResidentView } from "@shared/types";
import { Icon } from "./Icon";
import { StatusBadge, Switch, cleanError, type Tone } from "./settings/ui";
import "../styles/settings.css";
import "../styles/resident.css";

interface Props {
  hidden: boolean;
}

const ACCOUNTS: ResidentAccount[] = ["claude", "codex"];
const ACCOUNT_NAME: Record<ResidentAccount, string> = { claude: "Claude 订阅", codex: "ChatGPT (Codex) 订阅" };

const ROUND_STATUS: Record<ResidentRound["status"], { label: string; tone: Tone }> = {
  running: { label: "进行中", tone: "accent" },
  ok: { label: "完成", tone: "ok" },
  failed: { label: "失败", tone: "bad" },
  quota: { label: "额度用完", tone: "warn" },
  stopped: { label: "已停止", tone: "muted" },
};

const TARGETS: { key: keyof ResidentSettings["targets"]; title: string; desc: string }[] = [
  { key: "knowledge", title: "知识与技能", desc: "把学到的东西写成记忆和技能，以后的对话都能用上。" },
  { key: "project", title: "当前项目", desc: "在你打开的项目里动手试。只在独立分支上改，留给你审，不合并不推送。" },
  { key: "self", title: "sikeoop 自身源码", desc: "改进 sikeoop 自己。只在独立分支上改，留给你审，不合并不推送。" },
];

const MAX_TOPICS = 50;
const MAX_DAILY = 999;

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "14:30" today, "10月13日 14:30" on another day. */
function clock(t: number, now: number): string {
  const d = new Date(t);
  return sameDay(t, now)
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "42 秒", "8 分 05 秒", "3 小时 12 分", "2 天 4 小时". */
function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** "2:13:07" until a moment. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Super-resident mode: an endless learn-and-iterate loop on the subscription accounts. */
export function ResidentScreen({ hidden }: Props) {
  const [view, setView] = useState<ResidentView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [topic, setTopic] = useState("");
  const [daily, setDaily] = useState("0");
  const [hours, setHours] = useState("5");

  useEffect(() => {
    let alive = true;
    window.sweet
      .residentView()
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(cleanError(e)));
    const off = window.sweet.onResident((v) => setView(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // The typed numbers follow what is saved, whoever saved it.
  const savedDaily = view?.settings.dailyRounds;
  const savedHours = view?.settings.defaultDelayHours;
  useEffect(() => {
    if (savedDaily !== undefined) setDaily(String(savedDaily));
  }, [savedDaily]);
  useEffect(() => {
    if (savedHours !== undefined) setHours(String(savedHours));
  }, [savedHours]);

  // One clock for the countdown and every duration; it stands still while nothing on screen moves.
  const ticking = !hidden && !!view && (view.on || view.phase !== "off" || !!view.current);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  async function act(call: () => Promise<ResidentView>) {
    setError("");
    setBusy(true);
    try {
      setView(await call());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(patch: Partial<ResidentSettings>) {
    if (!view) return;
    setError("");
    try {
      setView(await window.sweet.setResidentSettings({ ...view.settings, ...patch }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const bar = (
    <div className="studio-bar">
      <Icon name="refresh" />
      <span className="studio-title">超级常驻</span>
      <span className="hint">用已登录的订阅账号，一轮接一轮地联网学习、沉淀记忆和技能、迭代代码</span>
      <span className="spacer" />
      {saved && <span className="ok-text">已保存</span>}
    </div>
  );
  const alert = error && (
    <div className="studio-error" role="alert">
      {error}
      <button type="button" className="icon-btn square" aria-label="关闭" onClick={() => setError("")}>
        <Icon name="close" />
      </button>
    </div>
  );

  if (!view) {
    return (
      <main className="group resident" hidden={hidden}>
        <section className="group-main">
          {bar}
          {alert}
          <div className="auto-scroll">{!error && <p className="hint">正在读取…</p>}</div>
        </section>
      </main>
    );
  }

  const s = view.settings;
  const accountState = (id: ResidentAccount) => view.accounts.find((a) => a.id === id);
  // Taking part first, in the order they are tried; the ones left out after them.
  const accountRows = [...s.accounts.filter((a) => ACCOUNTS.includes(a)), ...ACCOUNTS.filter((a) => !s.accounts.includes(a))];

  const moveAccount = (i: number, by: number) => {
    const next = [...s.accounts];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void save({ accounts: next });
  };
  const moveTopic = (i: number, by: number) => {
    const next = [...s.topics];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void save({ topics: next });
  };
  const addTopic = () => {
    const t = topic.trim();
    if (!t) return;
    setTopic("");
    if (!s.topics.includes(t)) void save({ topics: [...s.topics, t] });
  };

  const d = Number(daily);
  const h = Number(hours);
  const dailyOk = daily.trim() !== "" && Number.isInteger(d) && d >= 0 && d <= MAX_DAILY;
  const hoursOk = hours.trim() !== "" && Number.isInteger(h) && h >= 1 && h <= 24;
  const dirty = (dailyOk && d !== s.dailyRounds) || (hoursOk && h !== s.defaultDelayHours);

  let headline: ReactNode;
  let action: ReactNode = null;
  switch (view.phase) {
    case "off":
      headline = "未开启";
      break;
    case "running":
      headline = view.current ? (
        <>
          正在学习「{view.current.topic || "自己选的主题"}」，用的是 {ACCOUNT_NAME[view.current.account]}，已进行 {span(now - view.current.startedAt)}
        </>
      ) : (
        "正在开始新的一轮…"
      );
      break;
    case "cooldown":
      headline = "马上开始下一轮";
      break;
    case "waiting_quota":
      headline = view.resumeAt ? (
        <>
          额度都用完了，{clock(view.resumeAt, now)} 自动继续
          <span className="rs-countdown">还有 {countdown(view.resumeAt - now)}</span>
        </>
      ) : (
        "额度都用完了，等额度恢复后自动继续"
      );
      action = (
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void act(() => window.sweet.residentRunNow())} title="不等了，现在就再试一轮">
          现在就继续
        </button>
      );
      break;
    case "paused":
      headline = view.note ? `已暂停：${view.note}` : "已暂停";
      action = (
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void act(() => window.sweet.residentRunNow())}>
          继续
        </button>
      );
      break;
  }

  const rounds = view.current ? [view.current, ...view.rounds.filter((r) => r.id !== view.current!.id)] : view.rounds;

  return (
    <main className="group resident" hidden={hidden}>
      <section className="group-main">
        {bar}
        {alert}
        <div className="auto-scroll">
          <div className={`rs-hero ${view.phase}`}>
            <div className="rs-hero-main">
              <span className="rs-pulse" aria-hidden="true" />
              <div className="rs-hero-text">
                <p className="rs-headline" aria-live="polite">
                  {headline}
                </p>
                <p className="rs-meta">
                  {view.on && view.startedAt ? <span>已连续运行 {span(now - view.startedAt)}</span> : <span>开启后会一直运行，直到你关掉；重启 sikeoop 也会接着来。</span>}
                  {(view.on || view.roundsToday > 0) && (
                    <span>
                      今天第 {view.roundsToday}
                      {s.dailyRounds > 0 ? ` / ${s.dailyRounds}` : ""} 轮
                    </span>
                  )}
                </p>
              </div>
              {action}
              <div className="rs-power">
                <span className="rs-power-label">{view.on ? "已开启" : "已关闭"}</span>
                <Switch
                  checked={view.on}
                  disabled={busy}
                  label={view.on ? "关闭超级常驻" : "开启超级常驻"}
                  onChange={(on) => void act(() => (on ? window.sweet.residentStart() : window.sweet.residentStop()))}
                />
              </div>
            </div>
          </div>

          <h3 className="auto-h">账号</h3>
          <p className="hint">按从上到下的顺序用；一个额度用完就换下一个，都用完就等到额度恢复再继续。</p>
          <ul className="rs-list">
            {accountRows.map((id) => {
              const at = s.accounts.indexOf(id);
              const used = at >= 0;
              const st = accountState(id);
              const limited = !!st?.limitedUntil && st.limitedUntil > now;
              return (
                <li key={id} className={"rs-item" + (used ? "" : " off")}>
                  <label className="toggle rs-check">
                    <input
                      type="checkbox"
                      checked={used}
                      onChange={(e) => void save({ accounts: e.target.checked ? [...s.accounts, id] : s.accounts.filter((a) => a !== id) })}
                      aria-label={`让 ${ACCOUNT_NAME[id]} 参与`}
                    />
                  </label>
                  <div className="rs-item-text">
                    <div className="rs-item-title">
                      {used && <span className="auto-step-n">{at + 1}</span>}
                      <span>{ACCOUNT_NAME[id]}</span>
                      {!st?.ready ? (
                        <StatusBadge tone="warn">未登录</StatusBadge>
                      ) : limited ? (
                        <StatusBadge tone="warn">额度用完，{clock(st!.limitedUntil!, now)} 恢复</StatusBadge>
                      ) : (
                        <StatusBadge tone="ok">已登录</StatusBadge>
                      )}
                    </div>
                    {!st?.ready && <p className="hint">还没有登录这个账号。到「设置 → 模型」里登录后，它才会参与。</p>}
                  </div>
                  <MoveButtons
                    disabled={!used}
                    canUp={at > 0}
                    canDown={used && at < s.accounts.length - 1}
                    onUp={() => moveAccount(at, -1)}
                    onDown={() => moveAccount(at, 1)}
                  />
                </li>
              );
            })}
          </ul>

          <h3 className="auto-h">学什么</h3>
          <ul className="rs-list">
            {s.topics.map((t, i) => (
              <li key={`${i}:${t}`} className="rs-item">
                <span className="auto-step-n">{i + 1}</span>
                <div className="rs-item-text">
                  <div className="rs-item-title">
                    <span className="rs-topic">{t}</span>
                  </div>
                </div>
                <MoveButtons canUp={i > 0} canDown={i < s.topics.length - 1} onUp={() => moveTopic(i, -1)} onDown={() => moveTopic(i, 1)} />
                <button
                  type="button"
                  className="icon-btn square"
                  title="删除这个主题"
                  aria-label={`删除主题 ${t}`}
                  onClick={() => void save({ topics: s.topics.filter((_, j) => j !== i) })}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
          {!s.topics.length && <p className="hint">不写主题时由它自己选。</p>}
          <form
            className="rs-add"
            onSubmit={(e) => {
              e.preventDefault();
              addTopic();
            }}
          >
            <input
              value={topic}
              maxLength={200}
              disabled={s.topics.length >= MAX_TOPICS}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="想让它学的主题，比如「React 19 的新特性」"
              aria-label="新的学习主题"
            />
            <button type="submit" className="mini-btn" disabled={!topic.trim() || s.topics.length >= MAX_TOPICS}>
              <Icon name="plus" />
              添加
            </button>
          </form>
          <ul className="rs-list">
            <li className="rs-item">
              <div className="rs-item-text">
                <div className="rs-item-title">自主选题</div>
                <p className="hint">清单学完了（或者没写）以后，让它自己挑值得学的新技术。关掉的话，清单学完就暂停。</p>
              </div>
              <Switch checked={s.selfDirected} onChange={(selfDirected) => void save({ selfDirected })} label="自主选题" />
            </li>
          </ul>

          <h3 className="auto-h">可以改什么</h3>
          <ul className="rs-list">
            {TARGETS.map((t) => (
              <li key={t.key} className="rs-item">
                <div className="rs-item-text">
                  <div className="rs-item-title">{t.title}</div>
                  <p className="hint">{t.desc}</p>
                </div>
                <Switch checked={s.targets[t.key]} onChange={(v) => void save({ targets: { ...s.targets, [t.key]: v } })} label={t.title} />
              </li>
            ))}
          </ul>

          <h3 className="auto-h">节奏</h3>
          <div className="rs-pace">
            <label className="rs-field">
              <span>每天最多几轮</span>
              <span className="rs-inline">
                <input type="number" min={0} max={MAX_DAILY} step={1} value={daily} onChange={(e) => setDaily(e.target.value)} aria-label="每天最多几轮" />
                <span className="hint">轮（0 表示不限）</span>
              </span>
            </label>
            <label className="rs-field">
              <span>读不出重置时间时等多久</span>
              <span className="rs-inline">
                <input type="number" min={1} max={24} step={1} value={hours} onChange={(e) => setHours(e.target.value)} aria-label="读不出重置时间时等几小时" />
                <span className="hint">小时（1–24）</span>
              </span>
            </label>
          </div>
          <div className="rs-inline">
            {!dailyOk && <span className="warn-text">每天轮数填 0 到 {MAX_DAILY} 之间的整数</span>}
            {!hoursOk && <span className="warn-text">等待时间填 1 到 24 之间的整数</span>}
            <span className="spacer" />
            <button
              type="button"
              className="mini-btn"
              disabled={!dirty || !dailyOk || !hoursOk}
              onClick={() => void save({ dailyRounds: d, defaultDelayHours: h })}
            >
              保存
            </button>
          </div>

          <h3 className="auto-h">轮次记录</h3>
          {!rounds.length && <p className="hint">还没有跑过。开启以后，每一轮学了什么、留下了什么都会记在这里。</p>}
          <ul className="auto-runs">
            {rounds.map((r) => (
              <li key={r.id} className={`auto-run rs-round ${r.status}`}>
                <div className="auto-run-head">
                  <StatusBadge tone={ROUND_STATUS[r.status].tone}>{ROUND_STATUS[r.status].label}</StatusBadge>
                  <span className="rs-round-topic">{r.topic || "自己选的主题"}</span>
                  <span className="spacer" />
                  <span className="hint rs-round-meta">
                    {ACCOUNT_NAME[r.account]} · {clock(r.startedAt, now)} · {r.status === "running" ? "已进行" : "用时"} {span((r.endedAt ?? now) - r.startedAt)}
                  </span>
                </div>
                {r.summary && <p className="rs-summary">{r.summary}</p>}
                {r.outputs.length > 0 && (
                  <ul className="rs-outputs">
                    {r.outputs.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

function MoveButtons({ canUp, canDown, disabled, onUp, onDown }: { canUp: boolean; canDown: boolean; disabled?: boolean; onUp(): void; onDown(): void }) {
  return (
    <span className="rs-move">
      <button type="button" className="icon-btn square up" title="上移" aria-label="上移" disabled={disabled || !canUp} onClick={onUp}>
        <Icon name="chevron-down" />
      </button>
      <button type="button" className="icon-btn square" title="下移" aria-label="下移" disabled={disabled || !canDown} onClick={onDown}>
        <Icon name="chevron-down" />
      </button>
    </span>
  );
}
