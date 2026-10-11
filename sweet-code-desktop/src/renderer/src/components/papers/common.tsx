import { useState } from "react";
import type { PaperDoc, PaperTask } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, cleanError, type Tone } from "../settings/ui";

export { cleanError };

export const TASK_KIND: Record<PaperTask["kind"], string> = { summarize: "生成总结", translate: "全文翻译", extract: "提取论点" };
export const TASK_STATUS: Record<PaperTask["status"], { text: string; tone: Tone }> = {
  queued: { text: "排队中", tone: "muted" },
  running: { text: "进行中", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  failed: { text: "失败", tone: "bad" },
  cancelled: { text: "已取消", tone: "muted" },
};
export const LIVE_TASK = new Set<PaperTask["status"]>(["queued", "running"]);

export const authorsText = (authors: string[], max = 3) =>
  authors.length > max ? `${authors.slice(0, max).join("、")} 等 ${authors.length} 人` : authors.join("、");

export const sourceText = (p: PaperDoc) => (p.source.kind === "arxiv" ? `arXiv:${p.source.id}` : p.source.path.split(/[\\/]/).pop() ?? p.source.path);

/** A long task: what it is, how far, and a cancel button. */
export function TaskBar({ task, label }: { task: PaperTask; label?: string }) {
  const [error, setError] = useState("");
  const st = TASK_STATUS[task.status];
  const live = LIVE_TASK.has(task.status);
  const pct = task.total ? Math.min(1, task.done / task.total) : 0;
  return (
    <div className={"pp-task" + (live ? " live" : "")} role="status" aria-live="polite">
      <div className="pp-task-head">
        <b>{label ?? TASK_KIND[task.kind]}</b>
        <StatusBadge tone={st.tone}>{st.text}</StatusBadge>
        {task.total > 0 && (
          <span className="hint">
            {task.done} / {task.total}
          </span>
        )}
        <span className="spacer" />
        {live && (
          <button
            type="button"
            className="mini-btn"
            onClick={() => void window.sweet.paperCancel(task.id).catch((e) => setError(cleanError(e)))}
          >
            <Icon name="stop" /> 取消
          </button>
        )}
      </div>
      {live && (
        <div className={"rs-bar" + (task.total ? "" : " indeterminate")} aria-hidden="true">
          <span style={task.total ? { transform: `scaleX(${pct})` } : undefined} />
        </div>
      )}
      {task.error && <p className="err-text">{task.error}</p>}
      {error && <p className="err-text">{error}</p>}
    </div>
  );
}

/** Characters used / allowed, warning when over (Chain-Centric silently cuts longer text). */
export function CharCount({ text, max }: { text: string; max: number }) {
  const n = [...text].length;
  return (
    <span className={"pp-count" + (n > max ? " over" : "")} title={n > max ? `超过 ${max} 字的部分会被截掉` : undefined}>
      {n} / {max}
    </span>
  );
}
