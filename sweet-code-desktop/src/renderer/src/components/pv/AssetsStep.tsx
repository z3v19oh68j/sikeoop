import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { cleanError } from "../settings/ui";
import { fmtBytes, fmtSecs, pv, type PvAsset, type PvProject } from "./types";

const KIND = { image: "图片", video: "视频", audio: "音频" } as const;

/** Step 5: the files the video can use. Import, delete, and pick the background music. */
export function AssetsStep({ root, project, assets, loadError, onReload, onAssets, onProject }: { root: string; project: PvProject; assets: PvAsset[] | null; loadError: string; onReload(): void; onAssets(a: PvAsset[]): void; onProject(p: PvProject): void }) {
  // file → thumbnail address; null means the address or the file itself could not be loaded.
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const visual = (assets ?? []).filter((a) => a.kind !== "audio");
    if (!visual.length) return;
    let alive = true;
    void Promise.all(visual.map(async (a) => [a.file, (await pv().pvAssetUrl(root, project.id, a.file).catch(() => null)) || null] as const))
      .then((entries) => { if (alive) setUrls((u) => ({ ...u, ...Object.fromEntries(entries) })); });
    return () => { alive = false; };
  }, [root, project.id, assets]);

  async function importFiles() {
    setError(""); setBusy(true);
    try {
      const added = await pv().pvImportAssets(root, project.id);
      if (added.length) onAssets(await pv().pvAssets(root, project.id));
    } catch (e) { setError(`没导进来：${cleanError(e)}`); } finally { setBusy(false); }
  }
  async function remove(a: PvAsset) {
    setError("");
    try {
      await pv().pvRemoveAsset(root, project.id, a.file);
      onAssets((assets ?? []).filter((x) => x.file !== a.file));
      if (project.music === a.file) onProject({ ...project, music: undefined });
    } catch (e) { setError(`没删掉：${cleanError(e)}`); }
  }
  async function setMusic(file: string | null) {
    setError("");
    try { onProject(await pv().pvSetMusic(root, project.id, file)); } catch (e) { setError(`配乐没设上：${cleanError(e)}`); }
  }

  const list = assets ?? [];
  const hasAudio = list.some((a) => a.kind === "audio");
  const musicGone = !!project.music && assets !== null && !loadError && !list.some((a) => a.file === project.music);

  return (
    <div className="pv-assets">
      <div className="rs-actions">
        <span className="hint">把图片、视频、录屏和音乐放进来，分镜里可以直接选。文件会复制到 pv/{project.id}/assets/，原文件不会动。</span>
        <span className="spacer" />
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void importFiles()}><Icon name="plus" /> {busy ? "导入中…" : "导入文件"}</button>
      </div>
      {error && <p className="err-text">{error}</p>}
      {loadError ? (
        <div className="rs-actions"><span className="err-text">素材列表读不出来：{loadError}</span><button type="button" className="mini-btn" onClick={onReload}>再读一次</button></div>
      ) : assets === null ? <p className="hint">读取中…</p> : list.length === 0 ? (
        <p className="hint pv-empty">还没有素材。点「导入文件」选几张图、几段视频，或者一首配乐。</p>
      ) : (
        <>
          {musicGone ? <p className="warn-text">配乐「{project.music}」在素材里找不到了。重新导入它，或者另选一首设为配乐。</p>
            : !project.music && <p className="hint">{hasAudio ? "还没选配乐。想卡点或者带音乐出片，在下面某首音乐上点「设为配乐」。" : "还没有音乐。想卡点或者带音乐出片，先导入一首歌，再点它的「设为配乐」。"}</p>}
          <ul className="pv-asset-list">
            {list.map((a) => (
              <li key={a.file} className="pv-asset">
                <Thumb asset={a} url={urls[a.file]} onBroken={() => setUrls((u) => ({ ...u, [a.file]: null }))} />
                <div className="pv-asset-info">
                  <b title={a.file}>{a.file}</b>
                  <span className="hint">{KIND[a.kind]} · {fmtBytes(a.bytes)}{a.seconds ? ` · ${fmtSecs(a.seconds)}` : ""}{project.music === a.file ? " · 当前配乐" : ""}</span>
                </div>
                {a.kind === "audio" && (project.music === a.file
                  ? <button type="button" className="mini-btn" onClick={() => void setMusic(null)}>取消配乐</button>
                  : <button type="button" className="mini-btn" onClick={() => void setMusic(a.file)}>设为配乐</button>)}
                <button type="button" className="mini-btn icon-only" onClick={() => void remove(a)} aria-label={`删除 ${a.file}`}><Icon name="trash" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Thumb({ asset, url, onBroken }: { asset: PvAsset; url: string | null | undefined; onBroken(): void }) {
  if (asset.kind === "audio") return <div className="pv-thumb"><span>♪</span></div>;
  if (url === undefined) return <div className="pv-thumb"><span>…</span></div>;
  if (url === null) return <div className="pv-thumb bad" title="缩略图加载不了"><span>{KIND[asset.kind]}<br />没预览</span></div>;
  return (
    <div className="pv-thumb">
      {asset.kind === "image" ? <img src={url} alt={asset.file} onError={onBroken} /> : <video src={url} muted preload="metadata" onError={onBroken} />}
    </div>
  );
}
