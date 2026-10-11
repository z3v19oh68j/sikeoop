import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DiffFold, DiffHunk, DiffLine, FileChangeProposal } from "@shared/types";
import { fileIconName, Icon } from "./Icon";
import { useHighlighted } from "./Markdown";
import { languageForPath } from "../languages";
import { monaco } from "../monaco";

// The diff in a file change card: a header with the file and a +/− bar, then the changed code
// with syntax colors, word-level marks on modified lines, folded unchanged runs that expand in
// place, and a button to compare the whole file side by side in a Monaco diff editor.

/** "src/components/App.tsx" → dim "src/components/" + bright "App.tsx"; deep paths keep their end. */
export function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  const segs = path.slice(0, cut).split("/").filter(Boolean);
  const dir = segs.length > 3 ? `…/${segs.slice(-2).join("/")}/` : path.slice(0, cut);
  return (
    <span className="file-path" title={path}>
      <Icon name={fileIconName(path.slice(cut))} />
      <span className="where">
        {cut > 0 && <span className="dir">{dir}</span>}
        <span className="name">{path.slice(cut)}</span>
      </span>
    </span>
  );
}

/** +12 −3 and five blocks split by the share of added and removed lines, like GitHub. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const plus = total ? Math.round((added / total) * 5) : 0;
  const minus = total ? Math.min(5 - plus, Math.max(removed ? 1 : 0, Math.round((removed / total) * 5))) : 0;
  const blocks = [...Array(plus).fill("add"), ...Array(minus).fill("del")];
  while (blocks.length < 5) blocks.push("none");
  return (
    <span className="diff-stat" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
      {added > 0 && <span className="plus">+{added}</span>}
      {removed > 0 && <span className="minus">−{removed}</span>}
      <span className="blocks" aria-hidden="true">
        {blocks.slice(0, 5).map((b, i) => (
          <i key={i} className={b} />
        ))}
      </span>
    </span>
  );
}

interface BodyProps {
  id: string;
  change: FileChangeProposal;
}

/** The code part of a file change card. */
export function DiffBody({ id, change }: BodyProps) {
  const language = languageForPath(change.path);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [comparing, setComparing] = useState(false);
  const ws = change.hunks.reduce((n, h) => n + h.lines.filter((l) => l.ws && l.kind === "add").length, 0);
  const open = (k: number) => setExpanded((s) => new Set(s).add(k));
  const AFTER = -1;

  return (
    <>
      <div className="diff-toolbar">
        <span>
          {change.created ? `新文件，${change.added} 行` : `${change.hunks.length} 处改动`}
          {ws > 0 && <span className="ws-note"> · {ws} 行只改了缩进或空格</span>}
        </span>
        <span className="spacer" />
        {!change.created && (
          <button type="button" className="link-btn" onClick={() => setComparing(true)} title="在大窗口里左右对比整个文件">
            <Icon name="files" /> 左右对比
          </button>
        )}
      </div>
      <div className="diff" role="table" aria-label={`${change.path} 的改动`}>
        {change.hunks.map((h, i) => (
          <div key={i}>
            {h.before && (expanded.has(i) && h.before.lines ? <FoldLines fold={h.before} language={language} /> : <FoldRow fold={h.before} onOpen={() => open(i)} edge={i === 0 ? "top" : "mid"} />)}
            <Hunk hunk={h} language={language} />
          </div>
        ))}
        {change.after &&
          (expanded.has(AFTER) && change.after.lines ? (
            <FoldLines fold={change.after} language={language} />
          ) : (
            <FoldRow fold={change.after} onOpen={() => open(AFTER)} edge="bottom" />
          ))}
        {change.truncated && <div className="fold-row static">改动太长，只显示了前面一部分。点「左右对比」看全部。</div>}
      </div>
      {comparing && <DiffCompare id={id} path={change.path} onClose={() => setComparing(false)} />}
    </>
  );
}

function FoldRow({ fold, onOpen, edge }: { fold: DiffFold; onOpen(): void; edge: "top" | "mid" | "bottom" }) {
  const where = edge === "top" ? "上面" : edge === "bottom" ? "下面" : "中间";
  if (!fold.lines) return <div className="fold-row static">{where} {fold.count} 行没有改动</div>;
  return (
    <button type="button" className="fold-row" onClick={onOpen} title="展开这些没改动的代码">
      <Icon name="chevron-down" /> 展开{where} {fold.count} 行没改动的代码
    </button>
  );
}

function FoldLines({ fold, language }: { fold: DiffFold; language: string }) {
  const lines = fold.lines ?? [];
  const html = useHighlighted(lines.map((l) => l.text).join("\n"), language);
  return (
    <div className="hunk fold-open">
      {lines.map((l, j) => (
        <Line key={j} line={l} html={html?.[j]} />
      ))}
    </div>
  );
}

/**
 * One hunk, highlighted. The old and new sides are tokenized separately (each as continuous
 * code), so a removed line is colored the way it read before and an added one as it reads now.
 */
function Hunk({ hunk, language }: { hunk: DiffHunk; language: string }) {
  const oldSide = useHighlighted(hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text).join("\n"), language);
  const newSide = useHighlighted(hunk.lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n"), language);
  let o = 0;
  let n = 0;
  return (
    <div className="hunk">
      {hunk.lines.map((l, j) => {
        const html = l.kind === "del" ? oldSide?.[o++] : l.kind === "add" ? newSide?.[n++] : (o++, newSide?.[n++]);
        return <Line key={j} line={l} html={html} />;
      })}
    </div>
  );
}

function Line({ line: l, html }: { line: DiffLine; html?: string }) {
  const no = l.kind === "del" ? l.oldNo : l.newNo;
  return (
    <div className={`dl ${l.kind}${l.ws ? " ws" : ""}`} role="row">
      <span className="no">{no}</span>
      {/* Monaco escapes the code when it renders these lines; marks are added on top. */}
      {l.text ? <span className="txt" dangerouslySetInnerHTML={{ __html: withMarks(html, l.text, l.marks) }} /> : <span className="txt"> </span>}
    </div>
  );
}

// ---- word marks over syntax colors ---------------------------------------------------

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", "#160": " " };
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENTITY[e] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m));
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Monaco's colorized line as [class, text] runs, or null if it doesn't line up with the text. */
function runs(html: string, text: string): [string, string][] | null {
  const out: [string, string][] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|<[^>]+>|([^<]+)/g)) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[0] === "</span>") stack.pop();
    else if (m[2] !== undefined) out.push([stack[stack.length - 1] ?? "", decode(m[2])]);
  }
  const joined = out.map(([, t]) => t).join("");
  return joined.replace(/ /g, " ") === text.replace(/ /g, " ") ? out : null;
}

/** The line's HTML with changed character ranges wrapped in <mark>. */
export function withMarks(html: string | undefined, text: string, marks?: [number, number][]): string {
  if (!marks?.length) return html ?? escape(text);
  const parts = (html && runs(html, text)) || [["", text] as [string, string]];
  let pos = 0;
  let out = "";
  for (const [cls, t] of parts) {
    let chunk = "";
    for (let k = 0; k < t.length; ) {
      const at = pos + k;
      const inMark = marks.some(([x, y]) => at >= x && at < y);
      // Run to the next boundary (a mark start or end) within this text run.
      let end = k + 1;
      while (end < t.length && marks.some(([x, y]) => pos + end >= x && pos + end < y) === inMark) end++;
      const piece = escape(t.slice(k, end));
      chunk += inMark ? `<mark>${piece}</mark>` : piece;
      k = end;
    }
    out += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
    pos += t.length;
  }
  return out;
}

// ---- side-by-side compare ----------------------------------------------------------

/** The whole file before and after, in Monaco's diff editor, in a large overlay. */
function DiffCompare({ id, path, onClose }: { id: string; path: string; onClose(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [sideBySide, setSideBySide] = useState(true);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let models: monaco.editor.ITextModel[] = [];
    void window.sweet.diffSource(id).then((src) => {
      if (!alive) return;
      if (!src || !host.current) return setState("missing");
      const language = languageForPath(path);
      models = [monaco.editor.createModel(src.before, language), monaco.editor.createModel(src.after, language)];
      editor.current = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false,
        renderMarginRevertIcon: false,
        minimap: { enabled: false },
        fontFamily: '"Geist Mono Variable", "SF Mono", Menlo, monospace',
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
        diffAlgorithm: "advanced",
      });
      editor.current.setModel({ original: models[0], modified: models[1] });
      setState("ready");
    });
    return () => {
      alive = false;
      editor.current?.dispose();
      editor.current = null;
      models.forEach((m) => m.dispose());
    };
  }, [id, path]);

  useEffect(() => editor.current?.updateOptions({ renderSideBySide: sideBySide }), [sideBySide]);

  return createPortal(
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="diff-compare" role="dialog" aria-label={`对比 ${path}`}>
        <header>
          <FilePath path={path} />
          <span className="cols">{sideBySide ? "左边是改之前，右边是改之后" : "红色是删掉的，绿色是新加的"}</span>
          <span className="spacer" />
          <div className="seg">
            <button type="button" className={sideBySide ? "on" : ""} onClick={() => setSideBySide(true)}>
              左右
            </button>
            <button type="button" className={!sideBySide ? "on" : ""} onClick={() => setSideBySide(false)}>
              上下
            </button>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="diff-compare-host" ref={host} hidden={state === "missing"} />
        {state === "missing" && <p className="hint empty">这次改动的完整内容已经不在了（重新打开的对话只保留改动的片段）。</p>}
      </div>
    </div>,
    document.body,
  );
}
