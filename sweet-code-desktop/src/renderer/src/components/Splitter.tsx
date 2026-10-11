import { useState } from "react";

// A vertical divider between two panes. Dragging it resizes the pane on `side` of it;
// double-clicking puts that pane back to its default width.

interface Props {
  /** Which pane this divider resizes: the one to its left or to its right. */
  side: "left" | "right";
  width: number;
  min: number;
  /** Upper bound in px, given the window width at the time. */
  max(): number;
  defaultWidth: number;
  onChange(width: number): void;
  /** Once, at the end of a drag (to save it). */
  onCommit(width: number): void;
  label: string;
}

export function Splitter({ side, width, min, max, defaultWidth, onChange, onCommit, label }: Props) {
  const [dragging, setDragging] = useState(false);

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    setDragging(true);
    document.body.classList.add("col-resizing");
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      w = Math.round(Math.min(Math.max(side === "left" ? startW + dx : startW - dx, min), max()));
      onChange(w);
    };
    const up = () => {
      setDragging(false);
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onCommit(w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={"splitter" + (dragging ? " dragging" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}（双击恢复默认宽度）`}
      onPointerDown={down}
      onDoubleClick={() => {
        onChange(defaultWidth);
        onCommit(defaultWidth);
      }}
    />
  );
}

const KEY = "sweet:layout";

export interface Layout {
  filesWidth: number;
  chatWidth: number;
  chatOpen: boolean;
}

export const DEFAULT_LAYOUT: Layout = { filesWidth: 232, chatWidth: 420, chatOpen: true };

export function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // Not remembered this time.
  }
}
