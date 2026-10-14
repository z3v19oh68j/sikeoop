import { memo } from "react";
import type { ImagePromptCard } from "@shared/types";
import { Icon } from "../Icon";
import { categoryName, flagInfo, modelName } from "./labels";

const TONE: Record<string, string> = {
  portrait: "accent", poster: "warn", product: "ok", ui: "accent", infographic: "ok", illustration: "warn",
  character: "accent", photo: "muted", brand: "warn", space: "ok", edit: "muted", fun: "accent", other: "muted",
};

/** 图片区的宽高比：照缩略图来，但夹在 3:4 到 4:3 之间，免得太高太扁。 */
const ratioOf = (c: ImagePromptCard) => {
  if (!c.thumbW || !c.thumbH) return 4 / 3;
  return Math.min(4 / 3, Math.max(3 / 4, c.thumbW / c.thumbH));
};

interface Props {
  card: ImagePromptCard;
  src: string | undefined;
  observe: (el: HTMLElement | null) => void | (() => void);
  copied: boolean;
  onOpen(id: string): void;
  onFavorite(card: ImagePromptCard): void;
  onCopy(card: ImagePromptCard): void;
}

// 卡片整张是一个「打开详情」的按钮，收藏和复制浮在上面。所有文字都是纯文本节点。
export const PromptCard = memo(function PromptCard({ card, src, observe, copied, onOpen, onFavorite, onCopy }: Props) {
  const tone = TONE[card.category] ?? "muted";
  const hasImage = card.hasThumb;
  const mainModel = card.models[0];
  return (
    <li className={"ipl-card ipl-tone-" + tone + (hasImage ? "" : " text-only")}>
      <button type="button" className="ipl-open" onClick={() => onOpen(card.id)} aria-label={`查看详情：${card.title}`} />
      <div className="ipl-media" style={hasImage ? { aspectRatio: String(ratioOf(card)) } : undefined} data-tid={hasImage ? card.id : undefined} ref={hasImage ? observe : undefined}>
        {hasImage ? (
          src ? <img src={src} alt="" decoding="async" draggable={false} width={card.thumbW} height={card.thumbH} /> : <span className="ipl-shimmer" aria-hidden="true" />
        ) : (
          <>
            <span className="ipl-quote" aria-hidden="true">“</span>
            <p className="ipl-snippet">{card.excerpt}</p>
          </>
        )}
        {(card.multiStep || card.needsReference) && (
          <span className="ipl-badges">
            {card.multiStep && <span className="ipl-badge">分步骤</span>}
            {card.needsReference && <span className="ipl-badge">要参考图</span>}
          </span>
        )}
      </div>
      <div className="ipl-info">
        <h3 className="ipl-title">{card.title}</h3>
        {hasImage && <p className="ipl-excerpt">{card.excerpt}</p>}
        <div className="ipl-meta">
          <span className="ipl-cat">{categoryName(card.category)}</span>
          {mainModel && <span>{modelName(mainModel)}</span>}
          {card.langs.length > 1 && <span>中英</span>}
          {card.flags.length > 0 && (
            <span className="ipl-flag" title={card.flags.map((f) => flagInfo(f).label).join("、")}>
              <Icon name="warning" />
              {flagInfo(card.flags[0]).label}
              {card.flags.length > 1 ? ` 等${card.flags.length}项` : ""}
            </span>
          )}
        </div>
        {card.author && <p className="ipl-author">{card.author}</p>}
      </div>
      <div className="ipl-ops">
        <button type="button" className={"ipl-op" + (card.favorite ? " on" : "")} onClick={() => onFavorite(card)} aria-pressed={card.favorite} aria-label={card.favorite ? "取消收藏" : "收藏"} title={card.favorite ? "取消收藏" : "收藏"}>
          <Icon name="heart" />
        </button>
        <button type="button" className={"ipl-op" + (copied ? " done" : "")} onClick={() => onCopy(card)} aria-label="复制提示词" title="复制提示词">
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
    </li>
  );
});
