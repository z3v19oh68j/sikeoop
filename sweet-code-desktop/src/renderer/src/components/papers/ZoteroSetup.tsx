import { useState } from "react";
import type { PaperToolId, ToolTask, ZoteroStatus } from "@shared/types";
import { StatusBadge } from "../settings/ui";
import { ToolDownload } from "./ToolDownload";

interface Props {
  status: ZoteroStatus;
  /** Zotero was found in one of the usual places. */
  installed: boolean;
  tasks: Partial<Record<PaperToolId, ToolTask>>;
  onRecheck(): void;
}

/**
 * Getting Zotero and Better BibTeX when they aren't there (docs/方案-论文工坊.md §9.2). Neither is
 * installed for the user: the installer is downloaded from zotero.org and opened, the plugin file
 * is downloaded and the user installs it from inside Zotero.
 */
export function ZoteroSetup({ status, installed, tasks, onRecheck }: Props) {
  const [open, setOpen] = useState(false);
  // Not answering and not found where it is usually installed: most likely not installed at all.
  const missing = status.state === "not_running" && !installed;
  const needsPlugin = status.state === "no_bbt" || status.state === "outdated";
  if (status.state === "ready") return null;
  if (!missing && !needsPlugin && !open) {
    return (
      <button type="button" className="link-btn pt-more" onClick={() => setOpen(true)}>
        还没安装 Zotero 或 Better BibTeX？可以从这里下载
      </button>
    );
  }
  const hasZotero = status.state === "no_bbt" || (installed && status.state !== "outdated");
  return (
    <ol className="pt-setup">
      <li>
        <div className="pt-step-head">
          <b>第一步：安装 Zotero</b>
          {hasZotero && <StatusBadge tone="ok">这台电脑上已经有了</StatusBadge>}
        </div>
        <p className="hint">Zotero 是一个完整的文献管理软件（AGPL-3.0）。sikeoop 不自带它，也不会替你悄悄安装：只从 zotero.org 下载官方安装包并打开，安装由你自己点完。</p>
        {!hasZotero && <ToolDownload tool="zotero" task={tasks.zotero} about="先告诉你版本、大小和来源，你确认后才开始下载。" />}
        {tasks.zotero?.phase === "done" && <p className="hint">装好后打开 Zotero，再做第二步。</p>}
      </li>
      <li>
        <div className="pt-step-head">
          <b>第二步：给 Zotero 装上 Better BibTeX 插件</b>
        </div>
        <p className="hint">插件文件（.xpi，MIT）从作者在 GitHub 的发布页下载，核对 SHA-256 后保存到下载文件夹。插件要在 Zotero 里面装，sikeoop 装不了：</p>
        <ToolDownload tool="bbt" task={tasks.bbt} about="先告诉你版本、大小和它支持哪些 Zotero 版本，你确认后才开始下载。" />
        <ol className="pc-steps">
          <li>打开 Zotero，点菜单「工具」→「插件」</li>
          <li>点右上角的齿轮，选「Install Plugin From File…」（从文件安装插件）</li>
          <li>选刚下载的 zotero-better-bibtex-….xpi（上面的「打开所在文件夹」能找到它）</li>
          <li>按提示重启 Zotero，回到这里点「重新检测」</li>
        </ol>
        <button type="button" className="mini-btn pp-self-start" onClick={onRecheck}>
          都装好了，重新检测
        </button>
      </li>
    </ol>
  );
}
