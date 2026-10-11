import { useEffect, useRef, useState } from "react";
import type { ProviderView, WikiState } from "@shared/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { type AskItem, WikiAsk } from "./WikiAsk";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

interface Props {
  hidden: boolean;
  /** The chat model is set up, so the wiki can be written. */
  canWrite: boolean;
  /** For the question box's model picker. */
  providers: ProviderView[];
  activeId: string;
}

/**
 * 项目百科: an AI-written guide to the open project, with architecture diagrams. File links in
 * the pages open in the editor (Markdown dispatches OPEN_FILE; the workbench switches to itself).
 */
export function WikiScreen({ hidden, canWrite, providers, activeId }: Props) {
  const [wiki, setWiki] = useState<WikiState | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** The run error the user closed, so it stays closed until a new one. */
  const [dismissed, setDismissed] = useState<string>();
  /** Questions and answers, per page. */
  const [asks, setAsks] = useState<Record<string, AskItem[]>>({});
  const articleRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.sweet.wikiGet().then(setWiki);
    return window.sweet.onWikiState(setWiki);
  }, []);
  // Coming back to the screen: re-check which pages went stale while editing.
  useEffect(() => {
    if (!hidden) void window.sweet.wikiGet().then(setWiki);
  }, [hidden]);

  const generate = (mode: "all" | "stale") => {
    setError("");
    window.sweet.wikiGenerate(mode).catch((e) => setError(cleanError(e)));
  };

  const pages = wiki?.pages ?? [];
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  const staleCount = pages.filter((p) => p.stale || p.error || !p.content).length;
  const running = !!wiki?.running;
  const shownError = error || (wiki?.error !== dismissed ? wiki?.error : "");

  return (
    <main className="wiki" hidden={hidden}>
      <div className="studio-bar">
        <Icon name="book" />
        <span className="studio-title">项目百科</span>
        {wiki?.title && <span className="wiki-meta">{wiki.title}</span>}
        <span className="spacer" />
        {running ? (
          <>
            <span className="wiki-meta">
              {wiki?.progress?.label}
              {wiki?.progress && wiki.progress.total > 1 && `（${wiki.progress.done + 1}/${wiki.progress.total}）`}
            </span>
            <button type="button" className="mini-btn" onClick={() => void window.sweet.wikiCancel()}>
              <Icon name="stop" /> 停止
            </button>
          </>
        ) : (
          <>
            {wiki?.generatedAt && (
              <span className="wiki-meta" title={wiki.model}>
                {new Date(wiki.generatedAt).toLocaleString()} 生成
              </span>
            )}
            {pages.length > 0 && staleCount > 0 && (
              <button type="button" className="mini-btn" disabled={!canWrite} onClick={() => generate("stale")}>
                <Icon name="refresh" /> 更新 {staleCount} 页
              </button>
            )}
            <button
              type="button"
              className="mini-btn"
              disabled={!canWrite}
              title={canWrite ? undefined : "先在设置里配置好模型"}
              onClick={() => generate("all")}
            >
              <Icon name="sparkle" /> {pages.length ? "重新生成" : "生成项目百科"}
            </button>
          </>
        )}
      </div>
      {shownError && (
        <div className="studio-error" role="alert">
          <Icon name="warning" /> {shownError}
          <button type="button" className="icon-btn square" aria-label="关闭" onClick={() => (setError(""), setDismissed(wiki?.error))}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {pages.length === 0 ? (
        <div className="wiki-empty">
          <Icon name="book" />
          <h2>给这个项目写一份说明书</h2>
          <p>
            AI 会先读文件树和 README 规划目录，再结合代码索引一页一页写出带架构图的中文百科。
            <br />
            代码改动后，只需要更新受影响的页面。
          </p>
          <p className="wiki-note">生成时会把相关源码发给当前选择的模型服务商。</p>
        </div>
      ) : (
        <div className="wiki-body">
          <nav className="wiki-toc" aria-label="目录">
            {wiki?.summary && <p className="wiki-summary">{wiki.summary}</p>}
            {pages.map((p) => (
              <button type="button" key={p.id} className={p.id === page?.id ? "on" : undefined} onClick={() => setPageId(p.id)}>
                <span className="t">{p.title}</span>
                {!p.content && !p.error && <span className="tag">待生成</span>}
                {p.error && <span className="tag bad">失败</span>}
                {p.stale && <span className="tag warn">代码已变</span>}
              </button>
            ))}
          </nav>
          <article className="wiki-page" ref={articleRef}>
            {page && (
              <>
                <div ref={contentRef}>
                <h1>{page.title}</h1>
                {page.files.length > 0 && (
                  <div className="wiki-files">
                    {page.files.map((f) => (
                      <Markdown key={f} text={`[${f}](${encodeURI(f)})`} />
                    ))}
                  </div>
                )}
                {page.stale && <p className="wiki-warn">这页涉及的代码改过了，内容可能已经过时，点上面的「更新」重新生成。</p>}
                {page.error && <p className="wiki-warn bad">生成失败：{page.error}</p>}
                {page.content ? <Markdown text={page.content} /> : !page.error && <p className="wiki-note">{running ? "排队生成中…" : "还没有生成。"}</p>}
                </div>
                <WikiAsk
                  pageId={page.id}
                  providers={providers}
                  activeId={activeId}
                  pageRef={contentRef}
                  scrollRef={articleRef}
                  items={asks[page.id] ?? []}
                  onItems={(update) => setAsks((all) => ({ ...all, [page.id]: update(all[page.id] ?? []) }))}
                />
              </>
            )}
          </article>
        </div>
      )}
    </main>
  );
}
