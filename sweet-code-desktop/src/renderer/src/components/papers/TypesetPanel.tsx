import { useEffect, useRef, useState } from "react";
import type { CslStyle, CslStyleId, PaperTemplateResult, QuartoFormat, QuartoRun, QuartoStatus, QuartoWatch, ToolTask } from "@shared/types";
import { Icon } from "../Icon";
import { IS_MAC, StatusBadge, type Tone } from "../settings/ui";
import { cleanError } from "./common";
import { ToolDownload } from "./ToolDownload";

const FORMATS: { id: QuartoFormat; label: string; hint: string }[] = [
  { id: "pdf", label: "PDF", hint: "用 Quarto 自带的 Typst 排，不需要装 LaTeX" },
  { id: "docx", label: "Word", hint: "投稿或给导师批注用" },
  { id: "html", label: "网页", hint: "可以在 sikeoop 的浏览器里看" },
];
const FORMAT_LABEL: Record<QuartoFormat, string> = { pdf: "PDF", docx: "Word", html: "网页" };
const RUN_STATUS: Record<QuartoRun["status"], { text: string; tone: Tone }> = {
  queued: { text: "排队中", tone: "muted" },
  running: { text: "排版中", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  failed: { text: "没排成", tone: "bad" },
  cancelled: { text: "已取消", tone: "muted" },
};
const live = (r: QuartoRun) => r.status === "queued" || r.status === "running";
const time = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface Props {
  active: boolean;
  documents: string[];
  doc: string;
  onDoc(doc: string): void;
  onOpenFile?(path: string): void;
  /** A paper was added: the list of documents has to be read again (and the new one chosen). */
  onDocumentsChanged(prefer?: string): void;
  /** The download of Quarto going on (or just ended), when sikeoop is fetching a copy. */
  quartoTask?: ToolTask;
}

/** 排版: the chosen document through Quarto (the user's own first, else a copy sikeoop downloaded), each rendering a dispatch-core job. */
export function TypesetPanel({ active, documents, doc, onDoc, onOpenFile, onDocumentsChanged, quartoTask }: Props) {
  const opened = useRef(false);
  const [status, setStatus] = useState<QuartoStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [runs, setRuns] = useState<QuartoRun[]>([]);
  const [watch, setWatch] = useState<QuartoWatch | null>(null);
  const [watchFormat, setWatchFormat] = useState<QuartoFormat>("html");
  const [execute, setExecute] = useState(false);
  const [error, setError] = useState("");

  async function detect() {
    setChecking(true);
    try {
      setStatus(await window.sweet.quartoStatus());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void window.sweet.quartoRuns().then(setRuns);
    void window.sweet.quartoWatching().then(setWatch);
    return window.sweet.onQuartoEvent((e) => {
      if (e.type === "watch") setWatch(e.watch);
      else setRuns((list) => (list.some((r) => r.id === e.run.id) ? list.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...list].slice(0, 30)));
    });
  }, []);

  useEffect(() => {
    if (!active || opened.current) return;
    opened.current = true;
    void detect();
  }, [active]);

  async function run(work: () => Promise<unknown>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const found = !!status?.found;
  const shown = runs.filter((r) => !doc || r.file === doc).slice(0, 6);
  const watchingThis = !!watch && watch.file === doc;

  return (
    <>
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="play" />
          <h3>排版</h3>
          {status && <StatusBadge tone={found ? (status.typst ? "ok" : "warn") : "warn"}>{found ? `Quarto ${status.version}` : "没有找到 Quarto"}</StatusBadge>}
          <span className="spacer" />
          <button type="button" className="mini-btn" disabled={checking} onClick={() => void detect()}>
            <Icon name="refresh" /> {checking ? "正在检测…" : "重新检测"}
          </button>
        </header>
        {status?.message && (
          <div className="rs-callout warn">
            <b>{status.message}</b>
            <ol className="pc-steps">
              {status.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        )}
        {status && (!found || !status.typst) && (
          <ToolDownload
            tool="quarto"
            task={quartoTask}
            about={`约 ${IS_MAC ? 240 : 140} MB，来自 GitHub 上 quarto-dev/quarto-cli 的 Releases（MIT；内含 Pandoc 等组件，各自的许可见包内说明）。先告诉你确切的版本和大小，你确认后才开始下载。`}
            onDone={() => void detect()}
          />
        )}
        {status?.managed && <p className="hint">正在用 sikeoop 下载的 Quarto {status.version}。在「设置 → 编辑器与联网」里可以更新或删除它；你自己装了 Quarto 的话，会优先用你的。</p>}
        {documents.length === 0 ? (
          <p className="hint">项目里还没有 .qmd 或 .md 文稿。可以在下面用模板新建一篇。</p>
        ) : (
          <div className="rs-actions">
            <span className="rs-label">文稿</span>
            <select className="rs-select pc-doc" value={doc} onChange={(e) => onDoc(e.target.value)} aria-label="要排版的文稿">
              {documents.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            {onOpenFile && doc && (
              <button type="button" className="mini-btn" onClick={() => onOpenFile(doc)}>
                在编辑器里打开
              </button>
            )}
          </div>
        )}
        {doc && (
          <>
            <div className="rs-actions">
              <span className="rs-label">排成</span>
              {FORMATS.map((f) => (
                <button key={f.id} type="button" className="send rs-accent" disabled={!found || (f.id === "pdf" && !status?.typst)} title={f.hint} onClick={() => void run(() => window.sweet.quartoRender({ file: doc, format: f.id, execute }))}>
                  {f.label}
                </button>
              ))}
              <span className="hint">输出放在文稿旁边。每次排版是调度台里的一个任务，可以取消。</span>
            </div>
            <label className="pc-check">
              <input type="checkbox" checked={execute} onChange={(e) => setExecute(e.target.checked)} />
              <span>运行文稿里的代码块（R、Python 等）。默认不运行：排版只管排版，不会替你执行代码。</span>
            </label>
            <div className="rs-actions">
              <span className="rs-label">实时预览</span>
              <div className="seg" role="radiogroup" aria-label="实时预览的格式">
                {FORMATS.map((f) => (
                  <button key={f.id} type="button" role="radio" aria-checked={(watchingThis ? watch.format : watchFormat) === f.id} className={(watchingThis ? watch.format : watchFormat) === f.id ? "on" : undefined} disabled={watchingThis} onClick={() => setWatchFormat(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
              {watchingThis ? (
                <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.quartoWatch(null))}>
                  <Icon name="stop" /> 停止
                </button>
              ) : (
                <button type="button" className="mini-btn" disabled={!found} onClick={() => void run(() => window.sweet.quartoWatch({ file: doc, format: watchFormat, execute }))}>
                  保存后自动重排
                </button>
              )}
              <span className="hint">{watchingThis ? `开着：每次保存 ${doc} 都会重新排成${FORMAT_LABEL[watch.format]}。` : watch ? `正在盯着 ${watch.file}；换成这篇会停掉那一篇。` : "打开后，每次保存文稿都会自动重新排一遍。"}</span>
            </div>
          </>
        )}
        {error && <p className="err-text">{error}</p>}
        {shown.length > 0 && (
          <ul className="pc-runs">
            {shown.map((r) => (
              <li key={r.id}>
                <div className="pc-run-head">
                  <b>{FORMAT_LABEL[r.format]}</b>
                  <StatusBadge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].text}</StatusBadge>
                  <span className="hint">
                    {time(r.startedAt)}
                    {r.trigger === "save" && " · 保存后自动"}
                    {r.endedAt && ` · 用了 ${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))} 秒`}
                  </span>
                  <span className="spacer" />
                  {live(r) && (
                    <button type="button" className="mini-btn" onClick={() => void window.sweet.quartoCancel(r.id)}>
                      <Icon name="stop" /> 取消
                    </button>
                  )}
                  {r.output && (
                    <button type="button" className="mini-btn" onClick={() => void run(() => window.sweet.quartoOpen(r.output!))} title={r.format === "html" ? "在 sikeoop 的浏览器里打开" : "用系统里的程序打开"}>
                      打开 {r.output.split("/").pop()}
                    </button>
                  )}
                </div>
                {live(r) && (
                  <div className="rs-bar indeterminate" aria-hidden="true">
                    <span />
                  </div>
                )}
                {r.points.length > 0 && (
                  <ul className={"pc-points" + (r.status === "failed" ? " bad" : "")}>
                    {r.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {r.status === "failed" && r.log && (
                  <details className="pc-log">
                    <summary>Quarto 的原始输出</summary>
                    <pre>{r.log}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <NewPaper
        onMade={(made) => {
          onDocumentsChanged(made.document);
          onOpenFile?.(made.document);
        }}
      />
    </>
  );
}

/** 新建论文: a Quarto document with title, authors, abstract, references.bib and a citation style. */
function NewPaper({ onMade }: { onMade(made: PaperTemplateResult): void }) {
  const [open, setOpen] = useState(false);
  const [styles, setStyles] = useState<CslStyle[]>([]);
  const [dir, setDir] = useState("paper");
  const [name, setName] = useState("paper");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [abstract, setAbstract] = useState("");
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [csl, setCsl] = useState<CslStyleId>("gbt7714");
  const [cslTouched, setCslTouched] = useState(false);
  const [download, setDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<PaperTemplateResult | null>(null);

  useEffect(() => {
    if (open) void window.sweet.cslStyles().then(setStyles, () => {});
  }, [open, made]);

  // Chinese papers default to GB/T 7714, English ones to APA, until the user picks one.
  useEffect(() => {
    if (!cslTouched) setCsl(lang === "zh" ? "gbt7714" : "apa");
  }, [lang, cslTouched]);

  const style = styles.find((s) => s.id === csl);

  async function create() {
    setError("");
    setMade(null);
    setBusy(true);
    try {
      const result = await window.sweet.quartoNewPaper({ dir: dir.trim(), name: name.trim(), title: title.trim(), authors: authors.split(/[\n,，、;；]+/).map((a) => a.trim()).filter(Boolean), abstract, lang, csl, downloadCsl: download });
      setMade(result);
      onMade(result);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-card">
      <header className="rs-card-head">
        <Icon name="folder-plus" />
        <h3>用模板新建论文</h3>
        <span className="spacer" />
        <button type="button" className="mini-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开"}
        </button>
      </header>
      {!open ? (
        <p className="hint">一篇带标题、作者、摘要、参考文献文件和引用格式的 Quarto 文稿，建好就能排版。</p>
      ) : (
        <>
          <div className="pc-grid">
            <label className="rs-field">
              <span className="rs-label">标题</span>
              <input className="rs-input pp-wide" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="论文标题" />
            </label>
            <label className="rs-field">
              <span className="rs-label">作者（用逗号或换行分开）</span>
              <input className="rs-input pp-wide" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="张三，李四" />
            </label>
            <label className="rs-field">
              <span className="rs-label">放在项目里的哪个文件夹</span>
              <input className="rs-input pp-wide pv-path" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="留空就放在项目根目录" spellCheck={false} />
            </label>
            <label className="rs-field">
              <span className="rs-label">文件名（不带扩展名）</span>
              <input className="rs-input pp-wide pv-path" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </label>
          </div>
          <label className="rs-field">
            <span className="rs-label">摘要（可以先空着）</span>
            <textarea className="rs-textarea" rows={3} value={abstract} onChange={(e) => setAbstract(e.target.value)} />
          </label>
          <div className="rs-actions">
            <span className="rs-label">语言</span>
            <div className="seg" role="radiogroup" aria-label="论文语言">
              {(
                [
                  ["zh", "中文"],
                  ["en", "English"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={lang === id} className={lang === id ? "on" : undefined} onClick={() => setLang(id)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="rs-label">引用格式</span>
            <select
              className="rs-select"
              value={csl}
              onChange={(e) => {
                setCsl(e.target.value as CslStyleId);
                setCslTouched(true);
              }}
              aria-label="引用格式"
            >
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          {style &&
            (style.cached ? (
              <p className="hint">
                引用格式文件 <code>{style.file}</code> 之前已经下载过，会原样放到论文旁边（来自 CSL 官方样式库，{style.license} 许可，文件里带着作者署名）。
              </p>
            ) : (
              <div className="rs-callout">
                <span>
                  sikeoop 不自带引用格式文件。<b>{style.title}</b> 的样式文件 <code>{style.file}</code> 来自 CSL 官方样式库（github.com/citation-style-language/styles），以 {style.license} 许可发布；下载后原样保存，文件里的作者署名和许可说明都保留。只在第一次用到时下载一次。
                </span>
                <label className="pc-check">
                  <input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} />
                  <span>现在联网下载这个文件（会访问 raw.githubusercontent.com，只取这一个文件，不发送任何内容）</span>
                </label>
                <span className="hint">不下载也能建：PDF 用 Typst 自带的同一套格式，Word 和网页先用 Pandoc 的默认格式，以后再补。</span>
              </div>
            ))}
          <div className="rs-actions">
            <span className="hint">只新增文件，不覆盖已有的；添加前会先问你。</span>
            <span className="spacer" />
            <button type="button" className="send rs-accent" disabled={busy || !title.trim() || !name.trim()} onClick={() => void create()}>
              {busy ? "正在新建…" : "新建论文"}
            </button>
          </div>
          {error && <p className="err-text">{error}</p>}
          {made && (
            <div className="rs-callout" role="status">
              <span>
                已新建 <code>{made.files.join("、")}</code>
                {made.skipped.length > 0 && `；${made.skipped.join("、")} 已经有了，没有动`}。文稿已经选好，可以直接排版。
              </span>
              {made.cslError && <span>引用格式文件没下载成（{made.cslError}），这篇先用内置的格式；之后可以再建一次或手动放一个 .csl 文件。</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
