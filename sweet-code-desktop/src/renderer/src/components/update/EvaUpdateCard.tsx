import { useEffect, useState } from "react";
import type { UpdateState } from "@shared/types";
import { noteRows, type NoteIcon } from "./notes";
import { ReleaseNotes } from "./ReleaseNotes";
import "../../styles/update-card.css";

// The EVA × MIKU skin's update card (design kit: design/sikeoop-eva-miku-update-card-svg-v1).
// Laid out in the kit's own 1360×912 coordinates and scaled down as a whole (about half size).
// Frames, decorations, button bases, toggle and progress track are the kit's SVGs (CSS backgrounds);
// icons are inlined so they take the state color; text, version, progress and buttons are live data.
// Loaded lazily from UpdateBanner only when this skin is on, so the default skin never pays for it.

const W = 1360;
const H = 912;

const RAW = import.meta.glob<string>("../../skins/eva-miku/update/icons/*.svg", { eager: true, query: "?raw", import: "default" });
const ICONS: Record<string, string> = {};
for (const [p, svg] of Object.entries(RAW)) {
  const name = p.slice(p.lastIndexOf("/") + 1, -4);
  // Drop the kit's shared <defs> (same ids in every file) and let single-color icons follow `color`.
  ICONS[name] =
    name === "sikeoop-crystal"
      ? svg.replace(/<title>.*?<\/title>|<desc>.*?<\/desc>|<defs>[\s\S]*?<\/defs>/g, "")
      : svg.replace(/<title>.*?<\/title>|<desc>.*?<\/desc>|<defs>[\s\S]*?<\/defs>/g, "").replace(/(stroke|fill)="#5CE1E6"/gi, '$1="currentColor"');
}
const HERO = Object.values(import.meta.glob<string>("../../skins/eva-miku/update/illustrations/hero-eva-miku-paths.svg", { eager: true, query: "?url", import: "default" }))[0];

function KitIcon({ name, className }: { name: string; className?: string }) {
  return <span className={"euc-icon" + (className ? ` ${className}` : "")} aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? "" }} />;
}

type Shown = "checking" | "available" | "downloading" | "ready" | "installing" | "error";

interface Look {
  title: string;
  subtitle: string;
  badge: string;
  tone: "lime" | "cyan" | "violet" | "bad";
  barLabel: string;
  /** null = indeterminate */
  percent: number | null;
}

function lookOf(s: UpdateState, shown: Shown): Look {
  const v = s.version ? ` ${s.version}` : "";
  switch (shown) {
    case "checking":
      return { title: "正在检查更新", subtitle: "正在获取版本信息，请稍候。", badge: "CHECKING", tone: "violet", barLabel: "检查中", percent: null };
    case "available":
      return {
        title: "发现新版本",
        subtitle: !s.canInstall
          ? "这个版本不能自己替换，去官网下新的安装包就行，设置和对话都会保留。"
          : s.autoDownload
            ? `新版本${v} 马上开始在后台下载。`
            : `新版本${v} 可以下载了，下载在后台进行，不影响工作。`,
        badge: "AVAILABLE",
        tone: "cyan",
        barLabel: "等待下载",
        percent: 0,
      };
    case "downloading":
      return { title: "正在下载更新", subtitle: "正在后台下载，不影响当前工作。", badge: "DOWNLOADING", tone: "cyan", barLabel: "下载中", percent: Math.round(s.percent ?? 0) };
    case "ready":
      return {
        title: "更新已就绪",
        subtitle: `${s.autoDownload ? "已自动下载" : "已下载好"}，重启即可使用新版本；不重启的话下次退出时自动装上。`,
        badge: "READY",
        tone: "lime",
        barLabel: "下载完成",
        percent: 100,
      };
    case "installing":
      return { title: "正在重启安装", subtitle: "sikeoop 会自己关掉再打开，请稍候。", badge: "INSTALLING", tone: "cyan", barLabel: "安装中", percent: null };
    case "error":
      return { title: "更新失败", subtitle: "这次没更新成功，可以再试一次。", badge: "ERROR", tone: "bad", barLabel: "下载中断", percent: Math.round(s.percent ?? 0) };
  }
}

const BADGE_ICON: Record<Look["tone"], string> = { lime: "shield-check", cyan: "download", violet: "activity", bad: "warning" };

/** Fit the 1360×912 design into the window: about half size, smaller on narrow windows. */
function useScale(): number {
  const calc = () => Math.max(0.2, Math.min(0.5, (window.innerWidth - 36) / W, (window.innerHeight - 64) / H));
  const [s, setS] = useState(calc);
  useEffect(() => {
    const on = () => setS(calc());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return s;
}

interface Props {
  state: UpdateState;
  onState(s: UpdateState): void;
}

export function EvaUpdateCard({ state: s, onState }: Props) {
  const scale = useScale();
  /** Dismissed for this version + state; it comes back when the state moves on or next launch. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** The user acted on the card (retry / download): show checking and errors from then on.
   * Without that, a background check only shows when it is about an update already found. */
  const [engaged, setEngaged] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const [busy, setBusy] = useState(false);

  const shown: Shown | null =
    s.status === "available" || s.status === "downloading" || s.status === "ready" || s.status === "installing"
      ? s.status
      : s.status === "checking" && (engaged || !!s.version)
        ? "checking"
        : s.status === "error" && (engaged || !!s.version)
          ? "error"
          : null;
  const key = `${s.version ?? ""}:${shown}`;
  if (!shown || dismissed === key) return null;

  const look = lookOf(s, shown);
  const rows = noteRows(s.notes);
  const later = () => setDismissed(key);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  let primary: { label: string; icon: string; run?: () => void; disabled?: boolean };
  if (shown === "ready") primary = { label: "重启并更新", icon: "restart", run: () => act(() => window.sweet.updateInstall()) };
  else if (shown === "installing") primary = { label: "安装中", icon: "install", disabled: true };
  else if (shown === "checking") primary = { label: "请稍候", icon: "clock", disabled: true };
  else if (shown === "downloading") primary = { label: "后台继续", icon: "download", run: later };
  else if (shown === "error")
    primary = {
      label: "重试",
      icon: "restart",
      run: () => {
        setEngaged(true);
        act(() => window.sweet.updateCheck().then(onState));
      },
    };
  else if (!s.canInstall) primary = { label: "去下载", icon: "external-link", run: () => act(() => window.sweet.updateOpenDownload()) };
  else if (!s.autoDownload)
    primary = {
      label: "下载",
      icon: "download",
      run: () => {
        setEngaged(true);
        act(() => window.sweet.updateDownload().then(onState));
      },
    };
  else primary = { label: "请稍候", icon: "clock", disabled: true };

  const showSecondary = shown !== "installing" && shown !== "downloading";

  return (
    <div className="euc-anchor" style={{ width: W * scale, height: H * scale }}>
      <section
        className={`euc tone-${look.tone}`}
        style={{ transform: `scale(${scale})` }}
        role="dialog"
        aria-modal="false"
        aria-label={`${look.title}${s.version ? `，版本 ${s.version}` : ""}`}
        aria-live="polite"
      >
        <div className="euc-bg" aria-hidden="true" />

        <header className="euc-header">
          <KitIcon name="sikeoop-crystal" className="euc-crystal" />
          <span className="euc-wordmark">sikeoop</span>
          <span className="euc-auto" aria-hidden="true">
            AUTO UPDATE
          </span>
          <button type="button" className="euc-close" onClick={later} aria-label="关闭（这次先不提醒）" title="关闭">
            <KitIcon name="close" />
          </button>
        </header>

        <div className="euc-hero" aria-hidden="true">
          <img src={HERO} alt="" loading="lazy" decoding="async" draggable={false} />
        </div>
        <div className="euc-lines" aria-hidden="true" />

        <div className="euc-copy">
          <span className="euc-stripes" aria-hidden="true" />
          <h2 className="euc-title">{look.title}</h2>
          <p className="euc-sub">{look.subtitle}</p>
          <div className="euc-badges">
            <span className="euc-badge version" title={`当前 ${s.current}`}>
              {s.version ? `v${s.version}` : `v${s.current}`}
            </span>
            <span className="euc-badge status">
              <KitIcon name={BADGE_ICON[look.tone]} />
              {look.badge}
            </span>
          </div>
        </div>

        <div className="euc-content">
          <div className="euc-content-head">
            <h3>本次更新</h3>
            {s.notes && (
              <button type="button" className="euc-link" onClick={() => setAllNotes(!allNotes)} aria-expanded={allNotes}>
                {allNotes ? "收起" : "查看全部更新说明"}
                <KitIcon name="chevron-right" />
              </button>
            )}
          </div>
          {allNotes && s.notes ? (
            <div className="euc-notes" tabIndex={0}>
              <ReleaseNotes notes={s.notes} />
            </div>
          ) : (
            <ul className="euc-features">
              {(rows.length ? rows : [{ title: s.version ? `sikeoop ${s.version} 带来了新功能和问题修复` : "新版本带来了新功能和问题修复", icon: "release-notes" as NoteIcon }]).map((r, i) => (
                <li key={i}>
                  <button type="button" onClick={() => s.notes && setAllNotes(true)} disabled={!s.notes} title={s.notes ? "查看全部更新说明" : undefined}>
                    <KitIcon name={r.icon} className="euc-feature-icon" />
                    <span>{r.title}</span>
                    {s.notes && <KitIcon name="chevron-right" className="euc-chev" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="euc-progress">
            <span className="euc-bar-label">{look.barLabel}</span>
            <div
              className={"euc-track" + (look.percent === null ? " indeterminate" : "")}
              role="progressbar"
              aria-label={look.barLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={look.percent ?? undefined}
            >
              <span style={look.percent === null ? undefined : { transform: `scaleX(${look.percent / 100})` }} />
            </div>
            <span className="euc-percent">{look.percent === null ? look.barLabel : `${look.percent}%`}</span>
          </div>
          {shown === "ready" && (
            <p className="euc-verify ok">
              <KitIcon name="shield-check" /> 完整性校验通过
            </p>
          )}
          {shown === "error" && (
            <p className="euc-verify bad">
              <KitIcon name="warning" /> {s.error || "连接中断，请稍后重试。"}
            </p>
          )}
        </div>

        <footer className="euc-footer">
          {s.canInstall && (
            <div className="euc-auto-dl">
              <KitIcon name="download" className="euc-auto-icon" />
              <div>
                <b>自动下载更新</b>
                <span>有新版本时在后台下载，下好再提醒你</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={s.autoDownload}
                aria-label="自动下载更新"
                className={"euc-toggle" + (s.autoDownload ? " on" : "")}
                onClick={() => void window.sweet.setUpdateAutoDownload(!s.autoDownload).then(onState)}
              />
            </div>
          )}
          <div className="euc-buttons">
            {showSecondary && (
              <button type="button" className="euc-btn secondary" onClick={later}>
                稍后
              </button>
            )}
            <button type="button" className="euc-btn primary" disabled={primary.disabled || busy} onClick={primary.run}>
              <KitIcon name={primary.icon} />
              {primary.label}
            </button>
          </div>
        </footer>

        <div className="euc-serial" aria-hidden="true">
          <span className="euc-hazard" />
          UNIT 01 / SIGNAL 39
        </div>
        <div className="euc-border" aria-hidden="true" />
      </section>
    </div>
  );
}
