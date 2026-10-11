import { isValidElement, memo, type ReactNode, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { colorizeLines, languageForTag, tagLabel } from "../languages";
import { runInTerminal } from "./TerminalPanel";
import { Icon } from "./Icon";
import { MermaidBlock } from "./Mermaid";

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal", "powershell", "ps", "cmd"]);

/** Chat links to project files ask the workbench to open them through this event. */
export const OPEN_FILE = "sweet:open-file";
export interface OpenFileDetail {
  path: string;
  /** 1-based line to show, from links like `src/App.tsx:42` or `#L42`. */
  line?: number;
}

// Chat answers as GitHub-flavoured Markdown: headings, nested and task lists, tables, quotes,
// links, strikethrough and fenced code with highlighting. react-markdown builds React elements
// and drops raw HTML, so model output can't inject markup. Single line breaks stay line breaks
// (remark-breaks), which is how models write Chinese prose. Re-parsed on every streamed delta;
// an unclosed ``` fence renders as a code block until the closing fence arrives.

const PLUGINS = [remarkGfm, remarkBreaks];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={urlTransform} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A Markdown file from the project, as its preview (EditorPane): standard Markdown line breaks (a
 * single newline doesn't break the line), and relative links and images resolved against the
 * file's own folder, so `./guide.md` opens guide.md next to it.
 */
export const MarkdownDoc = memo(function MarkdownDoc({ text, path }: { text: string; path: string }) {
  const components = useMemo<Components>(() => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    return {
      ...COMPONENTS,
      a: ({ href = "", children }) => <MdLink href={resolveRelative(dir, href)}>{children}</MdLink>,
      img: ({ src, alt }) => {
        const url = typeof src === "string" ? resolveRelative(dir, src) : "";
        return (
          <MdLink href={url}>
            <Icon name="ft-image" /> {alt || "图片"}
          </MdLink>
        );
      },
    };
  }, [path]);
  return (
    <div className="md md-doc">
      <ReactMarkdown remarkPlugins={DOC_PLUGINS} components={components} urlTransform={urlTransform} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const DOC_PLUGINS = [remarkGfm];

/** "img/a.png" in "docs/x.md" → "docs/img/a.png"; "/a.md" → "a.md" (project root); URLs and #anchors as they are. */
function resolveRelative(dir: string, href: string): string {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
  if (href.startsWith("/")) return href.slice(1);
  const parts = (dir + href).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

/** `main.js:12` looks like a URL with a "main.js:" protocol to the sanitizer; keep file:line links. */
const FILE_LINE = /^[\w@.~-][\w@.~/-]*:\d+(:\d+)?$/;
const urlTransform = (url: string) => (FILE_LINE.test(url) ? url : defaultUrlTransform(url));

const COMPONENTS: Components = {
  pre({ children }) {
    // react-markdown wraps a fenced block as <pre><code class="language-x">…</code></pre>.
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
    const lang = code?.className?.match(/language-(\S+)/)?.[1] ?? "";
    const source = String(code?.children ?? "").replace(/\n$/, "");
    const block = <CodeBlock lang={lang} code={source} />;
    return lang.toLowerCase() === "mermaid" ? <MermaidBlock code={source} fallback={block} /> : block;
  },
  code({ children, className }) {
    // Only inline code gets here (blocks are taken by `pre` above).
    return <code className={"inline" + (className ? ` ${className}` : "")}>{children}</code>;
  },
  a({ href = "", children }) {
    return <MdLink href={href}>{children}</MdLink>;
  },
  img({ src, alt }) {
    // The renderer's CSP blocks remote images; show where it points instead of a broken image.
    const url = typeof src === "string" ? src : "";
    return (
      <MdLink href={url}>
        <Icon name="ft-image" /> {alt || "图片"}
      </MdLink>
    );
  },
  table({ children }) {
    return (
      <div className="md-table">
        <table>{children}</table>
      </div>
    );
  },
  input({ type, checked }) {
    // GFM task list items: read-only checkboxes.
    return type === "checkbox" ? <span className={"md-task" + (checked ? " done" : "")} aria-label={checked ? "已完成" : "未完成"}>{checked && <Icon name="check" />}</span> : null;
  },
};

/** A project file reference like `src/App.tsx`, `./a.ts:12` or `src/b.ts#L4`, split into path and line. */
function projectPath(href: string): OpenFileDetail | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  if (!FILE_LINE.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // http:, mailto:…
  const m = href.match(/^(.*?)(?:#L(\d+)\S*|:(\d+)(?::\d+)?)?$/);
  let path = m?.[1] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it as written.
  }
  path = path.replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  const line = Number(m?.[2] ?? m?.[3]) || undefined;
  return { path, line };
}

function MdLink({ href, children }: { href: string; children: ReactNode }) {
  const file = projectPath(href);
  if (file) {
    return (
      <a
        href={href}
        className="md-file"
        title={`在编辑器里打开 ${file.path}${file.line ? ` 第 ${file.line} 行` : ""}`}
        onClick={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE, { detail: file }));
        }}
      >
        {children}
      </a>
    );
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    // Opens in the system browser (main's window-open handler).
    return (
      <a href={href} target="_blank" rel="noreferrer" title={href}>
        {children}
      </a>
    );
  }
  return <span className="md-badlink">{children}</span>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const language = languageForTag(lang);
  const lines = useHighlighted(code, language);
  return (
    <div className="codeblock">
      <div className="bar">
        <span>{lang ? tagLabel(lang) : "代码"}</span>
        <span className="spacer" />
        {SHELL_LANGS.has(lang.toLowerCase()) && (
          <button
            type="button"
            className="icon-btn"
            title="在下面的终端里运行这条命令"
            // Drop a leading "$ " prompt the model may have copied from a tutorial.
            onClick={() => runInTerminal(code.replace(/^\$\s+/gm, ""))}
          >
            <Icon name="play" /> 在终端运行
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? (
            <>
              <Icon name="check" /> 已复制
            </>
          ) : (
            <>
              <Icon name="copy" /> 复制
            </>
          )}
        </button>
      </div>
      <pre>
        {lines ? (
          // Monaco escapes the code when it renders these lines.
          <code dangerouslySetInnerHTML={{ __html: lines.join("\n") }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}

/** Highlighted lines once Monaco has tokenized them; plain text until then. */
export function useHighlighted(code: string, language: string): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    if (language === "plaintext") return setLines(null);
    let alive = true;
    colorizeLines(code, language).then(
      (l) => alive && setLines(l),
      () => alive && setLines(null),
    );
    return () => {
      alive = false;
    };
  }, [code, language]);
  return lines;
}
