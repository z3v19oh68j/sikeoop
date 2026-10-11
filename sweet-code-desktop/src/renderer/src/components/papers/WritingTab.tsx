import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PromptPreset, WritingAction, WritingRequest, WritingResult } from "@shared/types";
import { diffLines } from "@shared/diff";
import { Icon } from "../Icon";
import { cleanError } from "./common";
import { PresetsPanel } from "./PresetsPanel";
import { ACTIONS, ACTION_LABEL } from "./actions";
import { DisclosureCard } from "./DisclosureCard";

/** These rewrite the same text, so a before/after diff makes sense; the others produce new text. */
const DIFFABLE = new Set<WritingAction>(["polish_zh", "polish_en", "proofread", "shorten", "expand"]);

type Format = WritingRequest["format"];

interface Props {
  editorSelection?: string;
  /** A passage and what to change in it, handed over from 模拟审稿. `at` tells two hand-overs apart. */
  seed?: { text: string; note: string; at: number };
  /** A citation from 引用与排版, put where the cursor is in the input. */
  insert?: { text: string; at: number };
}

export function WritingTab({ editorSelection, seed, insert }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [citing, setCiting] = useState(false);
  const [citeError, setCiteError] = useState("");
  const [text, setText] = useState("");
  /** An extra requirement for the next run (a reviewer's comment to answer). */
  const [note, setNote] = useState("");
  const [format, setFormat] = useState<Format>("plain");
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ action: WritingAction; label: string; before: string; out: WritingResult } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  useEffect(() => {
    void window.sweet.promptPresets().then(setPresets);
  }, []);

  /** Puts text at the input's cursor (over its selection), or at the end when it was never focused. */
  function insertAtCursor(piece: string) {
    const el = input.current;
    const from = el ? el.selectionStart : text.length;
    const to = el ? el.selectionEnd : text.length;
    setText((cur) => cur.slice(0, from) + piece + cur.slice(to));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + piece.length, from + piece.length);
    });
  }

  useEffect(() => {
    if (insert) insertAtCursor(insert.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.at]);

  /** Zotero's own picker; the citation lands at the cursor in Pandoc's `[@key]` form. */
  async function citeFromZotero() {
    setCiteError("");
    setCiting(true);
    try {
      const picked = await window.sweet.zoteroPick("pandoc");
      if (picked) insertAtCursor(picked.text);
    } catch (e) {
      setCiteError(cleanError(e) + "（到「引用与排版」里可以看 Zotero 的连接状态）");
    } finally {
      setCiting(false);
    }
  }

  useEffect(() => {
    if (!seed) return;
    // No passage found for the comment: what is already here stays, the user pastes the right one.
    if (seed.text) setText(seed.text);
    setNote(seed.note);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.at]);

  const preset = presets.find((p) => p.id === presetId);
  const extras = presets.filter((p) => !p.action);

  async function run(action: WritingAction, label: string, useId?: string) {
    if (!text.trim()) return;
    setError("");
    setRunning(useId ?? action);
    try {
      const out = await window.sweet.writingRun({ action, text, format, presetId: useId, note: note.trim() || undefined });
      setResult({ action, label, before: text, out });
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="pp-writing">
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="file" />
          <h3>要处理的文字</h3>
          <span className="spacer" />
          {editorSelection?.trim() && (
            <button type="button" className="mini-btn" onClick={() => setText(editorSelection)} title="把编辑器里选中的文字放进来">
              载入编辑器选中的文字
            </button>
          )}
        </header>
        <textarea
          ref={input}
          className="rs-textarea pp-input"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="把要润色、纠错或翻译的段落粘贴到这里。"
          aria-label="要处理的文字"
        />
        <div className="rs-actions">
          <span className="rs-label">格式</span>
          <div className="seg" role="radiogroup" aria-label="格式">
            {(
              [
                ["plain", "纯文本"],
                ["markdown", "Markdown"],
                ["latex", "LaTeX"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={format === id} className={format === id ? "on" : undefined} onClick={() => setFormat(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="hint">{format === "latex" ? "命令、公式和引用键会原样保留。" : format === "markdown" ? "标题、列表、链接等格式会保留。" : ""}</span>
          <span className="spacer" />
          <button type="button" className="mini-btn" disabled={citing} onClick={() => void citeFromZotero()} title="调起 Zotero 的引用选择框，把 [@key] 插到光标处">
            {citing ? "到 Zotero 里选文献…" : "从 Zotero 插入引用"}
          </button>
          <span className="hint">{[...text].length} 字</span>
        </div>
        {citeError && <p className="err-text">{citeError}</p>}
        {note && (
          <div className="rs-field pp-note">
            <span className="rs-label">这次的修改要求（来自模拟审稿，可以改）</span>
            <textarea className="rs-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label="这次的修改要求" />
            <div className="rs-actions">
              <span className="hint">{text.trim() ? "下面任选一种处理方式，模型会按这条要求来改；改完看对照再决定用不用。" : "没有找到这条意见对应的段落：把要改的段落粘贴到上面。"}</span>
              <span className="spacer" />
              <button type="button" className="mini-btn" onClick={() => setNote("")}>
                不用这条要求了
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="sparkle" />
          <h3>怎么处理</h3>
          <span className="spacer" />
          <label className="pp-preset-pick">
            <span className="hint">提示词</span>
            <select className="rs-select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">默认（sikeoop 自带）</option>
              {presets
                .filter((p) => p.action)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（用于「{ACTION_LABEL[p.action!]}」）
                  </option>
                ))}
            </select>
          </label>
          <button type="button" className={"mini-btn" + (showPresets ? " on" : "")} onClick={() => setShowPresets(!showPresets)}>
            管理预设
          </button>
        </header>
        <div className="pp-actions">
          {ACTIONS.map((a) => {
            const custom = preset?.action === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={"pp-action" + (custom ? " custom" : "")}
                disabled={!text.trim() || !!running}
                onClick={() => void run(a.id, custom ? `${a.label} · ${preset!.name}` : a.label, custom ? preset!.id : undefined)}
                title={custom ? `用预设「${preset!.name}」` : a.hint}
              >
                <b>{running === a.id || (custom && running === preset!.id) ? "处理中…" : a.label}</b>
                <span>{custom ? `预设：${preset!.name}` : a.hint}</span>
              </button>
            );
          })}
          {extras.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pp-action extra"
              disabled={!text.trim() || !!running}
              onClick={() => void run("polish_zh", p.name, p.id)}
              title={`用预设「${p.name}」处理`}
            >
              <b>{running === p.id ? "处理中…" : p.name}</b>
              <span>{p.origin === "gpt_academic" ? "gpt_academic · GPL-3.0" : p.origin === "user" ? "我的预设" : "预设"}</span>
            </button>
          ))}
        </div>
        {!text.trim() && <p className="hint">先在上面放进要处理的文字。</p>}
        {error && <p className="err-text">{error}</p>}
      </section>

      {showPresets && <PresetsPanel presets={presets} onPresets={setPresets} />}

      {result && (
        <section className="rs-card pp-result">
          <header className="rs-card-head">
            <Icon name="check-circle" />
            <h3>结果 · {result.label}</h3>
            <span className="spacer" />
            <button
              type="button"
              className="mini-btn"
              onClick={() =>
                void navigator.clipboard.writeText(result.out.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Icon name={copied ? "check" : "copy"} /> {copied ? "已复制" : "复制结果"}
            </button>
            <button type="button" className="send rs-accent" onClick={() => setText(result.out.text)}>
              用结果替换输入
            </button>
          </header>
          {DIFFABLE.has(result.action) ? <ProseDiff before={result.before} after={result.out.text} /> : <div className="pp-result-text">{result.out.text}</div>}
          {result.out.notes && (
            <div className="pp-notes">
              <div className="rs-label">改了什么</div>
              <ul>
                {result.out.notes
                  .split(/\n+/)
                  .map((n) => n.replace(/^[-*•\d.、\s]+/, "").trim())
                  .filter(Boolean)
                  .map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <DisclosureCard onUse={setText} />
    </div>
  );
}

/** Before / after with removed and added words marked (shared/diff.ts word marks). */
function ProseDiff({ before, after }: { before: string; after: string }) {
  if (before === after) return <p className="hint">没有改动。</p>;
  const d = diffLines(before, after);
  return (
    <div className="pp-diff" aria-label="修改对照">
      <div className="pp-diff-legend">
        <span className="del">删掉的</span>
        <span className="add">加上的</span>
        <span className="hint">
          {d.removed} 行改动前 · {d.added} 行改动后
        </span>
      </div>
      {d.hunks.map((h, i) => (
        <div key={i} className="pp-hunk">
          {h.before && h.before.count > 0 && <div className="pp-fold">…… 中间 {h.before.count} 行没有改动</div>}
          {h.lines.map((l, j) => (
            <div key={j} className={"pp-line " + l.kind}>
              <span className="pp-sign" aria-hidden="true">
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              <span className="pp-text">{marked(l.text, l.marks)}</span>
            </div>
          ))}
        </div>
      ))}
      {d.truncated && <p className="hint">改动太多，只显示了前面一部分。</p>}
    </div>
  );
}

function marked(text: string, marks?: [number, number][]) {
  if (!marks?.length) return text || " ";
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
