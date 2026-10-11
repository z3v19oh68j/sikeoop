import { useState } from "react";
import { Icon } from "./Icon";
import { SkillsTab } from "./plugins/SkillsTab";
import { McpTab } from "./plugins/McpTab";
import { HooksTab } from "./plugins/HooksTab";
import { ModsTab } from "./plugins/ModsTab";
import "../styles/settings.css";
import "../styles/plugins.css";

type Tab = "skills" | "mcp" | "hooks" | "mods";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "skills", label: "技能 Skills", icon: "book" },
  { id: "mcp", label: "MCP 服务", icon: "plugin" },
  { id: "hooks", label: "Hooks", icon: "hook" },
  { id: "mods", label: "Mod", icon: "sparkle" },
];

/**
 * Plugins: skills, MCP servers, hooks and mods. Changes apply to new conversations.
 * The header, tabs and each tab's toolbar stay put; only the list underneath scrolls.
 */
export function PluginCenter({ onClose, onOpenFile }: { onClose(): void; onOpenFile(path: string): void }) {
  const [tab, setTab] = useState<Tab>("skills");
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal st-modal pc-modal" role="dialog" aria-label="插件中心">
        <header className="pc-head">
          <div className="pc-head-row">
            <h2>插件中心</h2>
            <nav className="pc-tabs" role="tablist" aria-label="插件类型">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined} onClick={() => setTab(t.id)}>
                  <Icon name={t.icon} />
                  {t.label}
                </button>
              ))}
            </nav>
            <span className="spacer" />
            <button type="button" className="icon-btn square" onClick={onClose} aria-label="关闭" title="关闭">
              <Icon name="close" />
            </button>
          </div>
          <p className="hint">
            装好的插件在<b>新对话</b>里生效。插件里的说明和工具会影响 AI 的行为，只安装你信任的来源。
          </p>
        </header>
        {tab === "skills" ? <SkillsTab /> : tab === "mcp" ? <McpTab /> : tab === "mods" ? <ModsTab /> : <HooksTab onOpenFile={(p) => (onOpenFile(p), onClose())} />}
      </div>
    </div>
  );
}
