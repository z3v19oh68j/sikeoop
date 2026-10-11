import { useEffect, useState } from "react";
import type { ProvidersState, WebSearchState } from "@shared/types";
import { Icon } from "../Icon";
import { SectionHead, SettingRow, StatusBadge, Switch, cleanError } from "./ui";
import { SHOW_UNFINISHED } from "../../unfinished";
import { PaperToolsCard } from "../papers/PaperToolsCard";

interface Props {
  state: ProvidersState;
  onChange(s: ProvidersState): void;
  onOpenProvider(id: string): void;
}

/** 编辑器与联网: AI help while writing code, and how the AI searches the web. */
export function EditorSection({ state, onChange, onOpenProvider }: Props) {
  const { enabled, ready } = state.completion;
  return (
    <div className="st-section">
      <SectionHead title="编辑器与联网" desc="写代码时的 AI 帮手，以及 AI 上网查资料用哪个搜索引擎。" />

      <SettingRow
        icon="sparkle"
        title="AI 代码补全"
        desc="写代码时用 DeepSeek 猜你接下来要写什么，灰色字按 Tab 接受。"
        status={
          !ready ? (
            <StatusBadge tone="warn">需要 DeepSeek 的 Key</StatusBadge>
          ) : enabled ? (
            <StatusBadge tone="ok">已打开</StatusBadge>
          ) : (
            <StatusBadge tone="muted">没开</StatusBadge>
          )
        }
        control={<Switch checked={enabled} onChange={(v) => void window.sweet.setCompletion(v).then(onChange)} label="AI 代码补全" />}
      >
        {!ready && (
          <button type="button" className="link-btn" onClick={() => onOpenProvider("deepseek")}>
            去填 DeepSeek 的 Key
          </button>
        )}
      </SettingRow>

      <WebSearchRow />
      {/* 论文工坊 is in the development build only, and so is its downloaded Quarto. */}
      {SHOW_UNFINISHED && <PaperToolsCard />}
    </div>
  );
}

const ENGINE_NAME: Record<WebSearchState["using"], string> = { duckduckgo: "DuckDuckGo", tavily: "Tavily", brave: "Brave Search" };

/** Which search engine the AI's web_search uses; Tavily / Brave keys are saved encrypted, never shown. */
function WebSearchRow() {
  const [w, setW] = useState<WebSearchState | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void window.sweet.webSearch().then(setW);
  }, []);
  if (!w) return null;
  const keyFor = w.engine === "tavily" || w.engine === "brave" ? w.engine : null;
  const save = async (u: Parameters<typeof window.sweet.setWebSearch>[0]) => {
    setError("");
    try {
      setW(await window.sweet.setWebSearch(u));
      setKey("");
    } catch (e) {
      setError(cleanError(e));
    }
  };
  const missingKey = w.engine !== "auto" && w.engine !== w.using;
  return (
    <SettingRow
      icon="globe"
      title="网页搜索"
      desc="AI 遇到拿不准或可能过时的事会自己上网搜，并打开结果读原文。"
      status={
        missingKey ? (
          <StatusBadge tone="warn">{ENGINE_NAME[w.engine as WebSearchState["using"]]} 还没填 Key，先用 {ENGINE_NAME[w.using]}</StatusBadge>
        ) : (
          <StatusBadge tone="ok">正在用 {ENGINE_NAME[w.using]}</StatusBadge>
        )
      }
    >
      <div className="st-inline">
        <select className="st-select" value={w.engine} onChange={(e) => void save({ engine: e.target.value as WebSearchState["engine"] })} aria-label="搜索引擎">
          <option value="auto">自动：有 Key 用 Tavily / Brave，否则 DuckDuckGo</option>
          <option value="duckduckgo">DuckDuckGo（免费，不用 Key）</option>
          <option value="tavily">Tavily（为 AI 设计，每月有免费额度）</option>
          <option value="brave">Brave Search（每月有免费额度）</option>
        </select>
      </div>
      {keyFor && (
        <div className="st-inline">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={w.hasKey[keyFor] ? "已保存。填新的会替换" : `粘贴 ${ENGINE_NAME[keyFor]} 的 API Key`}
            autoComplete="off"
            aria-label={`${ENGINE_NAME[keyFor]} 的 API Key`}
          />
          <button type="button" className="mini-btn" disabled={!key.trim()} onClick={() => void save(keyFor === "tavily" ? { tavilyKey: key } : { braveKey: key })}>
            保存
          </button>
          {w.hasKey[keyFor] && (
            <button type="button" className="mini-btn" onClick={() => void save({ clear: keyFor })}>
              <Icon name="trash" /> 删除 Key
            </button>
          )}
        </div>
      )}
      <p className="hint">DuckDuckGo 在有些网络下打不开，打不开时换成 Tavily 或 Brave。打开搜索结果以外的网址需要你确认；本机和内网地址一律不访问。</p>
      {error && <p className="err-text">{error}</p>}
    </SettingRow>
  );
}
