import { useEffect, useState } from "react";
import type { PaperDoc, PaperTask, PaperTranslation } from "@shared/types";
import { Icon } from "../Icon";
import { ReadTab } from "./ReadTab";
import { EvidenceTab } from "./EvidenceTab";
import { WritingTab } from "./WritingTab";
import { ArxivTab } from "./ArxivTab";
import { ReviewTab } from "./ReviewTab";
import { IdeasTab } from "./IdeasTab";
import { CiteTab } from "./CiteTab";
import { LIVE_TASK } from "./common";
import "../../styles/settings.css";
import "../../styles/plugins.css";
import "../../styles/research.css";
import "../../styles/papers.css";

type Tab = "read" | "evidence" | "writing" | "review" | "cite" | "arxiv" | "ideas";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "read", label: "读论文", icon: "book" },
  { id: "evidence", label: "转证据库", icon: "list-check" },
  { id: "writing", label: "写作与润色", icon: "file" },
  { id: "review", label: "模拟审稿", icon: "group" },
  { id: "cite", label: "引用与排版", icon: "files" },
  { id: "arxiv", label: "arXiv 小助手", icon: "globe" },
  { id: "ideas", label: "选题", icon: "sparkle" },
];

interface Props {
  hidden: boolean;
  /** Text selected in the editor, offered to 写作与润色. */
  editorSelection?: string;
  /** Open 深度科研 with this evidence repository already chosen. */
  /** question: prefilled in deep research when known (review / ideas hand-offs). */
  onStartResearch(path: string, question?: string): void;
  /** The file open in the editor: citations can be put at its cursor, written the way that file needs. */
  editorFile?: string;
  /** Opens a project file in the editor (a new paper, a document about to be typeset). */
  onOpenFile?(path: string): void;
}

/**
 * 论文工坊 (docs/方案-论文工坊.md): read papers (summary, side-by-side translation), turn them into an
 * evidence repository for 深度科研, polish writing, and find papers on arXiv.
 */
export function PapersScreen({ hidden, editorSelection, onStartResearch, editorFile, onOpenFile }: Props) {
  const [tab, setTab] = useState<Tab>("read");
  const [papers, setPapers] = useState<PaperDoc[]>([]);
  const [tasks, setTasks] = useState<PaperTask[]>([]);
  const [translations, setTranslations] = useState<Record<string, PaperTranslation>>({});
  /** Bumped per paper when a task on it ends, so its details are read again. */
  const [version, setVersion] = useState<Record<string, number>>({});
  /** A passage and a reviewer's comment on their way from 模拟审稿 to 写作与润色. */
  const [polishSeed, setPolishSeed] = useState<{ text: string; note: string; at: number } | undefined>();
  /** A citation on its way from 引用与排版 to 写作与润色's input. */
  const [citeInsert, setCiteInsert] = useState<{ text: string; at: number } | undefined>();

  useEffect(() => {
    void window.sweet.paperList().then(setPapers);
    void window.sweet.paperTasks().then(setTasks);
    return window.sweet.onPaperEvent((e) => {
      if (e.type === "paper") setPapers((list) => (list.some((p) => p.id === e.paper.id) ? list.map((p) => (p.id === e.paper.id ? e.paper : p)) : [e.paper, ...list]));
      else if (e.type === "paperRemoved") setPapers((list) => list.filter((p) => p.id !== e.id));
      else if (e.type === "translation") setTranslations((t) => ({ ...t, [e.paperId]: e.translation }));
      else {
        setTasks((list) => (list.some((t) => t.id === e.task.id) ? list.map((t) => (t.id === e.task.id ? e.task : t)) : [...list, e.task]));
        if (!LIVE_TASK.has(e.task.status)) setVersion((v) => ({ ...v, ...Object.fromEntries(e.task.paperIds.map((id) => [id, (v[id] ?? 0) + 1])) }));
      }
    });
  }, []);

  const running = tasks.filter((t) => LIVE_TASK.has(t.status)).length;

  return (
    <main className="research papers" hidden={hidden}>
      <div className="rs-inner">
        <header className="rs-head">
          <div>
            <h1>论文工坊</h1>
            <p className="hint">读论文、翻译、总结，把结论整理成证据库交给「深度科研」研判；也能帮你润色自己写的论文。</p>
          </div>
          {running > 0 && <span className="hint pp-running">{running} 个任务在跑</span>}
        </header>

        <nav className="pc-tabs pp-tabs" role="tablist" aria-label="论文工坊">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>

        <div hidden={tab !== "read"}>
          <ReadTab papers={papers} tasks={tasks} version={version} translations={translations} onArxiv={() => setTab("arxiv")} />
        </div>
        <div hidden={tab !== "evidence"}>
          <EvidenceTab papers={papers} tasks={tasks} onStartResearch={onStartResearch} />
        </div>
        <div hidden={tab !== "writing"}>
          <WritingTab editorSelection={editorSelection} seed={polishSeed} insert={citeInsert} />
        </div>
        <div hidden={tab !== "cite"}>
          <CiteTab
            active={!hidden && tab === "cite"}
            editorFile={editorFile}
            onOpenFile={onOpenFile}
            onToWriting={(text) => {
              setCiteInsert({ text, at: Date.now() });
              setTab("writing");
            }}
          />
        </div>
        <div hidden={tab !== "review"}>
          <ReviewTab
            papers={papers}
            onStartResearch={onStartResearch}
            onPolish={(seed) => {
              setPolishSeed({ ...seed, at: Date.now() });
              setTab("writing");
            }}
          />
        </div>
        <div hidden={tab !== "arxiv"}>
          <ArxivTab papers={papers} />
        </div>
        <div hidden={tab !== "ideas"}>
          <IdeasTab papers={papers} onStartResearch={onStartResearch} />
        </div>
      </div>
    </main>
  );
}
