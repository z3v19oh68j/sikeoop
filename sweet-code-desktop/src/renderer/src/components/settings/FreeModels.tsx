import { useEffect, useState } from "react";
import type { EffortPurpose, ProvidersState, ProviderView } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, Switch, cleanError } from "./ui";

// 免费模型: the built-in free providers (ProviderView.builtinFree). No key or full address is shown.
// Their order is the auto pool's failover order (routing.builtinFreeOrder, the same list for every purpose).

const PURPOSES: EffortPurpose[] = ["chat", "coding", "hard", "subtask", "compress"];

function ago(at: number): string {
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
}

/** onUse: the active provider changed (the conversation switches over, like 「设为当前使用」 elsewhere). */
export function FreeModels({ state, onChange, onUse }: { state: ProvidersState; onChange(s: ProvidersState): void; onUse(s: ProvidersState): void }) {
  const free = state.providers.filter((p) => p.builtinFree);
  const [found, setFound] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    for (const p of free.filter((x) => x.model === "auto"))
      void window.sweet.providerDiscoverModels(p.id).then((l) => setFound((f) => ({ ...f, [p.id]: l.length })), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free.map((p) => p.id).join()]);

  if (!free.length) return null;
  const saved = state.routing.builtinFreeOrder?.chat ?? [];
  const rank = (id: string) => { const i = saved.indexOf(id); return i < 0 ? 1000 + free.findIndex((p) => p.id === id) : i; };
  const ordered = [...free].sort((a, b) => rank(a.id) - rank(b.id));

  async function saveOrder(ids: string[]) {
    setError("");
    const { ready: _ready, ...routing } = state.routing;
    void _ready;
    try {
      onChange(await window.sweet.setRouting({ ...routing, builtinFreeOrder: Object.fromEntries(PURPOSES.map((p) => [p, ids])) }));
    } catch (e) {
      setError(cleanError(e));
    }
  }
  function drop(target: string) {
    if (!drag || drag === target) return;
    const ids = ordered.map((p) => p.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    void saveOrder(ids);
  }
  const move = (i: number, by: number) => {
    const ids = ordered.map((p) => p.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void saveOrder(ids);
  };
  const status = (p: ProviderView) => {
    if (p.enabled === false) return <StatusBadge tone="muted">已关闭</StatusBadge>;
    const h = p.health;
    if (!h) return <StatusBadge tone="muted">还没用过</StatusBadge>;
    const [text, tone] = { ok: ["可用", "ok"], rate_limited: ["限流", "warn"], quota: ["额度用完", "warn"], error: ["出错", "bad"] }[h.status] as [string, "ok" | "warn" | "bad"];
    return (
      <StatusBadge tone={tone} title={h.message}>
        {text} · {ago(h.at)}
      </StatusBadge>
    );
  };
  async function use(p: ProviderView) {
    setError("");
    try {
      onUse(await window.sweet.setActiveProvider(p.id));
    } catch (e) {
      setError(cleanError(e));
    }
  }

  return (
    <section className="st-free" aria-label="免费模型">
      <div className="st-free-head">
        <h4>免费模型</h4>
        <span className="hint">这些模型由 sikeoop 免费提供，auto 会在它们之间自动挑选和切换。拖动卡片调整先后，排前面的先用。</span>
      </div>
      <ol className="st-free-list">
        {ordered.map((p, i) => (
          <li
            key={p.id}
            className={"st-free-card" + (p.enabled === false ? " off" : "") + (drag === p.id ? " dragging" : "")}
            draggable
            onDragStart={() => setDrag(p.id)}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { drop(p.id); setDrag(null); }}
          >
            <span className="st-free-grip" aria-hidden="true">⋮⋮</span>
            <span className="st-free-no">{i + 1}</span>
            <div className="st-free-main">
              <div className="st-free-title">
                <b>{p.name}</b>
                {status(p)}
                {p.id === state.activeId && <span className="st-using">正在使用</span>}
              </div>
              <span className="st-free-meta">
                内置 · 免费 · {p.model === "auto" ? `自动选模型${found[p.id] !== undefined ? `（发现 ${found[p.id]} 个）` : ""}` : p.model}
              </span>
            </div>
            <span className="st-free-ops">
              <button type="button" className="mini-btn icon-only" disabled={i === 0} onClick={() => move(i, -1)} aria-label="往前排"><Icon name="arrow-up" /></button>
              <button type="button" className="mini-btn icon-only flip" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} aria-label="往后排"><Icon name="arrow-up" /></button>
            </span>
            {p.enabled !== false && p.id !== state.activeId && (
              <button type="button" className="mini-btn" onClick={() => void use(p)}>
                设为当前使用
              </button>
            )}
            <Switch
              checked={p.enabled !== false}
              label={`启用 ${p.name}`}
              onChange={(v) => void window.sweet.setBuiltinFreeProviderEnabled(p.id, v).then(onChange, (e) => setError(cleanError(e)))}
            />
          </li>
        ))}
      </ol>
      {error && <p className="err-text">{error}</p>}
    </section>
  );
}
