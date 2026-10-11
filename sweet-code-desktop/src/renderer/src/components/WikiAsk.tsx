import { type RefObject, useEffect, useRef, useState } from "react";
import type { ProviderView } from "@shared/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { isReady } from "./ProviderDialog";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const MODEL_KEY = "sweet:wiki-ask-provider";
function savedProvider(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

export interface AskItem {
  question: string;
  quote?: string;
  answer?: string;
  model?: string;
  error?: string;
}

interface Props {
  pageId?: string;
  providers: ProviderView[];
  activeId: string;
  /** The page's text, where selecting a passage offers to ask about it. */
  pageRef: RefObject<HTMLElement | null>;
  /** The scrolling column, to keep the newest answer in view. */
  scrollRef: RefObject<HTMLElement | null>;
  items: AskItem[];
  onItems(update: (items: AskItem[]) => AskItem[]): void;
}

/**
 * Questions about the wiki: select a passage in the page to quote it, pick any configured
 * model, ask. Answers show under the page, per page.
 */
export function WikiAsk({ pageId, providers, activeId, pageRef, scrollRef, items, onItems }: Props) {
  const ready = providers.filter(isReady);
  const [providerId, setProviderId] = useState(() => savedProvider() ?? activeId);
  const chosen = ready.find((p) => p.id === providerId) ?? ready.find((p) => p.id === activeId) ?? ready[0];
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  /** A selection in the page, with where to show the "ask about this" button. */
  const [picked, setPicked] = useState<{ text: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Selecting text in the page offers a button next to it.
  useEffect(() => {
    const page = pageRef.current;
    const scroller = scrollRef.current;
    if (!page || !scroller) return;
    const onUp = () => {
      // Let the browser settle the selection after the click first.
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || sel.rangeCount === 0 || !page.contains(sel.anchorNode)) return setPicked(null);
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        setPicked({ text, x: r.left - box.left + r.width / 2, y: r.top - box.top + scroller.scrollTop - 6 });
      });
    };
    page.addEventListener("mouseup", onUp);
    return () => page.removeEventListener("mouseup", onUp);
  }, [pageRef, scrollRef, pageId]);

  useEffect(() => {
    setPicked(null);
    setQuote("");
  }, [pageId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && items.length) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items, scrollRef]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy || !chosen) return;
    const item: AskItem = { question, quote: quote || undefined };
    const history = items.filter((i) => i.answer).map((i) => ({ question: i.question, answer: i.answer! }));
    onItems((list) => [...list, item]);
    setInput("");
    setQuote("");
    setBusy(true);
    try {
      const res = await window.sweet.wikiAsk({ pageId, question, quote: item.quote, providerId: chosen.id, history });
      onItems((list) => list.map((i) => (i === item ? { ...i, answer: res.answer, model: res.model } : i)));
    } catch (e) {
      onItems((list) => list.map((i) => (i === item ? { ...i, error: cleanError(e) } : i)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {picked && (
        <button
          type="button"
          className="wiki-quote-btn"
          style={{ left: picked.x, top: picked.y }}
          // Keep the selection while clicking.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuote(picked.text);
            setPicked(null);
            window.getSelection()?.removeAllRanges();
            inputRef.current?.focus();
          }}
        >
          <Icon name="thought" /> 就这段提问
        </button>
      )}

      {items.length > 0 && (
        <section className="wiki-qa" aria-label="问答">
          {items.map((it, i) => (
            <div key={i} className="wiki-qa-item">
              <div className="q">
                {it.quote && <blockquote>{it.quote}</blockquote>}
                {it.question}
              </div>
              {it.answer ? (
                <div className="a">
                  <Markdown text={it.answer} />
                  <span className="wiki-note">{it.model}</span>
                </div>
              ) : it.error ? (
                <p className="wiki-warn bad">{it.error}</p>
              ) : (
                <p className="wiki-note">正在思考…</p>
              )}
            </div>
          ))}
        </section>
      )}

      <form
        className="composer wiki-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="composer-box">
          {quote && (
            <div className="ctx-chips">
              <span className="ctx-chip" title={quote}>
                <Icon name="thought" />
                <span>引用：{quote}</span>
                <button type="button" className="chip-x" aria-label="去掉引用" onClick={() => setQuote("")}>
                  <Icon name="close" />
                </button>
              </span>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            placeholder={quote ? "关于选中的这段，想问什么？" : "问问这个项目，或先在上面选中一段文字再提问"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="row">
            <span className="select-pill">
              <select
                value={chosen?.id ?? ""}
                disabled={!ready.length}
                aria-label="回答用的模型"
                title="选择回答用的模型（在设置里配置好的服务商）"
                onChange={(e) => {
                  setProviderId(e.target.value);
                  try {
                    localStorage.setItem(MODEL_KEY, e.target.value);
                  } catch {
                    // Not remembered this time.
                  }
                }}
              >
                {ready.length ? (
                  ready.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))
                ) : (
                  <option value="">先在设置里配置模型</option>
                )}
              </select>
              <Icon name="chevron-down" />
            </span>
            <span className="spacer" />
            {busy ? (
              <button type="button" className="stop-btn" onClick={() => void window.sweet.wikiAskCancel()}>
                停下
              </button>
            ) : (
              <button type="submit" className="send-btn" aria-label="提问" title="提问（Enter）" disabled={!input.trim() || !chosen}>
                <Icon name="arrow-up" />
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  );
}
