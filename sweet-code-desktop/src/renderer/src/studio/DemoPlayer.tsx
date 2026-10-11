import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProtoDoc } from "@shared/types";
import { Icon } from "../components/Icon";

/**
 * The clickable demo: one screen at a time at its real size (scaled down to fit), and
 * [data-goto] clicks inside it move to that screen. Back / restart / Esc to close.
 */
export function DemoPlayer({ doc, start, version, onClose }: { doc: ProtoDoc; start: string; version: Record<string, number>; onClose(): void }) {
  const [stack, setStack] = useState<string[]>([start]);
  const [missing, setMissing] = useState("");
  const [scale, setScale] = useState(1);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const current = doc.canvas.screens.find((s) => s.id === stack[stack.length - 1]) ?? doc.canvas.screens[0];

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { __sweetProto?: boolean; type?: string; to?: string };
      if (!m?.__sweetProto || e.source !== frameRef.current?.contentWindow || m.type !== "goto") return;
      const to = m.to ?? "";
      if (doc.canvas.screens.some((s) => s.id === to)) {
        setMissing("");
        setStack((st) => [...st, to]);
      } else {
        setMissing(`没有 id 叫「${to}」的页面`);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Backspace" && !(e.target instanceof HTMLInputElement)) setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [doc, onClose]);

  // Fit the device into the window, never larger than 100%.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !current) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 48) / current.width, (el.clientHeight - 48) / current.height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [current]);

  if (!current) return null;
  return (
    <div className="demo" role="dialog" aria-label={`演示：${doc.name}`}>
      <div className="demo-bar">
        <button type="button" className="icon-btn" disabled={stack.length < 2} onClick={() => setStack((st) => st.slice(0, -1))}>
          <Icon name="chevron-left" /> 返回
        </button>
        <button type="button" className="icon-btn" onClick={() => setStack([doc.canvas.start ?? doc.canvas.screens[0].id])}>
          <Icon name="refresh" /> 从头开始
        </button>
        <span className="spacer" />
        <span className="demo-title">
          {current.title}
          <span className="dim">
            {" "}
            · {current.width} × {current.height}
            {scale < 1 && ` · ${Math.round(scale * 100)}%`}
          </span>
        </span>
        <span className="spacer" />
        {missing && <span className="warn-text">{missing}</span>}
        <button type="button" className="mini-btn" onClick={onClose}>
          退出演示 <kbd>Esc</kbd>
        </button>
      </div>
      <div className="demo-stage" ref={stageRef}>
        <div className={"demo-device " + current.device} style={{ width: current.width * scale, height: current.height * scale }}>
          <iframe
            ref={frameRef}
            key={`${current.id}:${version[current.id] ?? 0}`}
            title={current.title}
            src={window.sweet.protoScreenUrl(doc.name, current.file, version[current.id] ?? 0)}
            sandbox="allow-scripts allow-forms"
            width={current.width}
            height={current.height}
            style={{ transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}
