import { useEffect, useState } from "react";
import type { PromptPackState, PromptPreset, WritingAction } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge } from "../settings/ui";
import { Tag } from "../plugins/ui";
import { cleanError } from "./common";
import { ACTIONS, ACTION_LABEL } from "./actions";

const ORIGIN: Record<PromptPreset["origin"], { text: string; tone: "accent" | "ok" | "neutral" }> = {
  sikeoop: { text: "内置", tone: "accent" },
  user: { text: "我的", tone: "ok" },
  gpt_academic: { text: "gpt_academic · GPL-3.0", tone: "neutral" },
};

const blank = (): PromptPreset => ({ id: "", name: "", prefix: "", suffix: "", origin: "user" });

/** Prompt presets: built-in, mine (editable) and the optional gpt_academic pack. */
export function PresetsPanel({ presets, onPresets }: { presets: PromptPreset[]; onPresets(p: PromptPreset[]): void }) {
  const [editing, setEditing] = useState<PromptPreset | null>(null);
  const [pack, setPack] = useState<PromptPackState | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.sweet.promptPackState().then(setPack);
  }, []);

  async function save() {
    if (!editing) return;
    setError("");
    try {
      onPresets(await window.sweet.savePromptPreset({ ...editing, id: editing.id || `user-${Date.now()}`, origin: "user" }));
      setEditing(null);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function packDo(fn: () => Promise<PromptPackState>) {
    setError("");
    setPackBusy(true);
    try {
      setPack(await fn());
      onPresets(await window.sweet.promptPresets());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setPackBusy(false);
      setConfirmRemove(false);
    }
  }

  const groups: PromptPreset["origin"][] = ["user", "sikeoop", "gpt_academic"];

  return (
    <section className="rs-card pp-presets">
      <header className="rs-card-head">
        <Icon name="settings" />
        <h3>提示词预设</h3>
        <span className="spacer" />
        <button type="button" className="mini-btn" onClick={() => setEditing(blank())}>
          <Icon name="plus" /> 新建预设
        </button>
      </header>
      <p className="hint">预设就是一段固定的要求，放在你的文字前后发给模型。指定了用途的预设可以替换对应按钮的默认做法，没指定的会多出一个按钮。</p>

      {editing && (
        <div className="pp-preset-edit">
          <div className="pp-grid2">
            <label className="pp-fld">
              <span>名字</span>
              <input className="rs-input pp-wide" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="比如：审稿人口吻润色" />
            </label>
            <label className="pp-fld">
              <span>用于</span>
              <select className="rs-select" value={editing.action ?? ""} onChange={(e) => setEditing({ ...editing, action: (e.target.value || undefined) as WritingAction | undefined })}>
                <option value="">单独一个按钮</option>
                {ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    替换「{a.label}」
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="pp-fld">
            <span>放在文字前面</span>
            <textarea className="rs-textarea" rows={3} value={editing.prefix} onChange={(e) => setEditing({ ...editing, prefix: e.target.value })} placeholder="比如：请以期刊审稿人的标准润色下面这段英文，保持术语不变：" />
          </label>
          <label className="pp-fld">
            <span>放在文字后面（可以不填）</span>
            <textarea className="rs-textarea" rows={2} value={editing.suffix} onChange={(e) => setEditing({ ...editing, suffix: e.target.value })} />
          </label>
          <div className="rs-actions">
            <span className="spacer" />
            <button type="button" className="mini-btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button type="button" className="send rs-accent" disabled={!editing.name.trim() || !editing.prefix.trim()} onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      )}

      {groups.map((g) => {
        const list = presets.filter((p) => p.origin === g);
        if (!list.length) return null;
        return (
          <div key={g} className="pp-preset-group">
            <div className="rs-label">
              {g === "user" ? "我的" : g === "sikeoop" ? "内置" : "gpt_academic 提示词包"} <span className="rs-count">{list.length}</span>
            </div>
            <ul className="pp-preset-list">
              {list.map((p) => (
                <li key={p.id}>
                  <div className="pp-preset-main">
                    <b>{p.name}</b>
                    <Tag tone={ORIGIN[p.origin].tone}>{ORIGIN[p.origin].text}</Tag>
                    {p.action && <span className="hint">替换「{ACTION_LABEL[p.action]}」</span>}
                    <p className="pp-preset-text">{p.prefix}</p>
                  </div>
                  {p.origin === "user" && (
                    <span className="pp-preset-ops">
                      <button type="button" className="mini-btn" onClick={() => setEditing(p)}>
                        编辑
                      </button>
                      <button type="button" className="mini-btn" onClick={() => void window.sweet.deletePromptPreset(p.id).then(onPresets)}>
                        删除
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="pp-pack">
        <div className="pp-pack-head">
          <b>gpt_academic 提示词包</b>
          {pack?.installed ? <StatusBadge tone="ok">已导入 {pack.count} 个</StatusBadge> : <StatusBadge tone="muted">没导入</StatusBadge>}
          <Tag>GPL-3.0</Tag>
        </div>
        {pack?.installed ? (
          <p className="hint">
            {pack.fetchedAt ? `${new Date(pack.fetchedAt).toLocaleString("zh-CN")} 从仓库下载。` : ""}这些预设来自{" "}
            <a href={pack.repo} target="_blank" rel="noreferrer">
              gpt_academic
            </a>
            ，按 GPL-3.0 许可使用，只保存在你这台电脑上。
          </p>
        ) : (
          <p className="hint">
            一套常用的学术写作提示词。点「导入」后从它的{" "}
            <a href={pack?.repo || "https://github.com/binary-husky/gpt_academic"} target="_blank" rel="noreferrer">
              GitHub 仓库
            </a>{" "}
            下载到本机，sikeoop 不随包分发；许可 GPL-3.0。
          </p>
        )}
        <div className="rs-actions">
          {pack?.installed ? (
            confirmRemove ? (
              <>
                <span className="hint">移除后这些预设就不能用了，随时可以再导入。</span>
                <button type="button" className="mini-btn" onClick={() => setConfirmRemove(false)}>
                  取消
                </button>
                <button type="button" className="send danger" disabled={packBusy} onClick={() => void packDo(() => window.sweet.promptPackRemove())}>
                  确定移除
                </button>
              </>
            ) : (
              <>
                <button type="button" className="mini-btn" disabled={packBusy} onClick={() => void packDo(() => window.sweet.promptPackImport())}>
                  <Icon name="refresh" /> 重新下载
                </button>
                <button type="button" className="mini-btn" onClick={() => setConfirmRemove(true)}>
                  移除
                </button>
              </>
            )
          ) : (
            <button type="button" className="send rs-accent" disabled={packBusy || !pack} onClick={() => void packDo(() => window.sweet.promptPackImport())}>
              {packBusy ? "下载中…" : "导入"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="err-text">{error}</p>}
    </section>
  );
}
