import type { ReactNode } from "react";
import type { ProviderView } from "@shared/types";
import { Icon } from "../Icon";

/** Shared building blocks of the settings dialog: every setting has the same shape. */

export const IS_MAC = navigator.userAgent.includes("Mac");
export const IS_WIN = navigator.userAgent.includes("Windows");

export const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** A provider has everything it needs to answer: a model, an address and a key (or an account login). */
export const isReady = (p: ProviderView) =>
  Boolean(p.model && p.baseURL && (p.authMode === "login" ? p.login?.loggedIn : !p.needsKey || p.hasKey));

export type Tone = "ok" | "warn" | "bad" | "accent" | "muted";

/** One status word, the same look everywhere: 可以用 / 还没填 Key / 正在使用 / 内置免费… */
export function StatusBadge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`st-badge ${tone}`} title={title}>
      <span className="st-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** An on/off switch; always sits at the right edge of its setting. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={"st-switch" + (checked ? " on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="st-knob" aria-hidden="true" />
    </button>
  );
}

/** The heading of a section: a title and one sentence about it. */
export function SectionHead({ title, desc }: { title: string; desc: ReactNode }) {
  return (
    <header className="st-section-head">
      <h3>{title}</h3>
      <p>{desc}</p>
    </header>
  );
}

/** Title + one sentence + status on the left, the control on the right, details underneath. */
export function SettingRow(props: {
  icon?: string;
  title: ReactNode;
  desc?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  muted?: boolean;
}) {
  const { icon, title, desc, status, control, children, muted } = props;
  return (
    <div className={"st-row" + (muted ? " muted" : "")}>
      <div className="st-row-main">
        {icon && <Icon name={icon} className="st-row-icon" />}
        <div className="st-row-text">
          <div className="st-row-title">
            <span>{title}</span>
            {status}
          </div>
          {desc && <p className="st-row-desc">{desc}</p>}
        </div>
        {control && <div className="st-row-control">{control}</div>}
      </div>
      {children && <div className="st-row-body">{children}</div>}
    </div>
  );
}

/** A labelled form field inside a section. */
export function Field({ label, htmlFor, hint, extra, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-field">
      <div className="st-field-label">
        <label htmlFor={htmlFor}>{label}</label>
        {extra}
      </div>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
