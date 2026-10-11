import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderView } from "@shared/types";
import { isReady } from "../components/ProviderDialog";
import { characterFor } from "./characters";
import { HomeScene, type HomeTheme } from "./scene";
import { Icon } from "../components/Icon";

interface Props {
  providers: ProviderView[];
  activeId: string;
  /** Keyboard shortcuts pause while a dialog is open on top. */
  interactive: boolean;
  onChoose(providerId: string): void;
  onSettings(providerId: string): void;
}

function readTheme(): HomeTheme {
  // The app is dark-only: always the dusk sky.
  return { bg: "#0b0d14", dark: true };
}

/** The character-select home screen: every model provider is a partner with her own card. */
export function HomeScreen({ providers, activeId, interactive, onChoose, onSettings }: Props) {
  const cast = useMemo(
    () => providers.flatMap((p) => {
      const c = characterFor(p.id);
      return c ? [{ provider: p, character: c }] : [];
    }),
    [providers],
  );
  const castKey = cast.map((x) => x.provider.id).join(",");
  const [focus, setFocus] = useState(() => Math.max(0, cast.findIndex((x) => x.provider.id === activeId)));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<HomeScene | null>(null);
  const pickRef = useRef<(i: number) => void>(() => {});
  pickRef.current = (i) => onChoose(cast[i].provider.id);

  // Build the 3D scene once per cast; provider status changes only touch the HTML panel.
  useEffect(() => {
    const scene = new HomeScene(
      canvasRef.current!,
      cast.map((x) => x.character),
      { onFocus: setFocus, onPick: (i) => pickRef.current(i) },
      readTheme(),
      focus,
    );
    sceneRef.current = scene;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => scene.setTheme(readTheme());
    mq.addEventListener("change", onTheme);
    return () => {
      mq.removeEventListener("change", onTheme);
      scene.dispose();
      sceneRef.current = null;
    };
    // The scene follows focus through setFocus below; rebuilding on focus would reset it.
  }, [castKey]);

  useEffect(() => sceneRef.current?.setFocus(focus), [focus]);

  const move = (d: number) => setFocus((f) => (f + d + cast.length) % cast.length);

  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
      else if (e.key === "Enter") pickRef.current(focus);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = cast[focus];
  if (!current) return null;
  const { provider: p, character: c } = current;
  const ready = isReady(p);

  return (
    <main className="home" style={{ ["--hero" as string]: c.accent, ["--hero-hair" as string]: c.hair }}>
      <canvas ref={canvasRef} className="home-canvas" aria-hidden="true" />

      <header className="home-title">
        <h1>今天想让谁陪你写代码？</h1>
        <p>每位伙伴背后是一个不同的 AI 模型。←、→ 或拖动来换人，随时都能回来换。</p>
      </header>

      <button type="button" className="neu-round home-prev" aria-label="上一位" onClick={() => move(-1)}>
        <Icon name="chevron-left" />
      </button>
      <button type="button" className="neu-round home-next" aria-label="下一位" onClick={() => move(1)}>
        <Icon name="chevron-right" />
      </button>

      <section className="home-panel" aria-live="polite">
        <div className="who">
          <span className="name">{c.name}</span>
          <span className="role">{c.title}</span>
        </div>
        <p className="line">「{c.tagline}」</p>
        <div className="meta">
          <span className="tag">
            {p.name}
            {p.model ? ` · ${p.model}` : ""}
          </span>
          <span className={"status" + (ready ? " ok" : "")}>
            {ready ? "已就绪" : p.authMode === "login" ? "还差一步：登录账号" : !p.model ? "还差一步：选模型" : "还差一步：填 Key"}
          </span>
          {p.id === activeId && <span className="tag">当前伙伴</span>}
        </div>
        <div className="actions">
          <button type="button" className="neu-btn primary" onClick={() => onChoose(p.id)}>
            {ready ? "就选你了！" : "设置好就出发"}
          </button>
          <button type="button" className="neu-btn" onClick={() => onSettings(p.id)}>
            <Icon name="settings" /> 设置
          </button>
        </div>
        <div className="dots" role="tablist" aria-label="伙伴">
          {cast.map((x, i) => (
            <button
              key={x.provider.id}
              type="button"
              role="tab"
              aria-selected={i === focus}
              aria-label={x.character.name}
              className={i === focus ? "on" : undefined}
              onClick={() => setFocus(i)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
