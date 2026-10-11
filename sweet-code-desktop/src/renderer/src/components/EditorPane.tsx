import Editor, { type OnMount } from "@monaco-editor/react";
import { type ReactNode, useRef, useState } from "react";
import { monaco } from "../monaco";
import { languageForPath } from "../languages";
import { useSkin } from "../skin";
import { Icon, fileIconName } from "./Icon";
import { MarkdownDoc } from "./Markdown";

export interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
}

interface Props {
  files: OpenFile[];
  activePath?: string;
  /** Shown first in the breadcrumb. */
  projectName: string;
  onActivate(path: string): void;
  onClose(path: string): void;
  onChange(path: string, content: string): void;
  onSave(path: string): void;
  onSelection(text: string): void;
  /** Fill the work area with the editor, or go back. */
  maximized?: boolean;
  onMaximize?(): void;
  /** Shown while the chat is collapsed: brings it back. */
  onShowChat?(): void;
  /** The built-in browser as a tab here (front) or beside the code (split). Absent: not open. */
  browser?: { front: boolean; split: boolean; node: ReactNode; onFront(): void; onClose(): void };
  onOpenBrowser?(): void;
  /** The skin's welcome cards (EVA × MIKU): open a project, start a new conversation, open the terminal. */
  launch?: { openFolder(): void; newChat(): void; terminal(): void };
}

const IS_MAC = /Mac/.test(navigator.platform);

/** Markdown files can be shown as source, rendered, or both side by side. */
type MdMode = "code" | "split" | "preview";
const MD_FILE = /\.(md|mdx|markdown)$/i;
const MD_MODE_KEY = "sweet.mdMode";
const MD_LABEL: Record<MdMode, string> = { code: "源码", split: "分栏", preview: "预览" };

function savedMdMode(): MdMode {
  try {
    const v = localStorage.getItem(MD_MODE_KEY);
    return v === "split" || v === "preview" ? v : "code";
  } catch {
    return "code";
  }
}

export function EditorPane({ files, activePath, projectName, onActivate, onClose, onChange, onSave, onSelection, maximized, onMaximize, onShowChat, browser, onOpenBrowser, launch }: Props) {
  const skin = useSkin();
  const active = files.find((f) => f.path === activePath);
  // In split view both show; otherwise the browser tab covers the code while it's in front.
  const codeShown = !browser || browser.split || !browser.front;
  // The last choice holds for every Markdown file.
  const [mdMode, setMdModeState] = useState<MdMode>(savedMdMode);
  const setMdMode = (m: MdMode) => {
    setMdModeState(m);
    try {
      localStorage.setItem(MD_MODE_KEY, m);
    } catch {
      // Not remembered; fine.
    }
  };
  const isMd = !!active && MD_FILE.test(active.path);
  const mode: MdMode = isMd ? mdMode : "code";
  // Monaco commands are registered once, so they read the latest props through a ref.
  const latest = useRef({ activePath, onSave });
  latest.current = { activePath, onSave };

  const handleMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (latest.current.activePath) latest.current.onSave(latest.current.activePath);
    });
    editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel();
      onSelection(model && !e.selection.isEmpty() ? model.getValueInRange(e.selection) : "");
    });
  };

  return (
    <section className="editor-area">
      <div className="tabs" role="tablist">
        {files.map((f) => (
          <div
            key={f.path}
            role="tab"
            aria-selected={f.path === activePath && codeShown}
            className={"tab" + (f.path === activePath && codeShown ? " active" : "")}
            onClick={() => onActivate(f.path)}
            title={f.path}
          >
            <Icon name={fileIconName(f.path.split("/").pop() ?? "")} className="ft" />
            {f.path.split("/").pop()}
            {f.content !== f.savedContent && <span className="dirty" aria-label="未保存" />}
            <button
              type="button"
              className="x"
              aria-label={`关闭 ${f.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(f.path);
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
        {browser && (
          <div
            role="tab"
            aria-selected={browser.front || browser.split}
            className={"tab browser-tab" + (browser.front || browser.split ? " active" : "")}
            onClick={browser.onFront}
            title="内置浏览器"
          >
            <Icon name="globe" className="ft" />
            浏览器
            <button
              type="button"
              className="x"
              aria-label="关闭浏览器"
              onClick={(e) => {
                e.stopPropagation();
                browser.onClose();
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <span className="spacer" />
        {!browser && onOpenBrowser && (
          <button type="button" className="icon-btn square pane-max" title="打开内置浏览器" aria-label="打开内置浏览器" onClick={onOpenBrowser}>
            <Icon name="globe" />
          </button>
        )}
        {onMaximize && (
          <button type="button" className="icon-btn square pane-max" title={maximized ? "恢复布局" : "编辑区全屏"} aria-label={maximized ? "恢复布局" : "编辑区全屏"} onClick={onMaximize}>
            <Icon name={maximized ? "minimize" : "maximize"} />
          </button>
        )}
        {onShowChat && (
          <button type="button" className="icon-btn square pane-max" title="显示对话栏" aria-label="显示对话栏" onClick={onShowChat}>
            <Icon name="panel-right" />
          </button>
        )}
      </div>
      <div className={"editor-stage" + (browser?.split ? " split" : "")}>
      <div className="editor-code" hidden={!codeShown}>
      {active && (
        <div className="crumbs" aria-label="文件位置">
          {[projectName, ...active.path.split("/")].map((seg, i, all) => (
            <span key={i} className={i === all.length - 1 ? "last" : undefined}>
              {i > 0 && <span aria-hidden="true">›&nbsp;&nbsp;</span>}
              {seg}
            </span>
          ))}
          {isMd && (
            <span className="md-modes seg-mini" role="group" aria-label="Markdown 显示方式">
              {(Object.keys(MD_LABEL) as MdMode[]).map((m) => (
                <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMdMode(m)}>
                  {MD_LABEL[m]}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {active ? (
        <div className={"editor-host" + (mode !== "code" ? ` md-${mode}` : "")}>
          {mode !== "preview" && (
          <div className="md-source">
          <Editor
            path={active.path}
            language={languageForPath(active.path)}
            defaultValue={active.content}
            theme="sweet-dark"
            onMount={handleMount}
            onChange={(v) => onChange(active.path, v ?? "")}
            options={{
              fontSize: 13,
              lineHeight: 21,
              fontFamily: "'Geist Mono Variable', 'SF Mono', Menlo, monospace",
              renderLineHighlight: "line",
              guides: { indentation: true },
              minimap: { enabled: false },
              smoothScrolling: true,
              cursorBlinking: "smooth",
              tabSize: 2,
              wordWrap: "on",
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              // Gray AI suggestions (DeepSeek FIM); Tab accepts.
              inlineSuggest: { enabled: true },
            }}
          />
          </div>
          )}
          {mode !== "code" && (
            <div className="md-preview" aria-label={`${active.path} 的预览`}>
              <MarkdownDoc text={active.content} path={active.path} />
            </div>
          )}
        </div>
      ) : (
        <div className="editor-empty">
          {skin.id === "eva-miku" && (
            <>
              <div className="skin-hero" aria-hidden="true">
                <b>SYNCHRONIZE_01</b>
                <span>EVA × MIKU / SIKEOOP</span>
                <div className="skin-sync">
                  <svg viewBox="0 0 120 104" width="120" height="104">
                    <polygon points="30,2 90,2 118,52 90,102 30,102 2,52" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <polygon points="36,12 84,12 107,52 84,92 36,92 13,52" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="1" />
                  </svg>
                  <em>
                    01 <small>/ 39</small>
                  </em>
                  <small>SYNCHRONIZATION</small>
                </div>
                <i className="skin-wave">
                  {[4, 9, 6, 14, 22, 12, 28, 16, 9, 20, 11, 6, 13, 5, 8, 3].map((h, n) => (
                    <span key={n} style={{ height: h }} />
                  ))}
                </i>
              </div>
              {launch && (
                <div className="skin-launch">
                  <button type="button" onClick={launch.openFolder}>
                    <Icon name="folder-open" />
                    <span>打开项目</span>
                    <Icon name="chevron-right" className="go" />
                  </button>
                  <button type="button" onClick={launch.newChat}>
                    <Icon name="chat-plus" />
                    <span>新对话</span>
                    <Icon name="chevron-right" className="go" />
                  </button>
                  <button type="button" onClick={launch.terminal}>
                    <Icon name="terminal" />
                    <span>打开终端</span>
                    <Icon name="chevron-right" className="go" />
                  </button>
                </div>
              )}
            </>
          )}
          <div className="inner">
            <span className="mark">
              <Icon name="heart" />
            </span>
            <span>从左边打开一个文件，或者直接在右边告诉 AI 你想做什么</span>
            <div className="keys">
              <span>保存文件</span>
              <kbd>{IS_MAC ? "⌘ S" : "Ctrl S"}</kbd>
              <span>打开 / 收起终端</span>
              <kbd>{IS_MAC ? "⌃ `" : "Ctrl `"}</kbd>
              <span>问 AI 选中的代码</span>
              <kbd>选中后在右边提问</kbd>
            </div>
          </div>
        </div>
      )}
      </div>
      {browser && <div className="editor-browser" hidden={!browser.split && !browser.front}>{browser.node}</div>}
      </div>
    </section>
  );
}
