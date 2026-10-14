import { useEffect, useMemo, useRef, useState } from "react";
import type { ImagePromptCard, ImagePromptDetail, ImagePromptLang, ImagePromptMeta } from "@shared/types";
import { Icon } from "../Icon";
import { Tag } from "../plugins/ui";
import { cleanError } from "../settings/ui";
import { categoryName, flagInfo, langName, licenseInfo, modelName, safeHref, splitVars } from "./labels";
import { useModalFocus } from "./useModalFocus";

interface Props {
  card: ImagePromptCard;
  meta: ImagePromptMeta | null;
  src: string | undefined;
  favorite: boolean;
  onClose(): void;
  onFavorite(card: ImagePromptCard): void;
  /** 复制一段（lang、step 都省略就是复制全部）。成功时返回字数。 */
  onCopy(id: string, lang?: ImagePromptLang, step?: number): Promise<number>;
}

// 右侧抽屉：完整提示词、分步复制、出处和许可。所有来自数据的文字都是纯文本节点，正文放 <pre>。
export function PromptDetail({ card, meta, src, favorite, onClose, onFavorite, onCopy }: Props) {
  const [detail, setDetail] = useState<ImagePromptDetail | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [lang, setLang] = useState<ImagePromptLang | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [copyError, setCopyError] = useState("");

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError("");
    setLang(null);
    window.sweet.imagePromptGet(card.id).then((d) => { if (live) setDetail(d); }, (e) => { if (live) setError(cleanError(e)); });
    return () => { live = false; };
  }, [card.id]);

  const box = useRef<HTMLElement>(null);
  useModalFocus(box, onClose);

  useEffect(() => {
    if (!copiedKey) return;
    const t = window.setTimeout(() => setCopiedKey(""), 1800);
    return () => window.clearTimeout(t);
  }, [copiedKey]);

  const variant = detail ? (detail.variants.find((v) => v.lang === lang) ?? detail.variants[0]) : undefined;
  const shownLang = variant?.lang;

  async function copy(key: string, lang?: ImagePromptLang, step?: number) {
    setCopyError("");
    try { await onCopy(card.id, lang, step); setCopiedKey(key); } catch (e) { setCopyError(cleanError(e)); }
  }

  const sourceName = (id: string) => meta?.sources.find((s) => s.id === id)?.name ?? "未知来源库";
  const lic = licenseInfo(card.license);
  const postHref = safeHref(detail?.sourceUrl);
  const repoHref = safeHref(meta?.sources.find((s) => s.id === card.source)?.repoUrl);
  const multi = (variant?.steps.length ?? 0) > 1;
  const modelText = useMemo(() => {
    const base = card.models.map((m) => modelName(m)).join("、");
    return detail?.modelExact ? (base ? `${base}（${detail.modelExact}）` : detail.modelExact) : base;
  }, [card.models, detail?.modelExact]);

  return (
    <div className="ipl-drawer-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ipl-drawer" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={card.title}>
        <header className="ipl-drawer-bar">
          <span className="ipl-cat">{categoryName(card.category)}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn square" onClick={onClose} aria-label="关闭详情"><Icon name="close" /></button>
        </header>
        <div className="ipl-drawer-body">
          {card.hasThumb && (
            <div className="ipl-hero" style={card.thumbW && card.thumbH ? { aspectRatio: `${card.thumbW} / ${card.thumbH}` } : undefined}>
              {src ? <img src={src} alt="" decoding="async" /> : <span className="ipl-shimmer" aria-hidden="true" />}
            </div>
          )}
          <div className="ipl-d-title">
            <h2>{card.title}</h2>
            {card.titleEn && card.titleEn !== card.title && <p>{card.titleEn}</p>}
          </div>
          <div className="ipl-d-actions">
            <button type="button" className="send rs-accent" onClick={() => void copy("all", shownLang)} disabled={!detail}>
              <Icon name={copiedKey === "all" ? "check" : "copy"} /> {copiedKey === "all" ? "已复制" : multi ? "复制全部步骤" : "复制提示词"}
            </button>
            <button type="button" className={"mini-btn" + (favorite ? " on" : "")} aria-pressed={favorite} onClick={() => onFavorite(card)}>
              <Icon name="heart" /> {favorite ? "已收藏" : "收藏"}
            </button>
            {postHref && <a className="mini-btn ipl-a-btn" href={postHref} target="_blank" rel="noreferrer"><Icon name="globe" /> 看原帖</a>}
          </div>
          {copyError && <p className="err-text">{copyError}</p>}

          {detail === undefined && !error && <div className="ipl-d-loading"><span className="ipl-shimmer" aria-hidden="true" /><span className="ipl-sr">加载中</span></div>}
          {error && <p className="err-text">{error}</p>}
          {detail === null && <p className="ipl-d-note">这条提示词找不到了，可能数据已经更新。关掉后刷新一下列表试试。</p>}

          {detail && variant && (
            <section className="ipl-prompt" aria-label="提示词正文">
              <div className="ipl-prompt-head">
                <h3>提示词</h3>
                {detail.variants.length > 1 && (
                  <div className="seg" role="radiogroup" aria-label="语言">
                    {detail.variants.map((v) => (
                      <button key={v.lang} type="button" role="radio" aria-checked={v.lang === shownLang} className={v.lang === shownLang ? "on" : undefined} onClick={() => setLang(v.lang)}>
                        {langName(v.lang)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {detail.hasVars && <p className="ipl-d-note">带方括号的地方是可以换成你自己内容的部分，复制后改一改再用。</p>}
              {variant.steps.map((s, i) => {
                const key = `${variant.lang}-${i}`;
                return (
                  <div key={key} className="ipl-step">
                    {multi && (
                      <div className="ipl-step-head">
                        <b>第 {i + 1} 步{s.label ? `：${s.label}` : ""}</b>
                        <button type="button" className="mini-btn" onClick={() => void copy(key, variant.lang, i)}>
                          <Icon name={copiedKey === key ? "check" : "copy"} /> {copiedKey === key ? "已复制" : "复制这一步"}
                        </button>
                      </div>
                    )}
                    <pre className="ipl-pre">
                      {detail.hasVars ? splitVars(s.text).map((p, j) => (p.v ? <mark key={j} className="ipl-var">{p.text}</mark> : p.text)) : s.text}
                    </pre>
                  </div>
                );
              })}
            </section>
          )}

          {card.flags.length > 0 && (
            <section className="ipl-notice" aria-label="内容提示">
              <h3><Icon name="warning" /> 使用前留意</h3>
              <ul>{card.flags.map((f) => <li key={f}><b>{flagInfo(f).label}</b>{flagInfo(f).hint}</li>)}</ul>
            </section>
          )}

          <dl className="ipl-facts">
            <dt>适用模型</dt><dd>{modelText || "没有标明"}</dd>
            {(card.ratio || detail?.size) && (<><dt>画幅</dt><dd>{[card.ratio && `比例 ${card.ratio}`, detail?.size && `尺寸 ${detail.size}`].filter(Boolean).join("　")}</dd></>)}
            <dt>要不要参考图</dt><dd>{card.needsReference ? "要，生成时需要先上传一张图" : "不用，直接用文字就能生成"}</dd>
            {card.author && (<><dt>作者</dt><dd>{card.author}</dd></>)}
            <dt>来源库</dt>
            <dd>
              {sourceName(card.source)}
              {repoHref && <> · <a className="ipl-link" href={repoHref} target="_blank" rel="noreferrer">打开来源库</a></>}
              {card.thirdParty && <span className="ipl-fact-note">这是来源库转载的他人内容，版权属于原作者。</span>}
            </dd>
            <dt>许可</dt>
            <dd>
              <Tag tone={lic.warn ? "warn" : "ok"} title={lic.hint}>{lic.label}</Tag>
              <span className="ipl-fact-note">{lic.hint}</span>
              {detail?.attribution && <span className="ipl-fact-note ipl-attr"><b>署名写法：</b>{detail.attribution}</span>}
            </dd>
            {detail && detail.alsoIn.length > 0 && (<><dt>也收录于</dt><dd>{detail.alsoIn.map(sourceName).join("、")}</dd></>)}
          </dl>

          {card.tags.length > 0 && (
            <ul className="ipl-tags" aria-label="标签">{card.tags.map((t) => <li key={t}>{t}</li>)}</ul>
          )}
        </div>
      </aside>
    </div>
  );
}
