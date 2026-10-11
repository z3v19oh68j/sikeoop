import { useEffect, useMemo, useRef, useState } from "react";
import type { BibFormat, BibState, BibSyncResult, CiteStyle, ZoteroCollection, ZoteroItem, ZoteroStatus } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, type Tone } from "../settings/ui";
import { authorsText, cleanError } from "./common";
import { insertIntoEditor } from "./editorInsert";
import { usePaperTools } from "./ToolDownload";
import { TypesetPanel } from "./TypesetPanel";
import { ZoteroSetup } from "./ZoteroSetup";

const ZOTERO_STATE: Record<ZoteroStatus["state"], { text: string; tone: Tone }> = {
  ready: { text: "已连接", tone: "ok" },
  not_running: { text: "没有打开", tone: "warn" },
  no_bbt: { text: "缺少 Better BibTeX", tone: "warn" },
  outdated: { text: "版本太旧", tone: "warn" },
};
const CITABLE = /\.(qmd|md|markdown|tex|ltx|txt)$/i;
const styleOf = (file: string | undefined): CiteStyle => (file && /\.(tex|ltx)$/i.test(file) ? "latex" : "pandoc");
const folderOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "");

interface Props {
  /** Shown now. Zotero and Quarto are only looked for once the tab has been opened. */
  active: boolean;
  /** The file open in the editor, when there is one. */
  editorFile?: string;
  /** Puts a citation into 写作与润色's input. */
  onToWriting(text: string): void;
  /** Opens a project file in the editor. */
  onOpenFile?(path: string): void;
}

/**
 * 引用与排版: citations from the user's Zotero (through Better BibTeX on this computer only), the
 * project's references.bib kept filled from it, and typesetting with the user's Quarto.
 */
export function CiteTab({ active, editorFile, onToWriting, onOpenFile }: Props) {
  const opened = useRef(false);
  const tools = usePaperTools(active);
  const [zotero, setZotero] = useState<ZoteroStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [documents, setDocuments] = useState<string[]>([]);
  const [doc, setDoc] = useState("");
  const [styleChoice, setStyleChoice] = useState<CiteStyle | null>(null);
  const [picking, setPicking] = useState(false);
  const [cite, setCite] = useState<{ text: string; keys: string[] } | null>(null);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [terms, setTerms] = useState("");
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<ZoteroItem[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [importing, setImporting] = useState("");

  const target = editorFile && CITABLE.test(editorFile) ? editorFile : undefined;
  const style = styleChoice ?? styleOf(target ?? doc);
  const ready = zotero?.state === "ready";

  async function detect() {
    setChecking(true);
    try {
      setZotero(await window.sweet.zoteroStatus());
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setChecking(false);
    }
  }

  async function loadDocuments(prefer?: string) {
    const list = await window.sweet.quartoDocuments().catch(() => [] as string[]);
    setDocuments(list);
    setDoc((cur) => prefer ?? (cur && list.includes(cur) ? cur : target && list.includes(target) ? target : (list[0] ?? "")));
  }

  useEffect(() => {
    if (!active || opened.current) return;
    opened.current = true;
    void detect();
    void loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function run(work: () => Promise<void>) {
    setError("");
    setDone("");
    try {
      await work();
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function pick() {
    setPicking(true);
    await run(async () => {
      const picked = await window.sweet.zoteroPick(style);
      if (picked) setCite({ text: picked.text, keys: picked.keys });
      else setDone("没有选文献。");
    });
    setPicking(false);
  }

  async function search() {
    setSearching(true);
    await run(async () => {
      setItems(await window.sweet.zoteroSearch(terms));
      setChosen([]);
    });
    setSearching(false);
  }

  async function citeChosen() {
    await run(async () => setCite({ text: await window.sweet.citeFormat(chosen.map((citekey) => ({ citekey })), style), keys: chosen }));
  }

  async function importPdf(item: ZoteroItem) {
    setImporting(item.citekey);
    await run(async () => {
      const paper = await window.sweet.zoteroImport(item);
      setDone(`已把「${paper.title}」导入论文工坊。到「读论文」里看；转证据库时它的来源会记成 ${item.citekey}，写作时可以直接引用。`);
    });
    setImporting("");
  }

  return (
    <div className="pp-cite">
      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="book" />
          <h3>Zotero</h3>
          {zotero && <StatusBadge tone={ZOTERO_STATE[zotero.state].tone}>{ZOTERO_STATE[zotero.state].text}</StatusBadge>}
          {zotero?.state === "ready" && (
            <span className="hint">
              Zotero {zotero.zotero} · Better BibTeX {zotero.betterBibtex}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="mini-btn" disabled={checking} onClick={() => void detect()}>
            <Icon name="refresh" /> {checking ? "正在检测…" : "重新检测"}
          </button>
        </header>
        <p className="hint">引用来自你自己电脑上的 Zotero（要装 Better BibTeX 插件）。取引用时 sikeoop 只和本机的 Zotero 说话（127.0.0.1:23119），不经过任何网络服务。这两个软件 sikeoop 都不自带；没装的话，可以在下面让它从官方地址帮你下载。</p>
        {zotero && !ready && (
          <div className="rs-callout warn">
            <b>{zotero.message}</b>
            <ol className="pc-steps">
              {zotero.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        )}
        {zotero && !ready && tools.state && <ZoteroSetup status={zotero} installed={tools.state.zoteroInstalled} tasks={tools.tasks} onRecheck={() => void detect()} />}
      </section>

      <section className="rs-card">
        <header className="rs-card-head">
          <Icon name="plus" />
          <h3>插入引用</h3>
          <span className="spacer" />
          <div className="seg" role="radiogroup" aria-label="引用的写法">
            {(
              [
                ["pandoc", "Markdown / Quarto"],
                ["latex", "LaTeX"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={style === id} className={style === id ? "on" : undefined} onClick={() => setStyleChoice(id)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        <p className="hint">
          写法：<code>{style === "latex" ? "\\cite{key}" : "[@key]"}</code>
          {target ? `。编辑器里开着 ${target}，引用可以直接插到光标处。` : "。在编辑器里打开文稿（.qmd / .md / .tex），引用就能直接插到光标处。"}
        </p>
        <div className="rs-actions">
          <button type="button" className="send rs-accent" disabled={!ready || picking} onClick={() => void pick()} title="调起 Zotero 自己的引用选择框，可以填页码、前后缀">
            {picking ? "到 Zotero 里选文献…" : "用 Zotero 的选择框选文献"}
          </button>
          {picking && (
            <button type="button" className="mini-btn" onClick={() => void window.sweet.zoteroCancelPick()} title="sikeoop 不再等；Zotero 那边的选择框要你自己关掉">
              不等了
            </button>
          )}
          <span className="hint">{picking ? "选择框在 Zotero 的窗口里，可能被别的窗口挡住了。" : "或者在下面按标题、作者搜索。"}</span>
        </div>
        <form
          className="rs-actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && terms.trim() && !searching) void search();
          }}
        >
          <input className="rs-input pp-wide" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="搜索 Zotero 文献库：标题、作者、年份" aria-label="搜索 Zotero 文献库" />
          <button type="submit" className="mini-btn" disabled={!ready || !terms.trim() || searching}>
            <Icon name="eye-search" /> {searching ? "正在找…" : "搜索"}
          </button>
        </form>
        {items &&
          (items.length === 0 ? (
            <p className="hint">没有找到。换个词试试，或确认这篇文献已经在 Zotero 里。</p>
          ) : (
            <>
              <ul className="pc-items">
                {items.map((it) => (
                  <li key={it.citekey}>
                    <label>
                      <input type="checkbox" checked={chosen.includes(it.citekey)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, it.citekey] : c.filter((k) => k !== it.citekey)))} />
                      <span className="pc-item-main">
                        <b>{it.title}</b>
                        <span className="hint">
                          {[authorsText(it.authors), it.year, it.venue].filter(Boolean).join(" · ")} · <code>{it.citekey}</code>
                        </span>
                      </span>
                    </label>
                    <button type="button" className="mini-btn" disabled={!!importing} onClick={() => void importPdf(it)} title="把它的 PDF 附件读进论文工坊，可以总结、翻译、转证据库">
                      {importing === it.citekey ? "正在导入…" : "导入 PDF"}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="rs-actions">
                <span className="hint">已选 {chosen.length} 篇</span>
                <span className="spacer" />
                <button type="button" className="mini-btn" disabled={!chosen.length} onClick={() => void citeChosen()}>
                  生成引用
                </button>
              </div>
            </>
          ))}
        {cite && (
          <div className="rs-callout pc-cite" role="status">
            <code className="pc-cite-text">{cite.text}</code>
            <div className="rs-actions">
              {cite.keys.length > 0 && <span className="hint">{cite.keys.length} 篇文献。排版前记得同步 references.bib。</span>}
              <span className="spacer" />
              {target && (
                <button
                  type="button"
                  className="send rs-accent"
                  onClick={() => (insertIntoEditor(target, cite.text) ? setDone(`已插入到 ${target} 的光标处（还没保存）。`) : setError(`${target} 现在没有以源码方式打开，引用没有插进去。先复制，再到编辑器里粘贴。`))}
                >
                  插入到编辑器光标处
                </button>
              )}
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  onToWriting(cite.text);
                  setDone("");
                }}
              >
                放进写作页
              </button>
              <button type="button" className="mini-btn" onClick={() => void navigator.clipboard.writeText(cite.text).then(() => setDone("已复制。"))}>
                <Icon name="copy" /> 复制
              </button>
            </div>
          </div>
        )}
        {error && <p className="err-text">{error}</p>}
        {done && <p className="hint">{done}</p>}
      </section>

      <BibCard ready={ready} doc={doc} documents={documents} editorFile={target} />

      <TypesetPanel active={active} documents={documents} doc={doc} onDoc={setDoc} onOpenFile={onOpenFile} onDocumentsChanged={(prefer) => void loadDocuments(prefer)} quartoTask={tools.tasks.quarto} />
    </div>
  );
}

/** references.bib: filled from Zotero by collection, or with just what the documents cite. */
function BibCard({ ready, doc, documents, editorFile }: { ready: boolean; doc: string; documents: string[]; editorFile?: string }) {
  const [file, setFile] = useState("");
  const [touched, setTouched] = useState(false);
  const [format, setFormat] = useState<BibFormat>("biblatex");
  const [state, setState] = useState<BibState | null>(null);
  const [mode, setMode] = useState<"used" | "collection">("used");
  const [collections, setCollections] = useState<ZoteroCollection[] | null>(null);
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BibSyncResult | null>(null);
  const [error, setError] = useState("");

  // What was used last time; a path typed by the user is never replaced.
  useEffect(() => {
    void window.sweet
      .bibState()
      .then((s) => {
        setFormat(s.settings.format);
        if (s.settings.collection) {
          setMode("collection");
          setCollection(`${s.settings.collection.libraryId}/${s.settings.collection.key}`);
        }
        if (s.exists) {
          setFile(s.settings.file);
          setTouched(true);
          setState(s);
        }
      })
      .catch(() => {});
  }, []);

  // Until the user says otherwise the file sits beside the document, where Quarto looks for it.
  useEffect(() => {
    if (!touched && doc) setFile(folderOf(doc) + "references.bib");
  }, [doc, touched]);

  useEffect(() => {
    if (!/\.bib$/i.test(file.trim())) return setState(null);
    const timer = setTimeout(() => void window.sweet.bibState(file.trim()).then(setState, () => setState(null)), 300);
    return () => clearTimeout(timer);
  }, [file, result]);

  useEffect(() => {
    if (mode === "collection" && ready && !collections) void window.sweet.zoteroCollections().then(setCollections, (e) => setError(cleanError(e)));
  }, [mode, ready, collections]);

  /** The chosen document, and a LaTeX file open in the editor: their citations are what gets pulled. */
  const sources = useMemo(() => [...new Set([doc, editorFile].filter((f): f is string => !!f))], [doc, editorFile]);
  const picked = collections?.find((c) => `${c.libraryId}/${c.key}` === collection);
  const canSync = ready && /\.bib$/i.test(file.trim()) && !busy && (mode === "used" ? sources.length > 0 : !!picked);

  async function sync() {
    setError("");
    setResult(null);
    setBusy(true);
    try {
      const base = { file: file.trim(), format };
      setResult(await window.sweet.bibSync(mode === "used" ? { mode, ...base, documents: sources } : { mode, ...base, libraryId: picked!.libraryId, key: picked!.key, path: picked!.path }));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-card">
      <header className="rs-card-head">
        <Icon name="files" />
        <h3>参考文献文件</h3>
        {state && <span className="hint">{state.exists ? `现有 ${state.entries} 条${state.updatedAt ? ` · ${new Date(state.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 更新` : ""}` : "还没有这个文件，同步时新建"}</span>}
        <span className="spacer" />
        <div className="seg" role="radiogroup" aria-label="参考文献格式">
          {(
            [
              ["biblatex", "BibLaTeX"],
              ["bibtex", "BibTeX"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={format === id} className={format === id ? "on" : undefined} onClick={() => setFormat(id)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      <input
        className="rs-input pp-wide pv-path"
        value={file}
        onChange={(e) => {
          setFile(e.target.value);
          setTouched(true);
        }}
        placeholder="references.bib"
        aria-label="参考文献文件在项目里的路径"
        spellCheck={false}
      />
      <p className="hint">Quarto、Pandoc 和 Typst 用 BibLaTeX 最合适；只有用传统 BibTeX 编译 LaTeX 时才选 BibTeX。文件要和文稿放在同一个文件夹。</p>
      <div className="rs-actions">
        <div className="seg" role="radiogroup" aria-label="同步哪些文献">
          {(
            [
              ["used", "只要文稿里引用到的"],
              ["collection", "整个 Zotero 集合"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? "on" : undefined} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "collection" && (
          <select className="rs-select" value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Zotero 集合" disabled={!collections?.length}>
            <option value="">{!ready ? "先连上 Zotero" : !collections ? "正在读集合…" : collections.length ? "选一个集合" : "Zotero 里还没有集合"}</option>
            {collections?.map((c) => (
              <option key={`${c.libraryId}/${c.key}`} value={`${c.libraryId}/${c.key}`}>
                {c.library} / {c.path}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button type="button" className="send rs-accent" disabled={!canSync} onClick={() => void sync()}>
          {busy ? "正在同步…" : "从 Zotero 同步"}
        </button>
      </div>
      <p className="hint">
        {mode === "used" ? (sources.length ? `会读 ${sources.join("、")} 里的引用，只拉这些文献。` : documents.length ? "先在下面的「排版」里选一个文稿。" : "项目里还没有 .qmd / .md 文稿：可以在下面新建一篇。") : "集合里的文献全部拉进来。"}
        同步只新增和更新，不删除：你手动加进文件的条目会原样保留。写入前会先问你。
      </p>
      {error && <p className="err-text">{error}</p>}
      {result && (
        <div className="rs-callout" role="status">
          <span>
            {result.added.length || result.updated.length ? `已写入 ${result.file}：新增 ${result.added.length} 条，更新 ${result.updated.length} 条` : `${result.file} 已经是最新的，没有改动`}
            {result.kept > 0 && `，另有 ${result.kept} 条是你手动加的，原样保留`}。现在共 {result.total} 条。
          </span>
          {result.missing.length > 0 && (
            <span>
              <b>Zotero 里找不到这些引用 key：</b>
              <code>{result.missing.join("、")}</code>。可能是 key 写错了，或这篇文献还没进 Zotero；不处理的话排版时这几处引用会显示成问号。
            </span>
          )}
        </div>
      )}
    </section>
  );
}
