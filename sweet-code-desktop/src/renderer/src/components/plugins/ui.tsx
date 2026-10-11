import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";

/** Shared pieces of the plugin center: toolbar, install panel, groups and the one card shape every tab uses. */

export type Tone = "neutral" | "ok" | "warn" | "accent";

/** An attribute (标准 Skill / 含脚本 / 内置 / v1.2…). Status words use StatusBadge from settings/ui. */
export function Tag({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={"pc-tag " + tone} title={title}>
      {children}
    </span>
  );
}

export interface Filter<T extends string> {
  id: T;
  label: string;
}

/** Search + filters on the left, the add button on the right. Lives above the scrolling list. */
export function Toolbar<T extends string>(props: {
  query: string;
  onQuery(q: string): void;
  placeholder: string;
  filters: Filter<T>[];
  filter: T;
  onFilter(f: T): void;
  addLabel: string;
  adding: boolean;
  onAdd(): void;
}) {
  const { query, onQuery, placeholder, filters, filter, onFilter, addLabel, adding, onAdd } = props;
  return (
    <div className="pc-toolbar">
      <label className="pc-search">
        <Icon name="eye-search" />
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} aria-label="搜索" />
        {query && (
          <button type="button" className="pc-search-clear" onClick={() => onQuery("")} aria-label="清空搜索" title="清空">
            <Icon name="close" />
          </button>
        )}
      </label>
      <div className="pc-filters" role="radiogroup" aria-label="筛选">
        {filters.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={filter === f.id ? "on" : undefined} onClick={() => onFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <button type="button" className={"send pc-add" + (adding ? " on" : "")} aria-expanded={adding} onClick={onAdd}>
        <Icon name={adding ? "close" : "plus"} /> {adding ? "收起" : addLabel}
      </button>
    </div>
  );
}

/** The install / add panel, opened from the toolbar and shown at the top of the list. */
export function AddPanel({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <section className="pc-add-panel" aria-label={title}>
      <header>
        <h4>{title}</h4>
        <button type="button" className="icon-btn square" onClick={onClose} aria-label="收起" title="收起">
          <Icon name="close" />
        </button>
      </header>
      {children}
    </section>
  );
}

/** A titled group of cards with a count and an optional action on the right. */
export function Group({ title, count, action, note, children }: { title: ReactNode; count?: number; action?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="pc-group">
      <header className="pc-group-head">
        <h4>
          {title}
          {count !== undefined && <span className="pc-count">{count}</span>}
        </h4>
        {action && <div className="pc-group-action">{action}</div>}
      </header>
      {note}
      {children}
    </section>
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  onClick(): void;
  /** Asks again before running ("确定删除？"). */
  danger?: boolean;
  disabled?: boolean;
}

/** The ⋯ menu on a card. Dangerous items need a second click on 「确定」. */
export function MoreMenu({ items, name }: { items: MenuItem[]; name: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<MenuItem | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && (setOpen(false), setConfirm(null));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), setOpen(false), setConfirm(null));
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="pc-more" ref={ref}>
      <button type="button" className="icon-btn square" aria-haspopup="menu" aria-expanded={open} aria-label={`${name} 的更多操作`} title="更多" onClick={() => (setOpen(!open), setConfirm(null))}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="pc-menu" role="menu">
          {confirm ? (
            <div className="pc-confirm">
              <p>
                确定{confirm.label}「{name}」？
              </p>
              <div>
                <button type="button" className="mini-btn" onClick={() => setConfirm(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="send danger"
                  onClick={() => {
                    setOpen(false);
                    setConfirm(null);
                    confirm.onClick();
                  }}
                >
                  确定{confirm.label}
                </button>
              </div>
            </div>
          ) : (
            items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={it.danger ? "danger" : undefined}
                disabled={it.disabled}
                onClick={() => {
                  if (it.danger) return setConfirm(it);
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <Icon name={it.icon} />}
                {it.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One plugin: name + tags on the first line, a two-line description (click to expand),
 * a light source label, the switch on the right, and a ⋯ menu. Expanding shows `details`.
 */
export function ItemCard(props: {
  name: ReactNode;
  /** Plain name for menus and labels. */
  label: string;
  tags?: ReactNode;
  status?: ReactNode;
  desc?: ReactNode;
  meta?: ReactNode;
  notes?: ReactNode;
  control?: ReactNode;
  menu?: MenuItem[];
  details?: ReactNode;
  off?: boolean;
  mono?: boolean;
}) {
  const { name, label, tags, status, desc, meta, notes, control, menu, details, off, mono } = props;
  const [open, setOpen] = useState(false);
  const expandable = !!details || !!desc;
  return (
    <li className={"pc-card" + (off ? " off" : "") + (open ? " open" : "")}>
      <div className="pc-card-main">
        <div className="pc-card-text">
          <div className="pc-card-title">
            <span className="pc-name">{name}</span>
            {status}
            {tags}
          </div>
          {desc && (
            <button
              type="button"
              className={"pc-desc" + (mono ? " mono" : "")}
              onClick={() => expandable && setOpen(!open)}
              aria-expanded={open}
              title={open ? "收起" : "点开看全部"}
            >
              {desc}
            </button>
          )}
          {notes}
          {meta && <div className="pc-meta">{meta}</div>}
        </div>
        <div className="pc-card-side">
          {control}
          {details && (
            <button type="button" className={"icon-btn square pc-expand" + (open ? " on" : "")} aria-expanded={open} aria-label={open ? "收起详情" : "展开详情"} title={open ? "收起" : "详情"} onClick={() => setOpen(!open)}>
              <Icon name="chevron-down" />
            </button>
          )}
          {menu && <MoreMenu items={menu} name={label} />}
        </div>
      </div>
      {open && details && <div className="pc-card-details">{details}</div>}
    </li>
  );
}

/** Lower-cased "does this text contain the query". */
export const matches = (q: string, ...texts: (string | undefined)[]) => {
  const s = q.trim().toLowerCase();
  return !s || texts.some((t) => t?.toLowerCase().includes(s));
};

export function Empty({ children }: { children: ReactNode }) {
  return <p className="pc-empty">{children}</p>;
}
