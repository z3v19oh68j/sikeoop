import { useEffect, useState } from "react";
import type { QuartoStatus } from "@shared/types";
import { SettingRow, StatusBadge, cleanError } from "../settings/ui";
import { ToolDownload, usePaperTools } from "./ToolDownload";

/**
 * 设置 → 论文工坊的排版工具: the copies of Quarto sikeoop downloaded (docs/方案-论文工坊.md §9.1).
 * Their versions, updating to the latest, deleting. The user's own Quarto is shown, never touched.
 */
export function PaperToolsCard() {
  const { state, tasks, refresh } = usePaperTools(true);
  const [status, setStatus] = useState<QuartoStatus | null>(null);
  const [confirming, setConfirming] = useState("");
  const [error, setError] = useState("");
  const managed = state?.quarto ?? [];
  const versions = managed.map((m) => m.version).join(",");

  useEffect(() => {
    void window.sweet.quartoStatus().then(setStatus, () => setStatus(null));
  }, [versions]);
  if (!state) return null;

  async function run(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const remove = (version: string) =>
    run(async () => {
      setConfirming("");
      await window.sweet.toolRemoveQuarto(version);
      await refresh();
    });

  const own = status?.found && !status.managed;
  return (
    <SettingRow
      icon="file"
      title="论文排版工具 Quarto"
      desc="论文工坊排版用。sikeoop 不自带：需要时从 Quarto 的官方发布页下载一份，放在自己的数据文件夹里，不动系统。"
      status={
        own ? (
          <StatusBadge tone="ok">正在用你自己装的 {status.version}</StatusBadge>
        ) : managed.length ? (
          <StatusBadge tone="ok">已下载 {managed[0].version}</StatusBadge>
        ) : (
          <StatusBadge tone="muted">没有下载</StatusBadge>
        )
      }
    >
      {own && <p className="hint">你自己装的 Quarto 在 {status.path}。只要它是 1.4 或更新的版本，就优先用它；sikeoop 下载的那份只在它不能用时才用。</p>}
      {managed.length > 0 && (
        <ul className="pt-managed">
          {managed.map((m) => (
            <li key={m.version}>
              <div className="pt-managed-main">
                <b>
                  Quarto {m.version}
                  {status?.managed && status.version === m.version && <em>（正在用）</em>}
                </b>
                <span className="hint" title={m.dir}>
                  {m.dir}
                </span>
              </div>
              {confirming === m.version ? (
                <>
                  <button type="button" className="mini-btn" onClick={() => void remove(m.version)}>
                    确认删除
                  </button>
                  <button type="button" className="mini-btn" onClick={() => setConfirming("")}>
                    不删
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.toolReveal("quarto"))}>
                    打开所在文件夹
                  </button>
                  <button type="button" className="mini-btn" onClick={() => setConfirming(m.version)}>
                    删除
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ToolDownload
        tool="quarto"
        task={tasks.quarto}
        label={managed.length ? "检查更新" : "下载 Quarto"}
        about={managed.length ? "去 Quarto 的官方发布页看有没有新版；有的话先告诉你版本和大小。更新装好后，旧的那份会删掉。" : undefined}
        upToDate={managed.length ? `已经是最新版本（${managed[0].version}）。` : undefined}
        onDone={() => void refresh()}
      />
      {error && <p className="err-text">{error}</p>}
    </SettingRow>
  );
}
