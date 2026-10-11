import { useEffect, useRef, useState } from "react";

// The opening shot (see ascii.ts): the first open of each day plays it in full; later opens,
// reduced motion, or a machine where it can't start go straight to the app. A click or any key
// skips it. (ocean.ts, the earlier whale-and-sea version, is no longer used.)

const DAY_KEY = "sweet.splash.day";
const FADE_MS = 380;


function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function shouldPlay(): boolean {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("splash")) return true;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return store(DAY_KEY) !== today();
}

/** Lifts the app into place: from just below, as if surfacing. */
function rise() {
  document.documentElement.classList.add("app-rise");
  setTimeout(() => document.documentElement.classList.remove("app-rise"), 900);
}

export function Splash() {
  const [play] = useState(shouldPlay);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(!play);
  const [shown, setShown] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const finish = useRef<() => void>(() => {});

  useEffect(() => {
    if (!play) return;
    store(DAY_KEY, today());
    let alive = true;
    let raf = 0;
    let shot: Awaited<ReturnType<typeof import("./ascii").createAscii>> | null = null;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      setLeaving(true);
      rise();
      setTimeout(() => {
        setGone(true);
        shot?.dispose();
      }, FADE_MS);
    };
    finish.current = end;
    // Never hold the app hostage: whatever happens, it opens.
    const safety = setTimeout(end, 4000);

    void (async () => {
      try {
        const { createAscii, SHOT } = await import("./ascii");
        if (!alive || !canvas.current) return;
        shot = await createAscii(canvas.current);
        if (!alive) return shot.dispose();
        const onResize = () => shot?.resize();
        window.addEventListener("resize", onResize);
        setShown(true);
        const start = performance.now();
        // Development: ?splash=0.6 holds the shot at 0.6 s, for looking at one frame.
        const hold = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("splash") || NaN) : NaN;
        if (!Number.isNaN(hold)) clearTimeout(safety);
        const tick = () => {
          if (!alive || done) return window.removeEventListener("resize", onResize);
          const t = Number.isNaN(hold) ? (performance.now() - start) / 1000 : hold;
          if (!Number.isNaN(hold)) {
            shot!.render(t);
            raf = requestAnimationFrame(tick);
            return;
          }
          shot!.render(t);
          if (t >= SHOT.end) return end();
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        console.warn("开机动画没能启动，直接进入", err);
        end();
      }
    })();

    const skip = () => end();
    window.addEventListener("keydown", skip);
    return () => {
      alive = false;
      clearTimeout(safety);
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", skip);
    };
  }, [play]);

  if (gone) return null;
  return (
    <div className={"splash" + (shown ? " shown" : "") + (leaving ? " leaving" : "")} onClick={() => finish.current()} aria-hidden="true">
      <canvas ref={canvas} />
      <span className="splash-skip">点一下跳过</span>
    </div>
  );
}
