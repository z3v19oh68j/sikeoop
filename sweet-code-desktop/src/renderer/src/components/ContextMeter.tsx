import { useEffect, useRef, useState } from "react";
import type { ContextPartKey, ContextUsage } from "@shared/types";

const PARTS: Record<ContextPartKey, { label: string; color: string; hint: string }> = {
  messages: { label: "对话", color: "#7aa2f7", hint: "你和 AI 说的话、AI 调用工具时写的参数" },
  toolResults: { label: "工具结果", color: "#e8915a", hint: "读到的文件内容、命令输出、搜索结果" },
  context: { label: "项目和记忆", color: "#5fd38d", hint: "项目概况、规则文件、记忆、自动找到的代码、压缩后的摘要" },
  thinking: { label: "思考", color: "#c792ea", hint: "模型的思考过程（保留在历史里）" },
  system: { label: "系统提示", color: "#b4b4bb", hint: "sikeoop 给 AI 的固定说明" },
  tools: { label: "工具定义", color: "#6b6b74", hint: "AI 能用的工具的说明（读写文件、运行命令、插件…）" },
};
const ORDER: ContextPartKey[] = ["messages", "toolResults", "context", "thinking", "system", "tools"];

/** 62.3K, 200K, 1M: one decimal only when it says something. */
const k = (n: number) => {
  const fmt = (v: number, unit: string) => `${Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : v.toFixed(1)}${unit}`;
  return n >= 1_000_000 ? fmt(n / 1_000_000, "M") : n >= 1000 ? fmt(n / 1000, "K") : String(n);
};
const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * The status bar's context gauge, and on click a breakdown of what fills the window, like
 * Claude Code's: one bar split by kind, how far it is to auto-compression, and "compress now".
 */
export function ContextMeter({ usage, busy, onCompacted }: { usage: ContextUsage; busy: boolean; onCompacted(u: ContextUsage | null): void }) {
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const pct = Math.min(100, (usage.used / usage.budget) * 100);
  const left = Math.max(0, usage.budget - usage.used);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function compact() {
    setError("");
    setCompacting(true);
    try {
      onCompacted(await window.sweet.compactNow());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setCompacting(false);
    }
  }

  const parts = ORDER.map((key) => ({ key, tokens: usage.parts.find((p) => p.key === key)?.tokens ?? 0 })).filter((p) => p.tokens > 0);

  return (
    <div className="ctx-meter-wrap" ref={ref}>
      <button
        type="button"
        className={"context-meter" + (pct >= 80 ? " high" : "")}
        aria-expanded={open}
        title="查看上下文窗口里都装了什么"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        上下文 {k(usage.used)} / {k(usage.budget)}
      </button>
      {open && (
        <div className="ctx-pop" role="dialog" aria-label="上下文窗口">
          <div className="ctx-pop-head">
            <span>上下文窗口</span>
            <span className="num">
              {usage.estimated && "约 "}
              {k(usage.used)} / {k(usage.budget)}（{Math.round(pct)}%）
            </span>
          </div>
          <div className="ctx-stack" aria-hidden="true">
            {parts.map((p) => (
              <span key={p.key} style={{ width: `${(p.tokens / usage.budget) * 100}%`, background: PARTS[p.key].color }} title={`${PARTS[p.key].label} ${k(p.tokens)}`} />
            ))}
          </div>
          <div className="ctx-pop-row">
            <span>{left > 0 ? `还有 ${k(left)} 自动压缩` : "已满，下一步会自动压缩"}</span>
            <button type="button" className="mini-btn" disabled={busy || compacting || usage.used === 0} onClick={() => void compact()} title={busy ? "AI 停下以后才能压缩" : "让压缩助手现在就把之前的工作整理成摘要"}>
              {compacting ? "压缩中…" : "立即压缩"}
            </button>
          </div>
          {error && <p className="err-text">{error}</p>}
          <ul className="ctx-legend">
            {ORDER.map((key) => {
              const tokens = usage.parts.find((p) => p.key === key)?.tokens ?? 0;
              return (
                <li key={key} title={PARTS[key].hint}>
                  <span className="dot" style={{ background: PARTS[key].color }} />
                  <span className="name">{PARTS[key].label}</span>
                  <span className="val">{k(tokens)}</span>
                  <span className="pct">{usage.used ? `${Math.round((tokens / usage.used) * 100)}%` : "–"}</span>
                </li>
              );
            })}
            <li className="free">
              <span className="dot" />
              <span className="name">剩余空间</span>
              <span className="val">{k(left)}</span>
              <span className="pct" />
            </li>
          </ul>
          <p className="hint">
            工作窗口 {k(usage.budget)}，模型本身最多 {k(usage.window)}。用满后压缩助手会把之前的工作整理成摘要，任务接着做。
            {usage.estimated && " 现在是估算值，AI 回复一次后变成实际值。"}
          </p>
        </div>
      )}
    </div>
  );
}
