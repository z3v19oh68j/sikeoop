import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { fuzzy, fuzzyPath } from "../lib/fuzzy";
import { Icon, fileIconName } from "./Icon";
import "../styles/palette.css";

// Quick open (⌘P / Ctrl+P) and the command palette (⌘⇧P / Ctrl+Shift+P), one box like VS Code:
// a plain query searches the project's files, ">" switches to commands, ":42" jumps to line 42 of
// the open file. Commands carry pinyin keywords so 「sj」or「shouji」finds 手机.

export interface PaletteCommand {
  id: string;
  title: string;
  /** Small grey label before the title, e.g. 打开 / 切换. */
  group?: string;
  /** Extra search words: pinyin (full and initials), English. Matched but not shown. */
  keys?: string;
  shortcut?: string;
  run(): void;
}

interface Props {
  /** "files" opens with an empty query, "commands" with ">". */
  mode: "files" | "commands";
  files: string[];
  /** Recently opened files, newest first: shown when the query is empty. */
  recent: string[];
  commands: PaletteCommand[];
  hasFile: boolean;
  onOpenFile(path: string): void;
  onGotoLine(line: number): void;
  onClose(): void;
}

type Item =
  | { kind: "file"; path: string; indices: number[]; recent: boolean }
  | { kind: "command"; cmd: PaletteCommand; indices: number[] }
  | { kind: "line"; line: number };

const MAX_ITEMS = 60;
const isMac = navigator.platform.toLowerCase().includes("mac");
export const MOD = isMac ? "⌘" : "Ctrl+";

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: ReactElement[] = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (!run) return;
    out.push(on ? <mark key={k}>{run}</mark> : <span key={k}>{run}</span>);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export function CommandPalette({ mode, files, recent, commands, hasFile, onOpenFile, onGotoLine, onClose }: Props) {
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => input.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    if (query.startsWith(">")) {
      const q = query.slice(1).trim();
      if (!q) return commands.slice(0, MAX_ITEMS).map((cmd) => ({ kind: "command" as const, cmd, indices: [] }));
      return commands
        .map((cmd) => {
          const onTitle = fuzzy(q, cmd.title);
          if (onTitle) return { cmd, score: onTitle.score + 10, indices: onTitle.indices };
          const onKeys = cmd.keys ? fuzzy(q, cmd.keys) : null;
          return onKeys ? { cmd, score: onKeys.score, indices: [] } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ITEMS)
        .map(({ cmd, indices }) => ({ kind: "command" as const, cmd, indices }));
    }
    if (query.startsWith(":")) {
      const line = Number.parseInt(query.slice(1), 10);
      return hasFile && line > 0 ? [{ kind: "line" as const, line }] : [];
    }
    const q = query.trim();
    if (!q) {
      const recentSet = new Set(recent);
      const rest = files.filter((f) => !recentSet.has(f));
      return [...recent.filter((f) => files.includes(f)), ...rest]
        .slice(0, MAX_ITEMS)
        .map((path) => ({ kind: "file" as const, path, indices: [], recent: recentSet.has(path) }));
    }
    const recentRank = new Map(recent.map((p, i) => [p, i]));
    return files
      .map((path) => {
        const m = fuzzyPath(q, path);
        if (!m) return null;
        const r = recentRank.get(path);
        return { path, indices: m.indices, score: m.score + (r === undefined ? 0 : 8 - Math.min(r, 8)) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ITEMS)
      .map(({ path, indices }) => ({ kind: "file" as const, path, indices, recent: recentRank.has(path) }));
  }, [query, files, recent, commands, hasFile]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    if (it.kind === "file") onOpenFile(it.path);
    else if (it.kind === "line") onGotoLine(it.line);
    else it.cmd.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Composing Chinese with an input method: Enter confirms the characters, not the item.
      if (!e.nativeEvent.isComposing) pick(items[active]);
    }
  };

  const commandMode = query.startsWith(">");
  const empty =
    commandMode ? "没有这个命令" : query.startsWith(":") ? (hasFile ? "输入行号，回车跳过去" : "先打开一个文件") : files.length ? "没找到这个文件" : "先打开一个项目";

  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={commandMode ? "命令面板" : "快速打开文件"} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={commandMode ? "输入命令，支持拼音" : "输入文件名找文件 · > 命令 · :行号 跳转"}
          aria-label="搜索"
          aria-controls="palette-list"
          aria-activedescendant={items.length ? `palette-${active}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <ul id="palette-list" ref={list} role="listbox">
          {items.map((it, i) => (
            <li
              key={it.kind === "file" ? it.path : it.kind === "command" ? it.cmd.id : "line"}
              id={`palette-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : undefined}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(it)}
            >
              {it.kind === "file" && (
                <>
                  <Icon name={fileIconName(it.path.split("/").pop() ?? "")} className="ft" />
                  <span className="palette-name">
                    <Highlight text={it.path.split("/").pop() ?? it.path} indices={it.indices.map((x) => x - (it.path.lastIndexOf("/") + 1)).filter((x) => x >= 0)} />
                  </span>
                  <span className="palette-dir">
                    <Highlight text={it.path.slice(0, it.path.lastIndexOf("/") + 1)} indices={it.indices.filter((x) => x <= it.path.lastIndexOf("/"))} />
                  </span>
                  {it.recent && !query.trim() && <span className="palette-tag">最近</span>}
                </>
              )}
              {it.kind === "command" && (
                <>
                  {it.cmd.group && <span className="palette-group">{it.cmd.group}</span>}
                  <span className="palette-name">
                    <Highlight text={it.cmd.title} indices={it.indices} />
                  </span>
                  {it.cmd.shortcut && <kbd>{it.cmd.shortcut}</kbd>}
                </>
              )}
              {it.kind === "line" && <span className="palette-name">跳到第 {it.line} 行</span>}
            </li>
          ))}
          {!items.length && <li className="palette-empty">{empty}</li>}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>回车</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
          <span className="spacer" />
          <span>{commandMode ? `${MOD}P 找文件` : `${MOD}⇧P 命令`}</span>
        </div>
      </div>
    </div>
  );
}
