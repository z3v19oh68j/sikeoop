import type { ModelRef, ProvidersState, ProviderView, RoutingSettings as Routing } from "@shared/types";
import { Icon } from "./Icon";

// Model routing pieces used by the settings dialog's 「模型分工」 section (settings/RolesSection.tsx):
// the draft ↔ stored conversion, the shared「选服务商 + 选模型」picker and the failover list.

export const MAX_FAILOVER = 5;

/** A model slot in the draft; providerId "" = not set. */
export type Slot = ModelRef;
export const EMPTY: Slot = { providerId: "", model: "" };

export const toSlot = (r?: ModelRef): Slot => (r ? { ...r } : { ...EMPTY });
export const toRef = (s: Slot): ModelRef | undefined => (s.providerId && s.model.trim() ? { providerId: s.providerId, model: s.model.trim() } : undefined);
const sameRef = (a?: ModelRef, b?: ModelRef) => (a?.providerId ?? "") === (b?.providerId ?? "") && (a?.model ?? "") === (b?.model ?? "");

export interface RoutingDraft {
  failover: Slot[];
  enabled: boolean;
  light: Slot;
  heavy: Slot;
  compress: Slot;
  subtask: Slot;
}

export function routingDraft(r: Routing): RoutingDraft {
  return {
    failover: r.failover.map(toSlot),
    enabled: r.difficulty.enabled,
    light: toSlot(r.difficulty.light),
    heavy: toSlot(r.difficulty.heavy),
    compress: toSlot(r.purposes.compress),
    subtask: toSlot(r.purposes.subtask),
  };
}

export function toRouting(d: RoutingDraft): Routing {
  return {
    failover: d.failover.map(toRef).filter((r): r is ModelRef => !!r),
    difficulty: { enabled: d.enabled, light: toRef(d.light), heavy: toRef(d.heavy) },
    purposes: { compress: toRef(d.compress), subtask: toRef(d.subtask) },
  };
}

export function sameRouting(a: Routing, b: Routing) {
  return (
    a.failover.length === b.failover.length &&
    a.failover.every((r, i) => sameRef(r, b.failover[i])) &&
    a.difficulty.enabled === b.difficulty.enabled &&
    sameRef(a.difficulty.light, b.difficulty.light) &&
    sameRef(a.difficulty.heavy, b.difficulty.heavy) &&
    sameRef(a.purposes.compress, b.purposes.compress) &&
    sameRef(a.purposes.subtask, b.purposes.subtask)
  );
}

/** A slot with a provider but no model name can't be saved. */
export const routingIncomplete = (d: RoutingDraft) =>
  [...d.failover, d.light, d.heavy, d.compress, d.subtask].some((s) => s.providerId && !s.model.trim());

export const providerReady = (p: ProviderView) => (p.authMode === "login" ? !!p.login?.loggedIn : !p.needsKey || p.hasKey);

/** False when the slot's provider can't run yet (no key). Empty slots follow the conversation, so they are fine. */
export function slotReady(state: ProvidersState, s: Slot): boolean {
  if (!s.providerId || !s.model.trim()) return true;
  const stored = state.routing.ready[`${s.providerId}:${s.model.trim()}`];
  if (stored !== undefined) return stored;
  const p = state.providers.find((x) => x.id === s.providerId);
  return p ? providerReady(p) : false;
}

/** Provider select + model name (typed, or picked from that provider's known models). */
export function ModelPicker(props: {
  state: ProvidersState;
  value: Slot;
  onChange(v: Slot): void;
  label: string;
  id: string;
  /** When given, the select offers "not set" with this text. */
  emptyText?: string;
  disabled?: boolean;
}) {
  const { state, value, onChange, label, id, emptyText, disabled } = props;
  const provider = state.providers.find((p) => p.id === value.providerId);
  const options = provider ? [...new Set([provider.model, ...provider.models, ...provider.suggestedModels].filter(Boolean))] : [];
  return (
    <div className="st-picker">
      <select
        id={`${id}-provider`}
        value={value.providerId}
        disabled={disabled}
        onChange={(e) => {
          const p = state.providers.find((x) => x.id === e.target.value);
          onChange({ providerId: e.target.value, model: p ? p.model : "" });
        }}
        aria-label={`${label}的服务商`}
      >
        {emptyText !== undefined && <option value="">{emptyText}</option>}
        {emptyText === undefined && !value.providerId && <option value="">选择服务商</option>}
        {state.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {value.providerId && (
        <>
          <input
            id={`${id}-model`}
            list={`${id}-models`}
            value={value.model}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            placeholder="模型名（可以手填）"
            autoComplete="off"
            aria-label={`${label}的模型名`}
          />
          <datalist id={`${id}-models`}>
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

/** The ordered backups tried when the conversation's model fails. */
export function FailoverList({ state, list, onChange }: { state: ProvidersState; list: Slot[]; onChange(list: Slot[]): void }) {
  function move(i: number, by: number) {
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  }
  return (
    <div className="st-failover">
      {list.length === 0 && <p className="st-empty">还没有备用模型。出错时会停下来等你处理。</p>}
      {list.length > 0 && (
        <ol>
          {list.map((s, i) => (
            <li key={i}>
              <span className="st-index">{i + 1}</span>
              <ModelPicker
                state={state}
                value={s}
                onChange={(v) => onChange(list.map((x, j) => (j === i ? v : x)))}
                label={`第 ${i + 1} 个备用模型`}
                id={`routing-failover-${i}`}
              />
              {!slotReady(state, s) && <span className="warn-text st-inline-warn">还没配好 Key</span>}
              <span className="st-order">
                <button type="button" className="mini-btn icon-only" disabled={i === 0} onClick={() => move(i, -1)} title="上移" aria-label="上移">
                  <Icon name="arrow-up" />
                </button>
                <button type="button" className="mini-btn icon-only flip" disabled={i === list.length - 1} onClick={() => move(i, 1)} title="下移" aria-label="下移">
                  <Icon name="arrow-up" />
                </button>
                <button type="button" className="mini-btn icon-only" onClick={() => onChange(list.filter((_, j) => j !== i))} title="删除" aria-label="删除">
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="mini-btn"
        disabled={list.length >= MAX_FAILOVER}
        onClick={() => {
          const p = state.providers.find((x) => x.id !== state.activeId) ?? state.providers[0];
          onChange([...list, p ? { providerId: p.id, model: p.model } : { ...EMPTY }]);
        }}
      >
        <Icon name="plus" /> {list.length >= MAX_FAILOVER ? `最多 ${MAX_FAILOVER} 个` : "添加备用模型"}
      </button>
    </div>
  );
}
