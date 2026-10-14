import { useEffect, useState } from "react";
import type { SkillInfo, SkillPreview, SkillSource } from "@shared/types";
import { SkillReview } from "../SkillReview";
import { Switch, cleanError } from "../settings/ui";
import { AddPanel, Empty, Group, ItemCard, Tag, Toolbar, matches } from "./ui";

type F = "all" | "on" | "builtin" | "mine";
const FILTERS: { id: F; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "on", label: "已启用" },
  { id: "builtin", label: "内置" },
  { id: "mine", label: "我装的" },
];

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<F>("all");
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [textName, setTextName] = useState("");
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.listSkills().then(setSkills);
  }, []);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError("");
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy("");
    }
  }

  const show = (p: SkillPreview | null | undefined) => p && setPreview(p);
  const previewFrom = (source: SkillSource) => run("读取中…", () => window.sweet.previewSkills(source)).then(show);

  const visible = (skills ?? []).filter(
    (s) =>
      matches(query, s.name, s.description, s.source, s.origin) &&
      (filter === "all" || (filter === "on" ? s.enabled : filter === "builtin" ? s.builtin : !s.builtin)),
  );
  const mine = visible.filter((s) => !s.builtin);
  const builtin = visible.filter((s) => s.builtin);

  const card = (s: SkillInfo) => (
    <ItemCard
      key={s.name}
      label={s.name}
      name={s.name}
      off={!s.enabled}
      tags={
        <>
          {s.forced ? (
            <Tag tone="warn" title="强制预设 · hack 专用模块，不能关闭也不能删除">强制预设</Tag>
          ) : s.builtin ? (
            <Tag tone="accent">内置</Tag>
          ) : (
            <Tag tone={s.format === "standard" ? "ok" : "neutral"}>{s.format === "standard" ? "标准 Skill" : `由${s.origin}转换`}</Tag>
          )}
          {s.hasScripts && (
            <Tag tone="warn" title="技能里带脚本。脚本不会自动运行，AI 要运行时会先问你">
              含脚本
            </Tag>
          )}
        </>
      }
      desc={s.description || "（没有说明）"}
      meta={!s.builtin && s.source ? `来自 ${s.source}` : undefined}
      control={<Switch checked={s.enabled} disabled={s.forced} onChange={(v) => void window.sweet.setSkillEnabled(s.name, v).then(setSkills)} label={s.forced ? `${s.name}（强制启用）` : `启用 ${s.name}`} />}
      menu={s.forced ? [] : [{ label: "删除", icon: "trash", danger: true, onClick: () => void window.sweet.removeSkill(s.name).then(setSkills) }]}
    />
  );

  const restore = (
    <button
      type="button"
      className="mini-btn"
      title="把删掉的内置技能装回来"
      disabled={!!busy}
      onClick={() => void run("恢复中…", () => window.sweet.restoreBuiltinSkills()).then((list) => list && setSkills(list))}
    >
      恢复内置技能
    </button>
  );

  return (
    <div className="pc-tab">
      <Toolbar<F>
        query={query}
        onQuery={setQuery}
        placeholder="搜索技能名或说明"
        filters={FILTERS}
        filter={filter}
        onFilter={setFilter}
        addLabel="安装技能"
        adding={adding}
        onAdd={() => setAdding(!adding)}
      />
      <div className="pc-scroll">
        {adding && (
          <AddPanel title="安装技能" onClose={() => setAdding(false)}>
            <div className="st-inline">
              <input
                id="skill-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="粘贴 GitHub 仓库 / 文件夹 / 文件链接，或任意 .md、.zip 网址"
                onKeyDown={(e) => e.key === "Enter" && url.trim() && void previewFrom({ kind: "url", url })}
              />
              <button type="button" className="send" disabled={!url.trim() || !!busy} onClick={() => void previewFrom({ kind: "url", url })}>
                预览
              </button>
            </div>
            <div className="st-inline">
              <span className="pc-or">或者</span>
              <button type="button" className="mini-btn" disabled={!!busy} onClick={() => void run("读取中…", () => window.sweet.pickLocalSkills("file")).then(show)}>
                选文件 / 压缩包
              </button>
              <button type="button" className="mini-btn" disabled={!!busy} onClick={() => void run("读取中…", () => window.sweet.pickLocalSkills("folder")).then(show)}>
                选文件夹
              </button>
              <button type="button" className={"mini-btn" + (pasting ? " on" : "")} onClick={() => setPasting(!pasting)}>
                {pasting ? "收起粘贴" : "粘贴文本"}
              </button>
              {busy && <span className="hint">{busy}</span>}
            </div>
            {pasting && (
              <div className="pc-paste">
                <input id="skill-text-name" value={textName} onChange={(e) => setTextName(e.target.value)} placeholder="技能名（英文，比如 commit-style）" />
                <textarea
                  id="skill-text"
                  className="st-textarea"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={"粘贴一段规则或提示词，比如：\n# 提交规范\n提交信息用中文写，第一行不超过 50 个字。"}
                />
                <button type="button" className="mini-btn" disabled={!text.trim() || !!busy} onClick={() => void previewFrom({ kind: "text", text, name: textName })}>
                  预览
                </button>
              </div>
            )}
            <p className="hint">支持标准 Skill（带 SKILL.md 的文件夹），也能自动转换 Cursor 规则（.mdc）、Claude Code 命令、Copilot 提示词、AGENTS.md 和普通 Markdown。</p>
            {error && <div className="err">{error}</div>}
            {preview && (
              <SkillReview
                key={preview.previewId}
                preview={preview}
                onCancel={() => setPreview(null)}
                onInstalled={(list) => {
                  setSkills(list);
                  setPreview(null);
                  setUrl("");
                  setText("");
                  setTextName("");
                  setPasting(false);
                  setAdding(false);
                }}
              />
            )}
          </AddPanel>
        )}
        {!adding && error && <div className="err">{error}</div>}

        {!skills ? (
          <Empty>读取中…</Empty>
        ) : (
          <>
            {filter !== "builtin" && (
              <Group title="我装的" count={mine.length}>
                {mine.length ? (
                  <ul className="pc-list">{mine.map(card)}</ul>
                ) : (
                  <Empty>
                    {query || filter !== "all" ? "没有符合条件的技能。" : "还没装过技能。点右上角「安装技能」，试试粘贴 https://github.com/anthropics/skills"}
                  </Empty>
                )}
              </Group>
            )}
            {filter !== "mine" && (
              <Group
                title="内置"
                count={builtin.length}
                action={restore}
                note={<p className="pc-group-note">sikeoop 自带的技能，删掉了可以随时恢复。</p>}
              >
                {builtin.length ? <ul className="pc-list">{builtin.map(card)}</ul> : <Empty>{query || filter !== "all" ? "没有符合条件的技能。" : "内置技能都被删掉了，点「恢复内置技能」装回来。"}</Empty>}
              </Group>
            )}
            <p className="pc-foot">关掉开关后，新对话里不会出现这个技能。</p>
          </>
        )}
      </div>
    </div>
  );
}
