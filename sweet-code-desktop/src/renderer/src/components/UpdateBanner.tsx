import { Suspense, lazy, useEffect, useState } from "react";
import type { UpdateState } from "@shared/types";
import { Icon } from "./Icon";
import { useSkin } from "../skin";
import "../styles/update.css";

// The EVA × MIKU skin has its own card; loaded only when that skin is on (its own chunk and CSS).
const EvaUpdateCard = lazy(() => import("./update/EvaUpdateCard").then((m) => ({ default: m.EvaUpdateCard })));

/**
 * A small card in the corner when a newer version exists (main/updater.ts). Windows: it downloads by
 * itself, then offers「重启更新」(or installs on the next quit). macOS / portable: a link to the
 * download page. Closing it hides it until a different version shows up.
 */
export function UpdateBanner() {
  const [s, setS] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    void window.sweet.updateState().then(setS);
    return window.sweet.onUpdateChanged(setS);
  }, []);

  const skin = useSkin();
  if (s && skin.id === "eva-miku")
    return (
      <Suspense fallback={null}>
        <EvaUpdateCard state={s} onState={setS} />
      </Suspense>
    );

  if (!s?.version || dismissed === s.version) return null;
  if (s.status !== "available" && s.status !== "downloading" && s.status !== "ready") return null;

  const title =
    s.status === "ready" ? `sikeoop ${s.version} 已经下好了` : s.status === "downloading" ? `正在下载 ${s.version}` : `有新版本 ${s.version}`;
  return (
    <aside className="update-card" role="status" aria-live="polite">
      <span className="update-icon">
        <Icon name="rocket" />
      </span>
      <div className="update-body">
        <b>{title}</b>
        {s.status === "downloading" && (
          <div className="update-bar" aria-label={`已下载 ${s.percent ?? 0}%`}>
            <div style={{ width: `${s.percent ?? 0}%` }} />
          </div>
        )}
        {s.status === "ready" && <span>重启就换成新版本，不重启的话下次退出时自动装上。</span>}
        {s.status === "available" && !s.canInstall && <span>这个版本不能自己替换，去官网下新的安装包就行（设置和对话都会保留）。</span>}
        {s.notes && <p className="update-notes">{s.notes}</p>}
        <div className="update-actions">
          {s.status === "ready" && (
            <button type="button" className="neu-btn primary" onClick={() => void window.sweet.updateInstall()}>
              重启更新
            </button>
          )}
          {s.status === "available" && !s.canInstall && (
            <button type="button" className="neu-btn primary" onClick={() => void window.sweet.updateOpenDownload()}>
              去下载
            </button>
          )}
          <button type="button" className="neu-btn" onClick={() => setDismissed(s.version ?? null)}>
            {s.status === "ready" ? "稍后" : "知道了"}
          </button>
        </div>
      </div>
    </aside>
  );
}
