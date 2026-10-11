import { useSyncExternalStore } from "react";
import type { ITheme } from "@xterm/xterm";
import evaMonaco from "./skins/eva-miku/monaco-theme.json";
import evaTerminal from "./skins/eva-miku/terminal-theme.json";
import "./skins/eva-miku/skin.css";
import { monaco } from "./monaco";

// App skins: the whole look at once — UI colors (CSS variables scoped by <html data-sikeoop-theme>),
// UI icons, the editor's default theme and the terminal colors. "default" is sikeoop's own look.
// The choice is remembered per computer.

export interface Skin {
  id: string;
  label: string;
  /** Monaco theme used when the editor theme is left on the default. */
  monacoTheme?: string;
  terminal?: ITheme;
  /** Icon name → SVG source, overriding assets/icons. */
  icons?: Record<string, string>;
}

const evaIcons: Record<string, string> = {};
for (const [p, svg] of Object.entries(import.meta.glob<string>("./skins/eva-miku/icons/*.svg", { eager: true, query: "?raw", import: "default" }))) {
  evaIcons[p.slice(p.lastIndexOf("/") + 1, -4)] = svg;
}

monaco.editor.defineTheme("skin-eva-miku", evaMonaco as monaco.editor.IStandaloneThemeData);

export const SKINS: Skin[] = [
  { id: "default", label: "sikeoop 默认" },
  { id: "eva-miku", label: "EVA × MIKU", monacoTheme: "skin-eva-miku", terminal: evaTerminal as ITheme, icons: evaIcons },
];

const KEY = "sweet.skin";
const listeners = new Set<() => void>();

function stored(): Skin {
  try {
    const id = localStorage.getItem(KEY);
    return SKINS.find((s) => s.id === id) ?? SKINS[0];
  } catch {
    return SKINS[0];
  }
}

let current = stored();
apply(current);

function apply(s: Skin) {
  if (s.id === "default") delete document.documentElement.dataset.sikeoopTheme;
  else document.documentElement.dataset.sikeoopTheme = s.id;
}

export function getSkin(): Skin {
  return current;
}

export function setSkin(id: string): void {
  const s = SKINS.find((x) => x.id === id);
  if (!s || s.id === current.id) return;
  current = s;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered; still applied for now.
  }
  apply(s);
  listeners.forEach((l) => l());
}

export function onSkinChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The current skin, re-rendering the component when it changes. */
export function useSkin(): Skin {
  return useSyncExternalStore(onSkinChange, getSkin);
}
