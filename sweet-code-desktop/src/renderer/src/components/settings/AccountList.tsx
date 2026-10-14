import { useCallback, useEffect, useRef, useState } from "react";
import { cleanError } from "./ui";

/** What every subscription account has, whichever provider it belongs to. */
export interface AccountBase {
  id: string;
  email?: string;
  /** The account requests are sent with right now. */
  active: boolean;
}

/** One quota window as a bar: percent used and when it resets. */
export interface UsageBar {
  key: string;
  label: string;
  used: number;
  resetsAt?: string;
}

/** An account's usage as the card shows it: the query's error, or its bars (`warn` is a short line above them). */
export type AccountUsage = { error: string } | { bars: UsageBar[]; warn?: string };

export interface AccountApi<A extends AccountBase> {
  list(): Promise<A[]>;
  switchTo(id: string): Promise<A[]>;
  remove(id: string): Promise<A[]>;
}

const AUTO_REFRESH_MS = 60_000;

/** ISO reset timestamp → "2 小时 10 分后重置" / "3 天 4 小时后重置". */
export function resetIn(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((t - Date.now()) / 60_000);
  if (mins <= 0) return "即将重置";
  if (mins < 60) return `${mins} 分钟后重置`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} 小时 ${mins % 60} 分后重置` : `${hours} 小时后重置`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时后重置` : `${days} 天后重置`;
}

/** Percent bars: green, warn colour from 80%, bad colour and "已用完" from 100%. */
export function UsageBars({ bars }: { bars: UsageBar[] }) {
  return (
    <>
      {bars.map(({ key, label, used: raw, resetsAt }) => {
        const used = Math.max(0, Math.round(raw));
        const tone = used >= 100 ? "full" : used >= 80 ? "high" : "";
        const reset = resetIn(resetsAt);
        return (
          <div key={key} className={`st-acct-usage ${tone}`}>
            <span className="st-acct-usage-head">
              <span>{label}</span>
              <span className="st-acct-usage-num">
                <b>{used >= 100 ? "已用完" : `${used}%`}</b>
                {reset ? ` · ${reset}` : ""}
              </span>
            </span>
            <span className="st-acct-bar">
              <span style={{ width: `${Math.min(100, used)}%` }} />
            </span>
          </div>
        );
      })}
    </>
  );
}

function accountName(a: AccountBase): string {
  return a.email || `账号 ${a.id.slice(0, 8)}`;
}

interface Props<A extends AccountBase> {
  /** Header text, e.g. "Claude 账号". */
  title: string;
  /** Must keep its identity between renders (define it at module level). */
  api: AccountApi<A>;
  usage(a: A): AccountUsage;
  /** A small label after the name, e.g. the plan. */
  tag?(a: A): string | undefined;
  emptyHint: string;
  /** Bump to reload the list (after an account was added). */
  reloadKey: number;
  /** The add-account flow is open: the button turns into its cancel. */
  adding: boolean;
  onToggleAdd(): void;
  /** Called after a switch or removal, so the caller can re-read the providers state. */
  onChanged(): void;
  /** The id of the account in use, "" when there is none. */
  onActiveChange(id: string): void;
}

/** Every logged-in subscription account of one provider with its usage; switch, log out, add. */
export function AccountList<A extends AccountBase>({ title, api, usage, tag, emptyHint, reloadKey, adding, onToggleAdd, onChanged, onActiveChange }: Props<A>) {
  const [accounts, setAccounts] = useState<A[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const busyRef = useRef(false);
  const updatedRef = useRef(0);
  const onActiveRef = useRef(onActiveChange);
  onActiveRef.current = onActiveChange;

  const apply = useCallback((list: A[]) => {
    setAccounts(list);
    updatedRef.current = Date.now();
    setUpdatedAt(updatedRef.current);
    onActiveRef.current(list.find((a) => a.active)?.id ?? "");
  }, []);

  /** Re-read the list. A background refresh keeps the last error line and the rows as they are until it answers. */
  const load = useCallback(
    async (background = false) => {
      if (busyRef.current) return;
      const mine = ++seq.current;
      setLoading(true);
      if (!background) setError("");
      try {
        const list = await api.list();
        if (mine !== seq.current) return;
        apply(list);
        setError("");
      } catch (e) {
        if (mine === seq.current) setError(`读取账号出错：${cleanError(e)}`);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [api, apply],
  );

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Refresh every 60s while this panel is actually on screen; catch up when the window comes back.
  useEffect(() => {
    const visible = () => document.visibilityState === "visible" && !!rootRef.current && rootRef.current.offsetParent !== null;
    const t = setInterval(() => {
      if (visible()) void load(true);
    }, AUTO_REFRESH_MS);
    const onVisibility = () => {
      if (visible() && Date.now() - updatedRef.current >= AUTO_REFRESH_MS) void load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function act(a: A, kind: "switch" | "remove") {
    if (busyRef.current) return;
    if (kind === "remove" && !window.confirm(`退出「${accountName(a)}」？这个账号的登录会从 sikeoop 里删掉，之后要用得重新登录。`)) return;
    busyRef.current = true;
    seq.current++; // drop any refresh still in flight
    setLoading(false);
    setBusyId(a.id);
    setError("");
    try {
      apply(kind === "switch" ? await api.switchTo(a.id) : await api.remove(a.id));
      onChanged();
    } catch (e) {
      setError(`${kind === "switch" ? "切换账号失败" : "退出账号失败"}：${cleanError(e)}`);
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  }

  const busy = !!busyId;
  return (
    <div className="st-login-state st-accts" ref={rootRef}>
      <span className="st-accts-head">
        <span>
          {title}
          {accounts?.length ? `（${accounts.length}）` : ""}
          {updatedAt > 0 && (
            <span className="st-accts-time">
              {loading ? "刷新中…" : `更新于 ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            </span>
          )}
        </span>
        <span className="st-inline">
          <button type="button" className="link-btn" onClick={() => void load()} disabled={loading || busy}>
            刷新
          </button>
          <button type="button" className="link-btn" onClick={onToggleAdd} disabled={busy}>
            {adding ? "取消添加" : "添加账号"}
          </button>
        </span>
      </span>

      {error && <span className="st-accts-error">{error}</span>}

      {!accounts ? (
        <span className="hint">{loading ? "查询中…" : "暂无账号数据"}</span>
      ) : accounts.length === 0 ? (
        <span className="hint">{emptyHint}</span>
      ) : (
        accounts.map((a) => {
          const u = usage(a);
          const label = tag?.(a);
          return (
            <div key={a.id} className={`st-acct${a.active ? " active" : ""}`}>
              <span className="st-acct-head">
                <span className="st-acct-name" title={a.email || a.id}>
                  {accountName(a)}
                </span>
                {label && <span className="st-acct-tag">{label}</span>}
                {a.active && <span className="st-acct-badge">使用中</span>}
                <span className="st-acct-actions">
                  {!a.active && (
                    <button type="button" className="link-btn" onClick={() => void act(a, "switch")} disabled={busy}>
                      {busyId === a.id ? "处理中…" : "切换到这个账号"}
                    </button>
                  )}
                  <button type="button" className="link-btn" onClick={() => void act(a, "remove")} disabled={busy}>
                    退出
                  </button>
                </span>
              </span>
              {"error" in u ? (
                <span className="st-accts-error">读取额度出错：{u.error}</span>
              ) : (
                <>
                  {u.warn && <span className="st-accts-error">{u.warn}</span>}
                  {u.bars.length === 0 && !u.warn && <span className="hint">这个账号没有返回额度窗口。</span>}
                  <UsageBars bars={u.bars} />
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
