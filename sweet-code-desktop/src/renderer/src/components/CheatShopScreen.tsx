import { useEffect, useMemo, useState } from "react";
import type { CheatshopTree, CheatshopFile } from "@shared/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { colorizeLines, languageForPath, fileLanguageLabel } from "../languages";
import "../styles/cheatshop.css";

/**
 * The hub for `game-cheat-workshop`: a two-pane viewer that lists sections on the left and shows
 * the picked file (README/INDEX/template source) on the right. The tree comes from the main process
 * via `cheatshopTree`, individual file bodies come from `cheatshopRead`. Nothing writes to disk.
 */
export function CheatShopScreen({ hidden }: { hidden: boolean }) {
  const [tree, setTree] = useState<CheatshopTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Currently-shown file path, relative to the workshop root. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Which section dirs are expanded in the sidebar. */
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});

  // First visit — fetch the tree once; the main process reads disk so bugs there surface here.
  useEffect(() => {
    if (hidden || loaded) return;
    void window.sweet
      .cheatshopTree()
      .then((r) => {
        if (r.ok) {
          setTree(r.data);
          setError(null);
          if (r.data.readme) setSelected(r.data.readme);
          else if (r.data.sections[0]?.files[0]) setSelected(r.data.sections[0].files[0].path);
          // Expand the section the first file lives in, so the user sees context.
          const first = r.data.sections[0]?.dir;
          if (first) setOpenDirs({ [first]: true });
        } else {
          setError(r.message || "读取外挂工坊失败");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  }, [hidden, loaded]);

  if (hidden) return null;

  return (
    <main className="cheatshop" aria-label="外挂工坊">
      <aside className="cs-nav">
        <header className="cs-nav-head">
          <Icon name="hook" />
          <div>
            <div className="cs-title">外挂工坊</div>
            <div className="cs-sub">游戏逆向 · 自建 lab · CTF 模板</div>
          </div>
        </header>

        {!loaded && <div className="cs-tip">正在读取 workshop…</div>}
        {loaded && error && (
          <div className="cs-tip cs-err">
            <Icon name="warning" />
            <span>{error}</span>
            <button
              type="button"
              className="cs-retry"
              onClick={() => {
                setLoaded(false);
                setError(null);
              }}
            >
              重试
            </button>
          </div>
        )}

        {tree && (
          <nav className="cs-tree" aria-label="章节">
            {tree.readme && (
              <button
                type="button"
                className={"cs-top" + (selected === tree.readme ? " on" : "")}
                onClick={() => setSelected(tree.readme!)}
              >
                <Icon name="book" />
                <span>总览 README</span>
              </button>
            )}
            {tree.index && (
              <button
                type="button"
                className={"cs-top" + (selected === tree.index ? " on" : "")}
                onClick={() => setSelected(tree.index!)}
              >
                <Icon name="list-check" />
                <span>索引 INDEX</span>
              </button>
            )}

            <ul className="cs-sections">
              {tree.sections.map((s) => {
                const open = !!openDirs[s.dir];
                return (
                  <li key={s.dir} className={"cs-section" + (open ? " open" : "")}>
                    <button
                      type="button"
                      className="cs-section-head"
                      aria-expanded={open}
                      onClick={() => setOpenDirs((o) => ({ ...o, [s.dir]: !o[s.dir] }))}
                    >
                      <Icon name={open ? "chevron-down" : "chevron-right"} />
                      {s.order && <span className="cs-order">{s.order}</span>}
                      <span className="cs-section-title">{s.title}</span>
                      <span className="cs-count">{s.files.length}</span>
                    </button>
                    {open && (
                      <ul className="cs-files">
                        {s.files.map((f) => (
                          <li key={f.path}>
                            <button
                              type="button"
                              className={"cs-file" + (selected === f.path ? " on" : "")}
                              title={f.path}
                              onClick={() => setSelected(f.path)}
                            >
                              <Icon name="file" />
                              <span className="cs-file-name">{f.name}</span>
                              <span className="cs-file-ext">{fileLanguageLabel(f.name)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </aside>

      <section className="cs-view" aria-live="polite">
        {selected ? <FileView path={selected} /> : <EmptyHint tree={tree} />}
      </section>
    </main>
  );
}

function EmptyHint({ tree }: { tree: CheatshopTree | null }) {
  return (
    <div className="cs-empty">
      <Icon name="hook" />
      <h2>外挂工坊</h2>
      <p>左边选一个章节或文件开始浏览。</p>
      {tree && !tree.sections.length && (
        <p className="cs-empty-note">
          未找到任何章节。确认 workshop 已随应用一起打包（<code>resources/cheatshop/</code> 或开发目录 <code>game-cheat-workshop/</code>）。
        </p>
      )}
    </div>
  );
}

interface FileState {
  text: string;
  ext: string;
  size: number;
  error?: string;
}

function FileView({ path }: { path: string }) {
  const [state, setState] = useState<FileState | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState(null);
    setCopied(false);
    window.sweet
      .cheatshopRead(path)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setState({ ...r.data });
        else setState({ text: "", ext: "", size: 0, error: r.message });
      })
      .catch((e) => {
        if (!cancelled) setState({ text: "", ext: "", size: 0, error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const isMarkdown = path.endsWith(".md") || path.endsWith(".mdx");

  async function copyAll() {
    if (!state?.text) return;
    try {
      await navigator.clipboard.writeText(state.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied — leave the UI quiet; user can still select-copy.
    }
  }

  return (
    <div className="cs-file-view">
      <header className="cs-file-head">
        <div className="cs-file-crumbs" title={path}>
          <Icon name="file" />
          <span>{path}</span>
        </div>
        <div className="cs-file-actions">
          {state && !state.error && (
            <>
              <span className="cs-file-meta">
                {fileLanguageLabel(path)} · {Math.max(1, Math.round((state.size || state.text.length) / 102.4) / 10)} KB
              </span>
              <button type="button" className="cs-btn" onClick={copyAll} disabled={!state.text}>
                <Icon name={copied ? "check" : "copy"} />
                <span>{copied ? "已复制" : "复制全部"}</span>
              </button>
            </>
          )}
        </div>
      </header>

      <div className="cs-file-body">
        {loading && <div className="cs-tip">加载中…</div>}
        {state?.error && (
          <div className="cs-tip cs-err">
            <Icon name="warning" />
            <span>{state.error}</span>
          </div>
        )}
        {state && !state.error && (isMarkdown ? <Markdown text={state.text} /> : <CodeBlock path={path} text={state.text} />)}
      </div>
    </div>
  );
}

function CodeBlock({ path, text }: { path: string; text: string }) {
  const language = useMemo(() => languageForPath(path), [path]);
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void colorizeLines(text, language).then((rows) => !cancelled && setLines(rows));
    return () => {
      cancelled = true;
    };
  }, [text, language]);

  // Fall back to a plain pre until the colorizer resolves; still readable, still monospaced.
  if (!lines) {
    return (
      <pre className="cs-code plain">
        <code>{text}</code>
      </pre>
    );
  }
  return (
    <pre className="cs-code">
      <code>
        {lines.map((html, i) => (
          <span key={i} className="cs-code-line" dangerouslySetInnerHTML={{ __html: (html || "&nbsp;") + "\n" }} />
        ))}
      </code>
    </pre>
  );
}
