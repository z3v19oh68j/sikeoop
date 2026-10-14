import { useRef } from "react";
import type { ImagePromptMeta } from "@shared/types";
import { Icon } from "../Icon";
import { Tag } from "../plugins/ui";
import { licenseInfo, safeHref } from "./labels";
import { useModalFocus } from "./useModalFocus";

// 「来源与许可」：这些提示词是从哪些开源仓库整理来的，各自能怎么用。
export function SourcesDialog({ meta, onClose }: { meta: ImagePromptMeta; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box, onClose);
  return (
    <div className="modal-back ipl-dialog-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ipl-dialog" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="来源与许可">
        <header className="ipl-dialog-head">
          <h2>来源与许可</h2>
          <button type="button" className="icon-btn square" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>
        <p className="ipl-dialog-lead">这里的提示词都是别人公开分享的，sikeoop 只是帮你整理。用的时候请留意每个来源的许可；要署名的，请按下面的写法署名。</p>
        <ul className="ipl-sources">
          {meta.sources.map((s) => {
            const href = safeHref(s.repoUrl);
            const lic = licenseInfo(s.license);
            return (
              <li key={s.id} className="ipl-source">
                <div className="ipl-source-top">
                  <b>{s.name}</b>
                  <Tag tone={lic.warn ? "warn" : "ok"} title={lic.hint}>{lic.label}</Tag>
                  <span className="ipl-source-count">{s.count} 条</span>
                </div>
                <p className="ipl-source-hint">{s.licenseNote || lic.hint}</p>
                {s.attribution && <p className="ipl-source-attr"><span>署名要求</span>{s.attribution}</p>}
                {href ? (
                  <a className="ipl-link" href={href} target="_blank" rel="noreferrer"><Icon name="globe" /> 打开来源库</a>
                ) : (
                  <span className="ipl-nolink">没有可用的链接</span>
                )}
              </li>
            );
          })}
          {meta.sources.length === 0 && <li className="ipl-source"><p className="ipl-source-hint">还没有来源信息。</p></li>}
        </ul>
      </div>
    </div>
  );
}
