import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

// The beginner's tour: after the opening shot, the whale walks through the real interface, one
// spotlight at a time. Two chapters: "start" on the home screen the first time the app opens, and
// "work" the first time a project is open. Each plays once by itself (skipping counts), and can be
// replayed from 帮助 (HelpCenter dispatches TOUR_EVENT). Esc skips, ←/→ or Enter step through.

export type TourChapter = "start" | "work";
export const TOUR_EVENT = "sikeoop:tour";

interface Step {
  /** The element to light up; none (or not on screen) puts the card in the middle. */
  target?: string;
  title: string;
  body: string;
}

const CHAPTERS: Record<TourChapter, Step[]> = {
  start: [
    { title: "嗨，杂鱼～", body: "本鲸是这里的鲸鱼娘。花 30 秒带你认认路，嫌烦就按 Esc。" },
    { target: ".start-actions", title: "先打开一个项目", body: "项目就是电脑上的一个文件夹。已经有代码点「打开项目」；从零开始点「新建项目」，选一个空文件夹。" },
    { target: ".partner-pill", title: "今天谁陪你写", body: "点这里换伙伴、填 Key。每位伙伴是一个 AI 模型，DeepSeek、通义千问、Kimi 这些国内的都能直接连。" },
    // Both live in the 「扩展能力」 bookmark stack (Sidebar.tsx): point at its cover.
    { target: '.activitybar [data-stack="extend"]', title: "资源库", body: "鼠标移到这一叠书签上，展开后点「资源库」：一键装技能，让 AI 学会做 PPT、读 Excel 这类新本事。装之前会先做安全审核。" },
    { target: '.activitybar [data-stack="extend"]', title: "本鲸会记事", body: "同一叠里的「记忆与代码索引」：你的习惯、项目的约定都记在这里。记错了随手删，本鲸不会生气……才怪。" },
    { target: '.activitybar [aria-label="帮助"]', title: "不会就点这里", body: "新手手册、每个功能在哪、重看这段教程，都在「帮助」里。" },
    { title: "去打开一个项目吧", body: "打开以后，本鲸接着教你怎么让 AI 干活。" },
  ],
  work: [
    { target: ".sidebar", title: "你的文件", body: "项目里的文件都在这里，点一下就在中间打开。" },
    { target: ".center", title: "编辑器和终端", body: "中间看代码、改代码，下面是终端。AI 改了哪个文件，这里跟着刷新。" },
    { target: "#chat-input", title: "说你想做什么", body: "用大白话说就行，比如「帮我做一个记账网页」。截图、文件可以直接拖进来。" },
    { target: "#chat-mode", title: "给它多大权限", body: "Agent 每一步都问你；长任务交给审批小助手把关；懒人完全自己做。刚开始用 Agent。" },
    { title: "改东西之前，先给你看", body: "AI 要改文件时，对话里会出现一张改动卡片：红色是删掉的，绿色是新加的，点「同意」才生效。改坏了，点那一轮下面的「撤销」整轮回退。" },
    { target: ".statusbar", title: "状态栏", body: "这段对话用了多少、缓存命中多少，都在这。好啦，说出你想做的东西吧，杂鱼～" },
  ],
};

const DONE_KEY = (c: TourChapter) => `sweet.tour.${c}`;
const PAD = 6;
const CARD_W = 320;

function done(c: TourChapter): boolean {
  try {
    return localStorage.getItem(DONE_KEY(c)) === "1";
  } catch {
    return true;
  }
}
function markDone(c: TourChapter) {
  try {
    localStorage.setItem(DONE_KEY(c), "1");
  } catch {
    // Not remembered: it may show again next time, which is harmless.
  }
}

/** The tour plays only once the opening shot is gone. */
const splashGone = () => !document.querySelector(".splash");

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(selector?: string): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

/** Below the target if it fits, else above, else beside it; always inside the window. */
function cardPosition(hole: Rect | null, cardH: number): { top: number; left: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const clampX = (x: number) => Math.min(W - CARD_W - 16, Math.max(16, x));
  const clampY = (y: number) => Math.min(H - cardH - 16, Math.max(16, y));
  if (!hole) return { top: clampY(H / 2 - cardH / 2), left: clampX(W / 2 - CARD_W / 2) };
  const cx = hole.left + hole.width / 2 - CARD_W / 2;
  if (hole.top + hole.height + 14 + cardH < H) return { top: hole.top + hole.height + 14, left: clampX(cx) };
  if (hole.top - 14 - cardH > 0) return { top: hole.top - 14 - cardH, left: clampX(cx) };
  if (hole.left + hole.width + 14 + CARD_W < W) return { top: clampY(hole.top), left: hole.left + hole.width + 14 };
  return { top: clampY(hole.top), left: clampX(hole.left - 14 - CARD_W) };
}

export function Tour({ screen, hasProject }: { screen: string; hasProject: boolean }) {
  const [run, setRun] = useState<{ chapter: TourChapter; step: number } | null>(null);
  const [hole, setHole] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(180);

  // Start a chapter by itself the first time its screen is shown, after the opening shot.
  useEffect(() => {
    if (run) return;
    const chapter: TourChapter | null = screen === "start" ? "start" : screen === "work" && hasProject ? "work" : null;
    if (!chapter || done(chapter)) return;
    const timer = setInterval(() => {
      if (!splashGone()) return;
      clearInterval(timer);
      setRun({ chapter, step: 0 });
    }, 250);
    return () => clearInterval(timer);
  }, [screen, hasProject, run]);

  // Replays from 帮助.
  useEffect(() => {
    const on = (e: Event) => {
      const chapter = (e as CustomEvent<TourChapter>).detail;
      if (chapter in CHAPTERS) setRun({ chapter, step: 0 });
    };
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, []);

  const steps = run ? CHAPTERS[run.chapter] : [];
  const step = run ? steps[run.step] : undefined;

  const finish = useCallback(() => {
    if (run) markDone(run.chapter);
    setRun(null);
  }, [run]);
  const go = useCallback(
    (d: number) => {
      if (!run) return;
      const next = run.step + d;
      if (next < 0) return;
      if (next >= CHAPTERS[run.chapter].length) return finish();
      setRun({ ...run, step: next });
    },
    [run, finish],
  );

  // Follow the target while the step is up (layouts move: panels open, windows resize).
  useLayoutEffect(() => {
    if (!step) return;
    let raf = 0;
    let last = "";
    const track = () => {
      const r = rectOf(step.target);
      const key = r ? `${Math.round(r.top)},${Math.round(r.left)},${Math.round(r.width)},${Math.round(r.height)}` : "";
      if (key !== last) {
        last = key;
        setHole(r);
      }
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useEffect(() => {
    if (!run) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [run, go, finish]);

  if (!run || !step) return null;
  const pos = cardPosition(hole, cardH);
  const last = run.step === steps.length - 1;
  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-label={`新手教程：${step.title}`}>
      {/* Clicks outside the card are held, so the tour can't be lost behind a stray click. */}
      <div className="tour-block" />
      <div
        className={"tour-hole" + (hole ? "" : " none")}
        style={hole ? { top: hole.top, left: hole.left, width: hole.width, height: hole.height } : undefined}
      />
      <div
        className="tour-card"
        style={{ top: pos.top, left: pos.left, width: CARD_W }}
        ref={(el) => {
          if (el && Math.abs(el.offsetHeight - cardH) > 2) setCardH(el.offsetHeight);
        }}
      >
        <header>
          <span className="tour-whale" aria-hidden="true">
            <svg viewBox="0 0 160 100">
              <path d="M28 56C16 50 8 40 4 30c10 2 16 8 20 14 0-10 4-18 12-22-2 12 0 22 6 30Z" fill="#7fb0e8" />
              <path d="M30 58c0-18 22-32 52-32 30 0 52 14 52 34 0 18-22 30-56 30-30 0-48-12-48-32Z" fill="#7fb0e8" />
              <path d="M40 70c10 10 26 14 42 14 22 0 40-6 48-18-8 6-26 10-46 10-18 0-32-2-44-6Z" fill="#dbe9fa" />
              <circle cx="112" cy="54" r="5" fill="#1a2a3e" />
              <ellipse cx="118" cy="66" rx="6" ry="3" fill="#f0789b" opacity="0.6" />
            </svg>
          </span>
          <b>{step.title}</b>
          <span className="tour-count">
            {run.step + 1} / {steps.length}
          </span>
        </header>
        <p>{step.body}</p>
        <footer>
          <button type="button" className="link-btn" onClick={finish}>
            跳过教程
          </button>
          <span className="spacer" />
          {run.step > 0 && (
            <button type="button" className="mini-btn" onClick={() => go(-1)}>
              上一步
            </button>
          )}
          <button type="button" className="send" onClick={() => go(1)} autoFocus>
            {last ? "知道了" : "下一步"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
