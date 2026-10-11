import { useEffect, useState } from "react";
import type { ArchiveProgress, ArchiveResult, UnfinishedTask } from "@shared/types";
import { Icon } from "./Icon";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const fmt = (bytes: number) =>
  bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/**
 * Archive the open project into one .zip in the archive folder. `finished` means it was offered
 * because the AI's plan is all done; otherwise the user opened it themselves.
 */
export function ArchiveDialog({ project, finished, onClose }: { project: string; finished: boolean; onClose(): void }) {
  const [dir, setDir] = useState("");
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const [result, setResult] = useState<ArchiveResult | null>(null);
  const [error, setError] = useState("");
  const running = !!progress && (progress.phase === "scan" || progress.phase === "zip");

  useEffect(() => {
    void window.sweet.archiveDir().then(setDir);
    return window.sweet.onArchiveProgress(setProgress);
  }, []);

  const start = async () => {
    setError("");
    setResult(null);
    setProgress({ phase: "scan", done: 0, total: 0, label: "正在清点文件" });
    try {
      setResult(await window.sweet.archiveProject(note.trim() || undefined));
    } catch (e) {
      setError(cleanError(e));
      setProgress(null);
    }
  };

  const pct = progress?.phase === "zip" && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal archive-modal" role="dialog" aria-label="归档项目">
        <h2>
          <Icon name="archive" /> {result ? "归档完成" : finished ? "任务都完成了，要归档这个项目吗？" : `归档「${project}」`}
        </h2>

        {result ? (
          <>
            <p>
              已打包 {result.files} 个文件和这个项目的对话、百科记录，共 {fmt(result.bytes)}。
            </p>
            <code className="archive-path">{result.file}</code>
            {result.skipped.length > 0 && (
              <details className="archive-skipped">
                <summary>有 {result.skipped.length} 项没有放进去</summary>
                <ul>
                  {result.skipped.slice(0, 50).map((s) => (
                    <li key={s.path}>
                      <code>{s.path}</code>：{s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row">
              <button type="button" className="neu-btn" onClick={() => void window.sweet.showInFolder(result.file)}>
                <Icon name="folder-open" /> 在文件夹中显示
              </button>
              <button type="button" className="neu-btn primary" onClick={onClose}>
                好的
              </button>
            </div>
          </>
        ) : running ? (
          <>
            <p>{progress?.phase === "scan" ? "正在清点文件…" : `正在压缩：${progress?.label}`}</p>
            <div className="archive-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="row">
              <span className="archive-pct">{progress?.phase === "zip" ? `${pct}% · ${fmt(progress.done)} / ${fmt(progress.total)}` : ""}</span>
              <span className="spacer" />
              <button type="button" className="neu-btn" onClick={() => void window.sweet.archiveCancel()}>
                取消
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              把整个项目（跳过 node_modules、.git 和构建产物）连同对话、计划和百科打包成一个 .zip，原项目不会被改动或删除。
            </p>
            <label className="archive-field">
              <span>存到</span>
              <code title={dir}>{dir}</code>
              <button
                type="button"
                className="mini-btn"
                onClick={() => void window.sweet.chooseArchiveDir().then((d) => d && setDir(d))}
              >
                更改
              </button>
            </label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选）：比如“v1 完成，登录和支付都做好了”" maxLength={500} />
            {error && <p className="err">{error}</p>}
            <div className="row">
              <button type="button" className="neu-btn" onClick={onClose}>
                {finished ? "先不归档" : "取消"}
              </button>
              <button type="button" className="neu-btn primary" onClick={() => void start()}>
                <Icon name="archive" /> 开始归档
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** At startup: tasks left unfinished last time, with a choice to pick one up. */
export function ResumeDialog({
  tasks,
  onContinue,
  onClose,
}: {
  tasks: UnfinishedTask[];
  onContinue(t: UnfinishedTask): void;
  onClose(): void;
}) {
  const [list, setList] = useState(tasks);
  if (!list.length) return null;
  const dismiss = async (t: UnfinishedTask) => {
    await window.sweet.resumeDismiss(t.sessionId, t.updatedAt);
    const rest = list.filter((x) => x !== t);
    setList(rest);
    if (!rest.length) onClose();
  };
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal resume-modal" role="dialog" aria-label="继续上次的任务">
        <h2>
          <Icon name="history" /> 上次还有没做完的任务
        </h2>
        {list.map((t) => (
          <div key={t.sessionId} className="resume-card">
            <div className="resume-head">
              <strong>{t.project}</strong>
              <span className="resume-meta">
                {t.title} · {new Date(t.updatedAt).toLocaleString()}
              </span>
            </div>
            <div className="archive-bar small" aria-label={`已完成 ${t.done}/${t.total}`}>
              <span style={{ width: `${Math.round((t.done / t.total) * 100)}%` }} />
            </div>
            <p className="resume-meta">
              已完成 {t.done}/{t.total}，还剩：
            </p>
            <ul>
              {t.remaining.slice(0, 5).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
              {t.remaining.length > 5 && <li>……还有 {t.remaining.length - 5} 项</li>}
            </ul>
            <div className="row">
              <button type="button" className="mini-btn" onClick={() => void dismiss(t)} title="这个任务以后不再提醒（除非它又有新进展）">
                不再提醒
              </button>
              <span className="spacer" />
              <button type="button" className="neu-btn primary" onClick={() => onContinue(t)}>
                <Icon name="play" /> 继续做
              </button>
            </div>
          </div>
        ))}
        <div className="row">
          <button type="button" className="neu-btn" onClick={onClose}>
            以后再说
          </button>
        </div>
      </div>
    </div>
  );
}
