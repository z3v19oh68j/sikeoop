import { useEffect, useState } from "react";
import { cleanError } from "../settings/ui";
import { fmtSecs, pv, type PvAsset, type PvBeats, type PvProject, type PvStep, type PvStoryboard } from "./types";

const UNIT = { bar: "小节", beat: "拍" } as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (sb: PvStoryboard) => round2(sb.shots.reduce((a, s) => a + s.seconds, 0));

/** Step 4: find the beat of the music, fine-tune it, and snap shot lengths to bars or beats. */
export function BeatsStep({ root, project, assets, ffMissing, failure, onGo }: { root: string; project: PvProject; assets: PvAsset[] | null; ffMissing: boolean; failure?: string; onGo(step: PvStep): void }) {
  const music = project.music;
  const status = project.steps.beats;
  const [beats, setBeats] = useState<PvBeats | null | undefined>(undefined);
  const [grid, setGrid] = useState({ bpm: "", offset: "", beatsPerBar: "4" });
  // undefined while loading, null when the address or the file could not be loaded.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [snap, setSnap] = useState<{ unit: "bar" | "beat"; before: PvStoryboard; after: PvStoryboard } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!music) return;
    let alive = true;
    setUrl(undefined);
    void pv().pvAssetUrl(root, project.id, music).then((u) => { if (alive) setUrl(u || null); }, () => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [root, project.id, music]);

  useEffect(() => {
    if (!music) return;
    let alive = true;
    setSnap(null);
    void pv().pvBeats(root, project.id).then((b) => {
      if (!alive) return;
      setBeats(b);
      if (b) setGrid({ bpm: String(b.bpm), offset: String(b.offset), beatsPerBar: String(b.beatsPerBar) });
    }, (e) => { if (alive) { setBeats(null); setError(`节拍数据读不出来：${cleanError(e)}`); } });
    return () => { alive = false; };
  }, [root, project.id, status, music]);

  if (!music) {
    return (
      <div className="rs-callout">
        <p>还没有配乐。先到「素材」步导入一首歌，再点它的「设为配乐」，回来才能分析节拍。</p>
        <div className="rs-actions"><span className="spacer" /><button type="button" className="send rs-accent" onClick={() => onGo("assets")}>去素材步</button></div>
      </div>
    );
  }
  if (assets && !assets.some((a) => a.file === music)) {
    return (
      <div className="rs-callout warn">
        <p>配乐「{music}」在素材里找不到了。到「素材」步重新导入它，或者另选一首设为配乐。</p>
        <div className="rs-actions"><span className="spacer" /><button type="button" className="send rs-accent" onClick={() => onGo("assets")}>去素材步</button></div>
      </div>
    );
  }

  const num = (v: string) => Number(v);
  const gridOk = num(grid.bpm) >= 40 && num(grid.bpm) <= 240 && grid.offset.trim() !== "" && num(grid.offset) >= 0 && Number.isInteger(num(grid.beatsPerBar)) && num(grid.beatsPerBar) >= 1 && num(grid.beatsPerBar) <= 12;
  async function applyGrid() {
    setError(""); setSnap(null);
    try {
      const b = await pv().pvSetBeatGrid(root, project.id, { bpm: num(grid.bpm), offset: num(grid.offset), beatsPerBar: num(grid.beatsPerBar) });
      setBeats(b);
      setGrid({ bpm: String(b.bpm), offset: String(b.offset), beatsPerBar: String(b.beatsPerBar) });
    } catch (e) { setError(`没改成：${cleanError(e)}`); }
  }
  async function preview(unit: "bar" | "beat") {
    setError(""); setSaved(false);
    try {
      const [before, after] = await Promise.all([pv().pvStoryboard(root, project.id), pv().pvSnapStoryboard(root, project.id, unit)]);
      setSnap({ unit, before, after });
    } catch (e) { setSnap(null); setError(`没算出来：${cleanError(e)}`); }
  }
  async function confirm() {
    if (!snap) return;
    setError("");
    try { await pv().pvSaveStoryboard(root, project.id, snap.after); setSnap(null); setSaved(true); } catch (e) { setError(`分镜没存上：${cleanError(e)}`); }
  }

  // Beats left over from another song are not usable for this one.
  const stale = !!beats && beats.file !== music;
  const usable = beats && !stale ? beats : null;

  return (
    <div className="pv-beats">
      <p className="hint">配乐：{music}。节拍是电脑估算的，不一定每首歌都准，定稿前请自己听一遍切点。</p>
      {url ? <audio key={url} className="pv-audio" src={url} controls preload="metadata" aria-label="试听配乐" onError={() => setUrl(null)} />
        : url === null && <p className="warn-text">配乐加载不了，暂时没法试听。到「素材」步看看这个文件还在不在。</p>}
      {ffMissing && <p className="warn-text">分析节拍要用 ffmpeg，现在还没装好。<button type="button" className="link-btn" onClick={() => onGo("render")}>去「出片」步装一下</button></p>}
      {error && <p className="err-text">{error}</p>}
      {status === "running" && <p className="hint">正在分析节拍，一般几秒钟…</p>}
      {status === "error" && <p className="err-text">节拍没分析出来{failure ? `：${failure}` : "。"}{failure && !/[。.！!]$/.test(failure) ? "。" : ""}看看 ffmpeg 装好没有、配乐能不能正常播放，再点右上角重新分析。</p>}
      {beats === undefined ? <p className="hint">读取中…</p> : stale ? (
        <p className="warn-text">现在存着的节拍是给「{beats?.file}」算的，配乐已经换成「{music}」了。点右上角重新分析一次再用。</p>
      ) : !usable ? (
        status !== "running" && status !== "error" && <p className="hint pv-empty">还没分析过。点右上角「分析节拍」，一般几秒钟。</p>
      ) : (
        <>
          <div className="pv-beat-stats">
            <div><span className="hint">速度</span><b>{usable.bpm} BPM</b></div>
            <div><span className="hint">第一拍位置</span><b>{fmtSecs(usable.offset)}</b></div>
            <div><span className="hint">把握程度</span><b className={usable.confidence >= 0.6 ? "ok-text" : "warn-text"}>{Math.round(usable.confidence * 100)}%</b></div>
            <div><span className="hint">共</span><b>{usable.beats.length} 拍 / {usable.bars.length} 小节</b></div>
          </div>
          {usable.confidence < 0.6 && <p className="warn-text">把握不大，可能听错了速度（比如实际是一半或两倍）。下面的数字可以自己改。</p>}
          <div className="pv-grid-form">
            <label className="pv-fld"><span>每分钟拍数 BPM</span><input type="number" min={40} max={240} step={0.1} value={grid.bpm} onChange={(e) => setGrid({ ...grid, bpm: e.target.value })} /></label>
            <label className="pv-fld"><span>第一拍在第几秒</span><input type="number" min={0} step={0.01} value={grid.offset} onChange={(e) => setGrid({ ...grid, offset: e.target.value })} /></label>
            <label className="pv-fld"><span>每小节几拍</span><input type="number" min={1} max={12} step={1} value={grid.beatsPerBar} onChange={(e) => setGrid({ ...grid, beatsPerBar: e.target.value })} /></label>
            <button type="button" className="mini-btn" disabled={!gridOk} onClick={() => void applyGrid()}>应用修改</button>
          </div>
          {!gridOk && <p className="warn-text">BPM 要在 40 到 240 之间，第一拍不能是负数，每小节 1 到 12 拍（整数）。</p>}
          <div className="rs-actions">
            <span className="hint">把每个镜头的时长凑成整数个：</span>
            <button type="button" className="mini-btn" onClick={() => void preview("bar")}>吸附到小节</button>
            <button type="button" className="mini-btn" onClick={() => void preview("beat")}>吸附到拍</button>
            {saved && <span className="ok-text">分镜已更新</span>}
          </div>
          {snap && <SnapPreview snap={snap} target={project.seconds} musicSeconds={usable.duration} onCancel={() => setSnap(null)} onConfirm={() => void confirm()} onGo={onGo} />}
        </>
      )}
    </div>
  );
}

function SnapPreview({ snap, target, musicSeconds, onCancel, onConfirm, onGo }: { snap: { unit: "bar" | "beat"; before: PvStoryboard; after: PvStoryboard }; target: number; musicSeconds: number; onCancel(): void; onConfirm(): void; onGo(step: PvStep): void }) {
  if (snap.after.shots.length === 0) {
    return (
      <div className="pv-snap">
        <p className="hint">还没有分镜，没有镜头可以吸附。先到「分镜」步把镜头写出来。</p>
        <div className="rs-actions"><span className="spacer" /><button type="button" className="mini-btn" onClick={onCancel}>知道了</button><button type="button" className="send rs-accent" onClick={() => onGo("storyboard")}>去分镜步</button></div>
      </div>
    );
  }
  const was = new Map(snap.before.shots.map((s) => [s.id, s.seconds]));
  const total = sum(snap.after);
  const diff = round2(total - sum(snap.before));
  const gap = round2(total - target);
  const changed = snap.after.shots.some((s) => was.get(s.id) !== s.seconds);
  return (
    <div className="pv-snap">
      <table>
        <thead><tr><th>镜头</th><th>吸附前</th><th>吸附后</th></tr></thead>
        <tbody>
          {snap.after.shots.map((s, i) => {
            const b = was.get(s.id);
            return <tr key={s.id} className={b !== s.seconds ? "changed" : undefined}><td>{i + 1}</td><td>{b === undefined ? "—" : fmtSecs(b)}</td><td>{fmtSecs(s.seconds)}</td></tr>;
          })}
        </tbody>
        <tfoot><tr><td>合计</td><td>{fmtSecs(sum(snap.before))}</td><td>{fmtSecs(total)}（{diff >= 0 ? "+" : ""}{diff} 秒）</td></tr></tfoot>
      </table>
      {!changed ? <p className="hint">每个镜头本来就卡在{UNIT[snap.unit]}上，不用改。</p>
        : Math.abs(gap) < 0.05 ? <p className="ok-text">吸附后总长正好是目标的 {target} 秒。</p>
        : <p className="warn-text">吸附后总长 {fmtSecs(total)}，比目标 {target} 秒{gap > 0 ? "多" : "少"} {Math.abs(gap)} 秒。可以先保存，再到「分镜」步加减镜头凑一下；也可以试试吸附到{UNIT[snap.unit === "bar" ? "beat" : "bar"]}。</p>}
      {musicSeconds > 0 && total > musicSeconds + 0.05 && <p className="warn-text">吸附后比配乐（{fmtSecs(musicSeconds)}）还长，片尾会有一段没有音乐。</p>}
      <div className="rs-actions"><span className="hint">吸附到{UNIT[snap.unit]}，点确认才会改分镜。</span><span className="spacer" /><button type="button" className="mini-btn" onClick={onCancel}>算了</button><button type="button" className="send rs-accent" disabled={!changed} onClick={onConfirm}>确认并保存分镜</button></div>
    </div>
  );
}
