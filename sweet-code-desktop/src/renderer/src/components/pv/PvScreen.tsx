import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { StatusBadge, cleanError } from "../settings/ui";
import { AssetsStep } from "./AssetsStep";
import { BeatsStep } from "./BeatsStep";
import { PackPanel } from "./PackPanel";
import { STEPS, pv, type PvAsset, type PvFfmpegState, type PvKind, type PvPack, type PvProject, type PvShot, type PvStep, type PvStoryboard } from "./types";
import "../../styles/settings.css";
import "../../styles/research.css";
import "../../styles/pv.css";

// PV 工坊 (docs/方案-PV工坊.md, 第一批): seven steps on the left, the current step's editor in the
// middle, the latest render on the right; the experience pack for the step underneath.

const STATUS_TONE = { todo: "muted", running: "accent", done: "ok", error: "bad" } as const;
const STATUS_TEXT = { todo: "未开始", running: "进行中", done: "完成", error: "出错" } as const;
const FILE_OF: Partial<Record<PvStep, string>> = { brief: "brief.md", script: "script.md" };
const SOURCE = { code: "代码画面", file: "文件素材", screen: "录屏", ai: "AI 生成" } as const;

export function PvScreen({ hidden, root }: { hidden: boolean; root: string | null }) {
  const [projects, setProjects] = useState<PvProject[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [packs, setPacks] = useState<PvPack[]>([]);
  const [ff, setFf] = useState<PvFfmpegState | null>(null);
  const [error, setError] = useState("");
  // Why a step failed, as told by the backend ("<project id>/<step>" → message); gone after a reload.
  const [notes, setNotes] = useState<Record<string, string>>({});

  const refresh = () => root && void pv().pvList(root).then((l) => { setProjects(l); setId((cur) => cur ?? l[0]?.id ?? null); });
  useEffect(() => {
    if (hidden || !root) return;
    refresh();
    void pv().pvPacks().then(setPacks);
    void pv().pvFfmpeg().then(setFf);
    return pv().onPvProgress((e) => {
      setProjects((l) => l.map((p) => (p.id === e.id ? { ...p, steps: { ...p.steps, [e.step]: e.status } } : p)));
      setNotes((n) => ({ ...n, [`${e.id}/${e.step}`]: e.status === "error" ? e.message ?? "" : "" }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, root]);

  const project = projects.find((p) => p.id === id) ?? null;

  return (
    <main className="research pv" hidden={hidden}>
      <div className="rs-inner pv-inner">
        <header className="rs-head">
          <div>
            <h1>PV 工坊</h1>
            <p className="hint">需求 → 脚本 → 分镜 → 卡点 → 素材 → 合成 → 出片，每一步都能看、能改。成片用 Remotion 生成在项目的 pv/ 文件夹里。</p>
          </div>
          <div className="pv-head-actions">
            {projects.length > 0 && (
              <select className="rs-select" value={id ?? ""} onChange={(e) => setId(e.target.value)} aria-label="选择片子">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button type="button" className="send rs-accent" disabled={!root} onClick={() => setCreating(true)}><Icon name="plus" /> 新建片子</button>
          </div>
        </header>
        {!root && <p className="rs-card hint">先打开一个项目，片子会放在项目的 pv/ 文件夹里。</p>}
        {error && <p className="err-text">{error}</p>}
        {creating && root && (
          <CreateDialog
            onCancel={() => setCreating(false)}
            onCreate={async (p) => {
              try {
                const made = await pv().pvCreate(root, p);
                setProjects((l) => [made, ...l]);
                setId(made.id);
                setCreating(false);
              } catch (e) { setError(cleanError(e)); }
            }}
          />
        )}
        {root && project ? <Workbench key={project.id} root={root} project={project} packs={packs} ff={ff} onFf={setFf} notes={notes} onProject={(p) => setProjects((l) => l.map((x) => (x.id === p.id ? p : x)))} /> : root && !creating && <p className="rs-card hint">还没有片子。点「新建片子」开始，比如给你的项目做一条 30 秒宣传片。</p>}
      </div>
    </main>
  );
}

function CreateDialog({ onCancel, onCreate }: { onCancel(): void; onCreate(p: { name: string; kind: PvKind; ratio: PvProject["ratio"]; seconds: number }): void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PvKind>("promo");
  const [ratio, setRatio] = useState<PvProject["ratio"]>("16:9");
  const [seconds, setSeconds] = useState(30);
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal pv-create" role="dialog" aria-label="新建片子" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), kind, ratio, seconds }); }}>
        <h2>新建片子</h2>
        <label className="pv-fld"><span>片名</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：sikeoop 30 秒宣传片" autoFocus /></label>
        <div className="pv-fld"><span>类型</span>
          <div className="seg">{(["promo", "music"] as const).map((k) => <button key={k} type="button" className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>{k === "promo" ? "产品宣传片" : "音乐 PV"}</button>)}</div>
        </div>
        <div className="pv-fld"><span>画面比例</span>
          <div className="seg">{(["16:9", "9:16", "1:1"] as const).map((r) => <button key={r} type="button" className={ratio === r ? "on" : undefined} onClick={() => setRatio(r)}>{r === "16:9" ? "16:9 横屏" : r === "9:16" ? "9:16 竖屏" : "1:1 方形"}</button>)}</div>
        </div>
        <label className="pv-fld"><span>时长（秒）</span><input type="number" min={5} max={600} value={seconds} onChange={(e) => setSeconds(Number(e.target.value) || 30)} /></label>
        <div className="row"><span className="spacer" /><button type="button" className="icon-btn" onClick={onCancel}>取消</button><button type="submit" className="send" disabled={!name.trim()}>创建</button></div>
      </form>
    </div>
  );
}

function Workbench({ root, project, packs, ff, onFf, notes, onProject }: { root: string; project: PvProject; packs: PvPack[]; ff: PvFfmpegState | null; onFf(s: PvFfmpegState): void; notes: Record<string, string>; onProject(p: PvProject): void }) {
  const [step, setStep] = useState<PvStep>("brief");
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [askFf, setAskFf] = useState(false);
  const [ffNote, setFfNote] = useState("");
  // null until the first read comes back.
  const [assets, setAssets] = useState<PvAsset[] | null>(null);
  const [assetsError, setAssetsError] = useState("");
  const loadAssets = () => { setAssetsError(""); void pv().pvAssets(root, project.id).then(setAssets, (e) => { setAssets([]); setAssetsError(cleanError(e)); }); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadAssets, [root, project.id]);
  const meta = STEPS.find((s) => s.id === step)!;
  const go = (s: PvStep) => { setError(""); setStep(s); };
  const note = notes[`${project.id}/${step}`];

  async function run(s: PvStep) {
    setError("");
    const was = project.steps[s];
    // Marked running before the call, so a quick "done" from the backend is never overwritten.
    onProject({ ...project, steps: { ...project.steps, [s]: "running" } });
    try {
      await pv().pvRunStep(root, project.id, s);
    } catch (e) {
      setError(cleanError(e));
      onProject({ ...project, steps: { ...project.steps, [s]: was } });
    }
  }
  async function render() {
    setError("");
    try {
      const out = await pv().pvRenderPreview(root, project.id);
      // Played through the backend's sikeoop-pv:// protocol (only files under pv/<id>/out/).
      const normalized = out.replace(/\\/g, "/");
      const marker = normalized.lastIndexOf("/out/");
      if (marker < 0) throw new Error("预览输出路径无效");
      setPreview({ path: out, url: await pv().pvPreviewUrl(root, project.id, normalized.slice(marker + 5)) });
    } catch (e) { setError(cleanError(e)); }
  }

  async function recheckFf() {
    setFfNote("检查中…");
    try {
      const s = await pv().pvFfmpeg();
      onFf(s);
      setFfNote(s.status === "ready" ? "" : "还是没找到。装完后可以新开一个终端跑 ffmpeg -version 确认一下，再回来检查。");
    } catch (e) { setFfNote(`没检查成：${cleanError(e)}`); }
  }
  const beatsDone = project.steps.beats === "done";
  const busy = Object.values(project.steps).includes("running");

  return (
    <div className="pv-bench">
      <nav className="pv-steps rs-card" aria-label="七个步骤">
        <div className="pv-meta hint">{project.kind === "promo" ? "宣传片" : "音乐 PV"} · {project.ratio} · {project.seconds} 秒</div>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={"pv-step" + (s.id === step ? " on" : "")} onClick={() => go(s.id)} aria-current={s.id === step ? "step" : undefined}>
                <span className={"pv-dot " + project.steps[s.id]}>{i + 1}</span>
                <span className="pv-step-name">{s.label}</span>
                <StatusBadge tone={STATUS_TONE[project.steps[s.id]]}>{STATUS_TEXT[project.steps[s.id]]}</StatusBadge>
              </button>
            </li>
          ))}
        </ol>
        {busy && <button type="button" className="mini-btn" onClick={() => void pv().pvCancel(root, project.id)}><Icon name="stop" /> 取消正在跑的步骤</button>}
      </nav>

      <section className="pv-editor rs-card">
        <header className="rs-card-head">
          <h3>{meta.label}</h3>
          <span className="spacer" />
          {step !== "render" && (
            <button type="button" className="send rs-accent" disabled={project.steps[step] === "running" || (step === "beats" && !project.music)} onClick={() => void run(step)}>
              {step === "beats" ? (project.steps.beats === "running" ? "分析中…" : beatsDone ? "重新分析节拍" : "分析节拍") : step === "assets" ? (project.steps.assets === "running" ? "检查中…" : "检查素材") : project.steps[step] === "running" ? "AI 在写…" : step === "compose" ? "让 AI 写 Remotion 组件" : project.steps[step] === "done" ? "让 AI 重写" : "让 AI 写"}
            </button>
          )}
        </header>
        {error && <p className="err-text">{error}</p>}
        {project.steps[step] === "error" && step !== "beats" && step !== "render" && (
          <p className="err-text">{step === "assets" ? "素材检查没过" : "这一步没跑成"}{note ? `：${note}` : "，再点一次右上角的按钮试试。"}{step === "assets" && note ? "　到「分镜」步给这些镜头选好素材，再回来检查。" : ""}</p>
        )}
        {step === "beats" ? (
          <BeatsStep root={root} project={project} assets={assetsError ? null : assets} ffMissing={!!ff && ff.status !== "ready"} failure={note} onGo={go} />
        ) : step === "assets" ? (
          <AssetsStep root={root} project={project} assets={assets} loadError={assetsError} onReload={loadAssets} onAssets={setAssets} onProject={onProject} />
        ) : FILE_OF[step] ? (
          <MarkdownStep key={step + project.steps[step]} root={root} id={project.id} file={FILE_OF[step]!} />
        ) : step === "storyboard" ? (
          <StoryboardStep key={project.steps.storyboard} root={root} id={project.id} target={project.seconds} assets={assets ?? []} />
        ) : step === "compose" ? (
          <p className="hint pv-empty">按分镜生成 Remotion 工程（pv/{project.id}/remotion/），再交给编程 AI 一个镜头一个镜头写组件。进度在「调度台」里能看到。</p>
        ) : (
          <div className="pv-render">
            <p className="hint">用 Remotion 渲染预览版，输出到 pv/{project.id}/out/。</p>
            {ff?.status === "ready" ? (
              <button type="button" className="send rs-accent" onClick={() => void render()}>出预览片</button>
            ) : ff?.status === "missing" && ff.hint ? (
              // The backend only looks for an installed ffmpeg here (macOS / Linux), so no download offer.
              <div className="rs-callout">
                <p>出片需要 ffmpeg，这台电脑上还没找到。sikeoop 在这个系统上不会代你下载，要自己装一下：</p>
                <p className="pv-ff-hint">{ff.hint}</p>
                {ff.error && <p className="warn-text">{ff.error}</p>}
                <div className="rs-actions">{ffNote && <span className="hint">{ffNote}</span>}<span className="spacer" /><button type="button" className="send rs-accent" disabled={ffNote === "检查中…"} onClick={() => void recheckFf()}>我装好了，重新检查</button></div>
              </div>
            ) : askFf || ff?.status === "downloading" ? (
              <div className="rs-callout">
                <p>出片需要 ffmpeg。sikeoop 不随包带它，会从官方镜像下载到本机的 sikeoop 工具文件夹（约 80 MB），下载后校验 sha256，你点同意后才会开始。</p>
                {ff?.status === "downloading" ? (
                  <div className="rs-bar" aria-label="下载进度"><span style={{ transform: `scaleX(${(ff.progress ?? 0) / 100})` }} /></div>
                ) : (
                  <div className="rs-actions"><span className="spacer" /><button type="button" className="mini-btn" onClick={() => setAskFf(false)}>先不要</button><button type="button" className="send rs-accent" onClick={() => void pv().pvFfmpegDownload().then(onFf)}>下载 ffmpeg</button></div>
                )}
              </div>
            ) : (
              <div className="rs-actions">
                <button type="button" className="send" disabled>出预览片</button>
                <span className="warn-text">还没有 ffmpeg{ff?.error ? `：${ff.error}` : ""}</span>
                <button type="button" className="link-btn" onClick={() => setAskFf(true)}>怎么装？</button>
              </div>
            )}
          </div>
        )}
        <PackPanel packs={packs} kind={project.kind} step={step} />
      </section>

      <aside className="pv-preview rs-card">
        <header className="rs-card-head"><Icon name="play" /><h3>预览</h3></header>
        {preview ? (
          <>
            <video key={preview.url} src={preview.url} controls className={"pv-video r" + project.ratio.replace(":", "x")} />
            <code className="pv-path" title={preview.path}>{preview.path}</code>
          </>
        ) : (
          <div className={"pv-video empty r" + project.ratio.replace(":", "x")}><span>还没出片</span></div>
        )}
      </aside>
    </div>
  );
}

function MarkdownStep({ root, id, file }: { root: string; id: string; file: string }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => { void pv().pvReadFile(root, id, file).then((t) => { setText(t); setSaved(t); }, () => { setText(""); setSaved(""); }); }, [root, id, file]);
  if (text === null) return <p className="hint">读取中…</p>;
  return (
    <div className="pv-md">
      <textarea className="rs-textarea pv-textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder={file === "brief.md" ? "这条片子给谁看、想让人记住什么、风格参考……也可以先点「让 AI 写」。" : "旁白和字幕，按时间写。"} aria-label={file} />
      <div className="rs-actions"><span className="hint">pv/{id}/{file} · Markdown</span><span className="spacer" />
        <button type="button" className="mini-btn" disabled={text === saved} onClick={() => void pv().pvWriteFile(root, id, file, text).then(() => setSaved(text))}>{text === saved ? "已保存" : "保存"}</button>
      </div>
    </div>
  );
}

function StoryboardStep({ root, id, target, assets }: { root: string; id: string; target: number; assets: PvAsset[] }) {
  const [sb, setSb] = useState<PvStoryboard | null>(null);
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => { void pv().pvStoryboard(root, id).then(setSb); }, [root, id]);
  if (!sb) return <p className="hint">读取中…</p>;
  const set = (shots: PvShot[]) => { setSb({ shots }); setDirty(true); };
  const patch = (i: number, p: Partial<PvShot>) => set(sb.shots.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (from: number, to: number) => { if (to < 0 || to >= sb.shots.length || from === to) return; const c = [...sb.shots]; const [x] = c.splice(from, 1); c.splice(to, 0, x); set(c); };
  const total = Math.round(sb.shots.reduce((a, s) => a + (s.seconds || 0), 0) * 10) / 10;

  return (
    <div className="pv-sb">
      <div className="rs-actions">
        <span className={total === target ? "ok-text" : "warn-text"}>总时长 {total} 秒 / 目标 {target} 秒</span>
        <span className="hint">{sb.shots.length} 个镜头 · 拖动左边的把手排序</span>
        <span className="spacer" />
        <button type="button" className="mini-btn" onClick={() => set([...sb.shots, { id: `s${Date.now()}`, seconds: 3, framing: "中景", camera: "固定", visual: "", source: "code" }])}><Icon name="plus" /> 加镜头</button>
        <button type="button" className="send rs-accent" disabled={!dirty} onClick={() => void pv().pvSaveStoryboard(root, id, sb).then(() => setDirty(false))}>{dirty ? "保存分镜" : "已保存"}</button>
      </div>
      {sb.shots.length === 0 && <p className="hint pv-empty">还没有分镜。点上面的「让 AI 写」，或者自己加镜头。</p>}
      <ol className="pv-shots">
        {sb.shots.map((s, i) => (
          <li key={s.id} className={"pv-shot" + (drag === i ? " dragging" : "")} draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}>
            <span className="pv-grip" title="拖动排序" aria-hidden="true">⋮⋮</span>
            <span className="pv-no">{i + 1}</span>
            <div className="pv-shot-fields">
              <label><span>秒</span><input type="number" min={0.5} step={0.5} value={s.seconds} onChange={(e) => patch(i, { seconds: Number(e.target.value) || 0 })} className="pv-sec" /></label>
              <label><span>景别</span><input value={s.framing} onChange={(e) => patch(i, { framing: e.target.value })} /></label>
              <label><span>运镜</span><input value={s.camera} onChange={(e) => patch(i, { camera: e.target.value })} /></label>
              <label><span>来源</span><select value={s.source} onChange={(e) => patch(i, { source: e.target.value as PvShot["source"] })}>{(Object.keys(SOURCE) as PvShot["source"][]).map((k) => <option key={k} value={k}>{SOURCE[k]}</option>)}</select></label>
              {(s.source === "file" || s.source === "screen") && (
                <label className="wide"><span>用哪个素材</span>
                  <select value={s.asset ?? ""} onChange={(e) => patch(i, { asset: e.target.value || undefined })}>
                    <option value="">（还没选）</option>
                    {s.asset && !assets.some((a) => a.file === s.asset) && <option value={s.asset}>{s.asset}（找不到）</option>}
                    {assets.filter((a) => a.kind !== "audio").map((a) => <option key={a.file} value={a.file}>{a.file}</option>)}
                  </select>
                </label>
              )}
              <label className="wide"><span>画面</span><input value={s.visual} onChange={(e) => patch(i, { visual: e.target.value })} /></label>
              <label><span>字幕</span><input value={s.caption ?? ""} onChange={(e) => patch(i, { caption: e.target.value })} /></label>
              <label><span>转场</span><input value={s.transition ?? ""} onChange={(e) => patch(i, { transition: e.target.value })} /></label>
            </div>
            <span className="pv-shot-ops">
              <button type="button" className="mini-btn icon-only" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="上移"><Icon name="arrow-up" /></button>
              <button type="button" className="mini-btn icon-only flip" disabled={i === sb.shots.length - 1} onClick={() => move(i, i + 1)} aria-label="下移"><Icon name="arrow-up" /></button>
              <button type="button" className="mini-btn icon-only" onClick={() => set(sb.shots.filter((_, j) => j !== i))} aria-label="删除镜头"><Icon name="trash" /></button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
