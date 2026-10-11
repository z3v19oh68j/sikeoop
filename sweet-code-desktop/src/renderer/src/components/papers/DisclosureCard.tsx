import { useState } from "react";
import type { DisclosureDraft, WritingAction } from "@shared/types";
import { Icon } from "../Icon";
import { cleanError } from "./common";
import { ACTION_LABEL } from "./actions";

/** What was counted, in a line the user can check against their memory. */
function factsLine(d: DisclosureDraft): string {
  const f = d.facts;
  const writing = (Object.entries(f.writing) as [WritingAction, number][]).filter(([, n]) => n > 0).map(([a, n]) => `${ACTION_LABEL[a]} ${n} 次`);
  const parts = [
    f.translatedPapers && `翻译 ${f.translatedPapers} 篇`,
    f.summarizedPapers && `总结 ${f.summarizedPapers} 篇`,
    f.evidenceRepositories && `证据库 ${f.evidenceRepositories} 个`,
    ...writing,
    f.reviews && `模拟审稿 ${f.reviews} 次`,
    f.ideaRuns && `选题 ${f.ideaRuns} 次`,
    f.noveltyChecks && `新颖性检查 ${f.noveltyChecks} 个点子`,
    f.researchRuns && `深度研判 ${f.researchRuns} 次`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "还没有记录";
}

/**
 * AI 使用声明: a paragraph for the methods or acknowledgements section, drafted from what this
 * project actually used in the workshop and in deep research. The user edits it before use.
 */
export function DisclosureCard({ onUse }: { onUse(text: string): void }) {
  const [draft, setDraft] = useState<DisclosureDraft | null>(null);
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    setError("");
    setBusy(true);
    try {
      const d = await window.sweet.paperDisclosure();
      setDraft(d);
      setText(d[lang]);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-card pp-disclosure">
      <header className="rs-card-head">
        <Icon name="shield-check" />
        <h3>AI 使用声明</h3>
        <span className="spacer" />
        {draft && (
          <div className="seg" role="radiogroup" aria-label="声明的语言">
            {(["zh", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={lang === l}
                className={lang === l ? "on" : undefined}
                onClick={() => {
                  setLang(l);
                  setText(draft[l]);
                }}
              >
                {l === "zh" ? "中文" : "English"}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void generate()}>
          {busy ? "正在统计…" : draft ? "重新生成" : "按使用记录生成"}
        </button>
      </header>
      <p className="hint">很多期刊和会议要求说明用 AI 做了什么。这里按本项目在论文工坊和深度科研里的实际使用记录，拼一段可以放进方法或致谢里的说明，你再改成自己的话。</p>
      {error && <p className="err-text">{error}</p>}
      {draft && (
        <>
          <p className="hint">记录到的使用：{factsLine(draft)}</p>
          <textarea className="rs-textarea pp-input" rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="AI 使用声明草稿" />
          <div className="rs-actions">
            <span className="hint">只统计了在 sikeoop 里的使用；润色、纠错这类写作功能从这个版本起才开始计数。在别处用过的 AI 工具请自己补上，并以投稿期刊的要求为准。</span>
            <span className="spacer" />
            <button type="button" className="mini-btn" onClick={() => onUse(text)} title="放进上面的输入框，可以接着润色或翻译">
              放进输入框
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() =>
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Icon name={copied ? "check" : "copy"} /> {copied ? "已复制" : "复制"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
