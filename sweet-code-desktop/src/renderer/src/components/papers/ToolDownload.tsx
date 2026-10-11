import { useEffect, useState } from "react";
import type { PaperToolId, PaperToolsState, ToolOffer, ToolTask } from "@shared/types";
import { Icon } from "../Icon";
import { cleanError } from "./common";
import "../../styles/research.css";
import "../../styles/papers.css";

// Quarto / Zotero / Better BibTeX fetched from their official sources when the user asks
// (docs/方案-论文工坊.md §9). Two clicks: the first only asks what the latest version is and shows
// where it comes from, its licence and its size; the download starts on the second.

const NAME: Record<PaperToolId, string> = { quarto: "Quarto", zotero: "Zotero", bbt: "Better BibTeX" };
const LIVE = new Set<ToolTask["phase"]>(["downloading", "verifying", "extracting"]);
const PHASE: Record<ToolTask["phase"], string> = {
  downloading: "正在下载",
  verifying: "正在校验",
  extracting: "正在解压",
  done: "好了",
  failed: "没有成功",
  cancelled: "已取消",
};

export const megabytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** What is downloaded here and what is going on, kept up to date by the main process' events. */
export function usePaperTools(active: boolean) {
  const [state, setState] = useState<PaperToolsState | null>(null);
  const [tasks, setTasks] = useState<Partial<Record<PaperToolId, ToolTask>>>({});

  const refresh = () =>
    window.sweet.toolsState().then(
      (s) => {
        setState(s);
        setTasks(Object.fromEntries(s.tasks.map((t) => [t.tool, t])));
      },
      () => undefined,
    );

  useEffect(() => {
    if (!active) return;
    void refresh();
    return window.sweet.onToolEvent((e) => {
      setTasks((cur) => ({ ...cur, [e.task.tool]: e.task }));
      // Something was added or went away: what is here is read again.
      if (!LIVE.has(e.task.phase)) void refresh();
    });
  }, [active]);

  return { state, tasks, refresh };
}

interface Props {
  tool: PaperToolId;
  /** The latest download of this tool, from usePaperTools. */
  task?: ToolTask;
  /** The button's words before anything was asked ("下载 Quarto"). */
  label?: string;
  /** Roughly how big, said before the exact size is known. */
  about?: string;
  /** Called when the download is done (to look for the tool again). */
  onDone?(task: ToolTask): void;
  /** Shown when the latest version is already here, instead of an offer to download it. */
  upToDate?: string;
}

/** One tool's download: ask, show what it is, download with progress, cancel, try again. */
export function ToolDownload({ tool, task, label, about, onDone, upToDate }: Props) {
  const [offer, setOffer] = useState<ToolOffer | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const name = NAME[tool];

  useEffect(() => {
    if (task?.phase === "done") onDone?.(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.phase, task?.path]);

  async function run(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function ask() {
    setAsking(true);
    await run(async () => setOffer(await window.sweet.toolOffer(tool)));
    setAsking(false);
  }

  const start = (version: string) =>
    run(async () => {
      await window.sweet.toolDownload(tool, version);
      setOffer(null);
    });

  if (task && LIVE.has(task.phase)) {
    const pct = task.total ? Math.min(1, task.received / task.total) : 0;
    return (
      <div className="pt-task" role="status" aria-live="polite">
        <div className="pt-task-head">
          <b>
            {PHASE[task.phase]} {name} {task.version}
          </b>
          {task.phase === "downloading" && task.total > 0 && (
            <span className="hint">
              {megabytes(task.received)} / {megabytes(task.total)}（{Math.floor(pct * 100)}%）
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.toolCancel(tool))}>
            <Icon name="stop" /> 取消
          </button>
        </div>
        <div className={"rs-bar" + (task.phase === "downloading" && task.total ? "" : " indeterminate")} aria-hidden="true">
          <span style={task.phase === "downloading" && task.total ? { transform: `scaleX(${pct})` } : undefined} />
        </div>
        {error && <p className="err-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="pt-task">
      {task?.phase === "failed" && (
        <p className="err-text">
          {name} {task.version} 没有下载成功：{task.error}
        </p>
      )}
      {task?.phase === "cancelled" && <p className="hint">已取消，没有留下下载到一半的文件。</p>}
      {task?.phase === "done" && tool !== "quarto" && (
        <div className="rs-actions">
          <span className="ok-text">
            {task.file} 已保存{task.opened ? "，安装包已经打开" : ""}。
          </span>
          {tool === "zotero" && /\.(dmg|exe)$/i.test(task.file) && (
            <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.toolOpen(tool))}>
              再打开一次安装包
            </button>
          )}
          <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.toolReveal(tool))}>
            打开所在文件夹
          </button>
        </div>
      )}

      {offer ? (
        offer.have && upToDate ? (
          <p className="ok-text">{upToDate}</p>
        ) : (
          <div className="pt-offer">
            <b>
              {name} {offer.version}（{megabytes(offer.size)}）
            </b>
            <dl>
              <dt>来源</dt>
              <dd>
                {offer.source}
                <code>{offer.url}</code>
              </dd>
              <dt>许可</dt>
              <dd>{offer.license}</dd>
              <dt>校验</dt>
              <dd>{offer.checksum ? "下载后核对官方公布的 SHA-256，对不上就删除、不使用" : "官方没有给这个文件公布校验值：只走 https 从官方地址下载，并核对文件大小"}</dd>
              <dt>放哪里</dt>
              <dd>{offer.where}</dd>
              {offer.note && (
                <>
                  <dt>发布说明</dt>
                  <dd>{offer.note}</dd>
                </>
              )}
            </dl>
            <div className="rs-actions">
              <button type="button" className="send rs-accent" onClick={() => void start(offer.version)}>
                确认下载（{megabytes(offer.size)}）
              </button>
              <button type="button" className="mini-btn" onClick={() => setOffer(null)}>
                先不下
              </button>
            </div>
          </div>
        )
      ) : (
        <div className="rs-actions">
          {task?.phase === "failed" ? (
            <button type="button" className="send rs-accent" onClick={() => void start(task.version)}>
              {task.resumable ? "接着下载" : "再试一次"}
            </button>
          ) : (
            <button type="button" className={task?.phase === "done" ? "mini-btn" : "send rs-accent"} disabled={asking} onClick={() => void ask()}>
              {asking ? "正在查询最新版本…" : (label ?? `下载 ${name}`)}
            </button>
          )}
          <span className="hint">{about ?? "先告诉你版本、大小、来源和许可，你确认后才开始下载。"}</span>
        </div>
      )}
      {error && <p className="err-text">{error}</p>}
    </div>
  );
}
