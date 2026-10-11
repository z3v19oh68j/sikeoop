import { useEffect, useState } from "react";
import type { ProvidersState } from "@shared/types";
import { Icon } from "./Icon";
import { ProviderSection } from "./settings/ProviderSection";
import { RolesSection } from "./settings/RolesSection";
import { EditorSection } from "./settings/EditorSection";
import { InterfaceSection } from "./settings/InterfaceSection";
import { isReady } from "./settings/ui";
import "../styles/settings.css";

export { isReady };

export type SettingsSection = "providers" | "roles" | "editor" | "interface";

interface Props {
  state: ProvidersState;
  /** Provider to show first; defaults to the active one. */
  initialId?: string;
  /** Section to open on; defaults to 模型服务商 (also the first-run setup). */
  initialSection?: SettingsSection;
  onClose(): void;
  /** Called with the new state; `switched` is true when the active conversation was reset. */
  onChange(s: ProvidersState, switched: boolean): void;
}

const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: "providers", label: "模型服务商", icon: "key" },
  { id: "roles", label: "模型分工", icon: "graph" },
  { id: "editor", label: "编辑器与联网", icon: "file" },
  { id: "interface", label: "界面与输入", icon: "sparkle" },
];

/** The settings dialog: sections on the left, one at a time on the right. */
export function ProviderDialog({ state, initialId, initialSection, onClose, onChange }: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "providers");
  const [selectedId, setSelectedId] = useState(initialId ?? state.activeId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = state.providers.find((p) => p.id === state.activeId);
  const activeReady = !!active && isReady(active);
  const openProvider = (id: string) => {
    setSelectedId(id);
    setSection("providers");
  };
  const quiet = (s: ProvidersState) => onChange(s, false);

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal st-modal" role="dialog" aria-label="设置">
        <header className="st-top">
          <h2>设置</h2>
          <span className="st-top-now" title="当前对话用的服务商和模型">
            {active ? (
              <>
                <span className={"st-pdot " + (activeReady ? "active" : "")} aria-hidden="true" />
                正在使用 <b>{active.name}</b>
                {active.model && <em> · {active.model}</em>}
              </>
            ) : null}
          </span>
          <button type="button" className="icon-btn square" onClick={onClose} title="关闭" aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        <div className="st-body">
          <nav className="st-nav" aria-label="设置分区">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"st-nav-item" + (section === s.id ? " on" : "")}
                aria-current={section === s.id ? "page" : undefined}
                onClick={() => setSection(s.id)}
              >
                <Icon name={s.icon} />
                <span>{s.label}</span>
                {s.id === "providers" && !activeReady && <span className="st-nav-warn" title="当前服务商还没配好" />}
              </button>
            ))}
          </nav>

          {/* Every section stays mounted so half-filled fields survive switching tabs. */}
          <div className="st-content">
            <div hidden={section !== "providers"}>
              <ProviderSection state={state} selectedId={selectedId} onSelect={setSelectedId} onClose={onClose} onChange={onChange} />
            </div>
            <div hidden={section !== "roles"}>
              <RolesSection state={state} onChange={quiet} onOpenProvider={openProvider} />
            </div>
            <div hidden={section !== "editor"}>
              <EditorSection state={state} onChange={quiet} onOpenProvider={openProvider} />
            </div>
            <div hidden={section !== "interface"}>
              <InterfaceSection />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
