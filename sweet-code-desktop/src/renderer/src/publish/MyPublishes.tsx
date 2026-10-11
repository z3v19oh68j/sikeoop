import { useEffect, useState } from "react";
import type { PublishRecord } from "@shared/types";

// "My publishes" popover (F3): list published sites with open / copy / update / take offline.

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function sourceName(r: PublishRecord) {
  return r.source.kind === "proto" ? r.source.name : r.source.path.split(/[\\/]/).pop() || r.source.path;
}

function formatTime(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type RowState = { kind: "idle" } | { kind: "updating"; done: number; total: number } | { kind: "confirm" } | { kind: "removing" } | { kind: "error"; text: string };

export function MyPublishes({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<PublishRecord[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [copied, setCopied] = useState("");
  const [updating, setUpdating] = useState<string | null>(null);

  const setRow = (id: string, s: RowState) => setRows((r) => ({ ...r, [id]: s }));

  async function load() {
    try {
      setList(await window.sweet.publishList());
      setLoadError("");
    } catch (e) {
      setLoadError(`读取发布列表失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Progress for the one site being updated.
  useEffect(() => {
    if (!updating) return;
    return window.sweet.onPublishEvent((ev) => {
      if (ev.type === "upload") setRow(updating, { kind: "updating", done: ev.done, total: ev.total });
    });
  }, [updating]);

  async function update(r: PublishRecord) {
    if (updating) return;
    setUpdating(r.siteId);
    setRow(r.siteId, { kind: "updating", done: 0, total: 0 });
    try {
      await window.sweet.publishStart({ source: r.source });
      setRow(r.siteId, { kind: "idle" });
      await load();
    } catch (e) {
      setRow(r.siteId, { kind: "error", text: `更新没成功：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setUpdating(null);
    }
  }

  async function unpublish(r: PublishRecord) {
    setRow(r.siteId, { kind: "removing" });
    try {
      await window.sweet.publishUnpublish(r.siteId);
      await load();
    } catch (e) {
      setRow(r.siteId, { kind: "error", text: `下线没成功：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function copy(url: string) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? "" : c)), 1500);
    });
  }

  return (
    <div className="my-publishes" role="dialog" aria-label="我的发布">
      <div className="publish-head">
        <strong>我的发布</strong>
        <span className="spacer" />
        <button type="button" className="icon-btn square" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      {loadError && <p className="publish-note bad">{loadError}</p>}
      {!list && !loadError && <p className="publish-note">正在读取…</p>}
      {list && list.length === 0 && <p className="publish-note">还没有发布过网页。点「发布」就能拿到一个别人能打开的链接。</p>}
      {list && list.length > 0 && (
        <ul className="my-publishes-list">
          {list.map((r) => {
            const s = rows[r.siteId] ?? { kind: "idle" };
            return (
              <li key={r.siteId}>
                <a className="mp-url" href={r.url} target="_blank" rel="noreferrer">
                  {r.url}
                </a>
                <span className="publish-meta">
                  {sourceName(r)} · {formatTime(r.lastPublishedAt)} · {r.fileCount} 个文件 · {formatBytes(r.bytes)}
                </span>
                {s.kind === "updating" && (
                  <>
                    <p className="publish-note">正在更新{s.total ? `（${s.done}/${s.total}）` : "…"}</p>
                    <div className="publish-progress">
                      <div style={{ width: s.total ? `${(s.done / s.total) * 100}%` : "5%" }} />
                    </div>
                  </>
                )}
                {s.kind === "confirm" && (
                  <div className="mp-confirm">
                    <p className="publish-note bad">下线后这个链接就打不开了，发给别人的链接也会失效。确定要下线吗？</p>
                    <div className="publish-actions">
                      <button type="button" className="mini-btn" onClick={() => setRow(r.siteId, { kind: "idle" })}>
                        先不了
                      </button>
                      <button type="button" className="mini-btn danger" onClick={() => void unpublish(r)}>
                        确定下线
                      </button>
                    </div>
                  </div>
                )}
                {s.kind === "removing" && <p className="publish-note">正在下线…</p>}
                {s.kind === "error" && <p className="publish-note bad">{s.text}</p>}
                {(s.kind === "idle" || s.kind === "error") && (
                  <div className="mp-actions">
                    <button type="button" className="mini-btn" onClick={() => window.open(r.url, "_blank", "noopener")}>
                      打开
                    </button>
                    <button type="button" className="mini-btn" onClick={() => copy(r.url)}>
                      {copied === r.url ? "已复制" : "复制链接"}
                    </button>
                    <button type="button" className="mini-btn" disabled={!!updating} onClick={() => void update(r)}>
                      更新
                    </button>
                    <button type="button" className="mini-btn danger" onClick={() => setRow(r.siteId, { kind: "confirm" })}>
                      下线
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
