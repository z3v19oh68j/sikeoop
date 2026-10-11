import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Bundle Monaco locally instead of loading it from a CDN, so the editor works offline.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

monaco.editor.defineTheme("sweet-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "b48aa0", fontStyle: "italic" },
    { token: "keyword", foreground: "d63c7f" },
    { token: "string", foreground: "2f8f6b" },
    { token: "number", foreground: "c46a1d" },
    { token: "type", foreground: "8a4fd1" },
  ],
  colors: {
    "editor.background": "#fffafc",
    "editor.lineHighlightBackground": "#ffeef6",
    "editorLineNumber.foreground": "#e2b3c9",
    "editorLineNumber.activeForeground": "#d63c7f",
    "editor.selectionBackground": "#ffd0e4",
    "editorCursor.foreground": "#ef5d9c",
    "editorIndentGuide.background1": "#f8e1ec",
  },
});

monaco.editor.defineTheme("sweet-dark", {
  base: "vs-dark",
  inherit: true,
  // Token names come from Monaco's Monarch grammars; a rule also matches longer names
  // ("keyword" covers "keyword.ts", "keyword.flow.python"…), so this covers every language.
  rules: [
    { token: "", foreground: "c9c9cf" },
    { token: "identifier", foreground: "c9c9cf" },
    { token: "comment", foreground: "6b6b74", fontStyle: "italic" },
    { token: "comment.doc", foreground: "7d7d87", fontStyle: "italic" },
    { token: "keyword", foreground: "c792ea" },
    { token: "keyword.flow", foreground: "c792ea" },
    { token: "storage", foreground: "c792ea" },
    { token: "operator", foreground: "89ddff" },
    { token: "operators", foreground: "89ddff" },
    { token: "delimiter", foreground: "8b8b93" },
    { token: "string", foreground: "98c379" },
    { token: "string.escape", foreground: "e5c07b" },
    { token: "string.invalid", foreground: "f2767a" },
    { token: "regexp", foreground: "6cc4d4" },
    { token: "number", foreground: "e8915a" },
    { token: "constant", foreground: "e8915a" },
    { token: "type", foreground: "e5c07b" },
    { token: "type.identifier", foreground: "e5c07b" },
    { token: "namespace", foreground: "e5c07b" },
    { token: "annotation", foreground: "e5c07b" },
    { token: "predefined", foreground: "7aa2f7" },
    { token: "function", foreground: "7aa2f7" },
    { token: "variable", foreground: "f2767a" },
    { token: "variable.predefined", foreground: "e8915a" },
    { token: "variable.parameter", foreground: "e8915a" },
    { token: "attribute", foreground: "e5c07b" },
    { token: "tag", foreground: "f2767a" },
    { token: "metatag", foreground: "c792ea" },
    { token: "metatag.content", foreground: "98c379" },
    { token: "attribute.name", foreground: "e5c07b" },
    { token: "attribute.value", foreground: "98c379" },
    { token: "attribute.value.number", foreground: "e8915a" },
    { token: "attribute.value.unit", foreground: "e8915a" },
    { token: "attribute.value.hex", foreground: "e8915a" },
    // JSON (from the JSON language service), YAML / INI / TOML keys
    { token: "string.key.json", foreground: "7aa2f7" },
    { token: "string.value.json", foreground: "98c379" },
    { token: "keyword.json", foreground: "e8915a" },
    { token: "key", foreground: "7aa2f7" },
    { token: "type.yaml", foreground: "7aa2f7" },
    // Markdown
    { token: "keyword.md", foreground: "f2767a", fontStyle: "bold" },
    { token: "strong", fontStyle: "bold" },
    { token: "emphasis", fontStyle: "italic" },
    { token: "variable.md", foreground: "7aa2f7" },
    { token: "string.link.md", foreground: "7aa2f7" },
    // C / C++ preprocessor, Python decorators, shell variables
    { token: "keyword.directive", foreground: "c792ea" },
    { token: "keyword.directive.include", foreground: "c792ea" },
    { token: "string.include", foreground: "98c379" },
    { token: "tag.decorator", foreground: "e5c07b" },
    { token: "variable.shell", foreground: "f2767a" },
    { token: "invalid", foreground: "f2767a" },
  ],
  colors: {
    "editor.background": "#121213",
    "editor.foreground": "#c9c9cf",
    "editor.lineHighlightBackground": "#18181b",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#4a4a52",
    "editorLineNumber.activeForeground": "#b4b4bb",
    "editor.selectionBackground": "#3a2a31",
    "editor.inactiveSelectionBackground": "#2a2a2f",
    "editorCursor.foreground": "#f0789b",
    "editorIndentGuide.background1": "#222226",
    "editorIndentGuide.activeBackground1": "#3a3a40",
    "editorWidget.background": "#1c1c20",
    "editorWidget.border": "#2c2c31",
    "editorSuggestWidget.background": "#1c1c20",
    "editorSuggestWidget.border": "#2c2c31",
    "editorSuggestWidget.selectedBackground": "#2a2a2f",
    "editorGhostText.foreground": "#5d5d66",
    "scrollbarSlider.background": "#2c2c3180",
    "scrollbarSlider.hoverBackground": "#3a3a40",
    // Diff editor ("左右对比"): the same quiet washes and word marks as the chat's diff cards.
    "diffEditor.insertedLineBackground": "#5fd38d12",
    "diffEditor.removedLineBackground": "#f2767a12",
    "diffEditor.insertedTextBackground": "#5fd38d40",
    "diffEditor.removedTextBackground": "#f2767a4a",
    "diffEditorGutter.insertedLineBackground": "#5fd38d1a",
    "diffEditorGutter.removedLineBackground": "#f2767a1a",
    "diffEditor.diagonalFill": "#2226",
    "diffEditor.unchangedRegionBackground": "#151517",
    "diffEditor.unchangedRegionForeground": "#5d5d66",
    "diffEditor.unchangedCodeBackground": "#00000000",
    "diffEditor.border": "#222226",
  },
});

// Set now, so code highlighted outside an editor (chat, diffs) already has the theme's colors.
monaco.editor.setTheme("sweet-dark");

loader.config({ monaco });

// @monaco-editor/react keys each file's model by monaco.Uri.parse(path).
const modelFor = (path: string) => monaco.editor.getModel(monaco.Uri.parse(path));

/**
 * Put new content into an open file's model as one edit, so the user can still
 * press ⌘Z to get back what was there before the AI changed it.
 */
export function syncModel(path: string, content: string): void {
  const model = modelFor(path);
  if (!model || model.getValue() === content) return;
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
}

/** Drop a closed file's model, so reopening it reads the file fresh from disk. */
export function disposeModel(path: string): void {
  modelFor(path)?.dispose();
}

export { monaco };

// ---- AI autocomplete (DeepSeek FIM) ------------------------------------------------

let completionOn = false;
let registered = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gray "ghost text" suggestions while typing; Tab accepts. The text before and after the
 * cursor goes to DeepSeek's fill-in-the-middle endpoint. Waits for a short pause in typing,
 * and Monaco cancels the request as soon as the user types on.
 */
export function setInlineCompletion(on: boolean): void {
  completionOn = on;
  if (registered || !on) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider("*", {
    async provideInlineCompletions(model, position, _context, token) {
      if (!completionOn) return { items: [] };
      await sleep(350);
      if (token.isCancellationRequested) return { items: [] };
      const end = model.getFullModelRange().getEndPosition();
      const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
      const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, end.lineNumber, end.column));
      // Nothing to go on in an empty file.
      if (!prefix.trim()) return { items: [] };
      const raw = await window.sweet.fimComplete({ prefix, suffix });
      if (token.isCancellationRequested) return { items: [] };
      const text = tidySuggestion(raw, prefix);
      if (!text.trim()) return { items: [] };
      return {
        items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
      };
    },
    disposeInlineCompletions() {},
  });
}

/**
 * Fit a raw completion to the cursor. When the cursor sits after indentation only, the model
 * may repeat that indentation; Monaco hides such a suggestion (it would double-indent), so the
 * first line's leading whitespace goes. Trailing blank lines go too: the code after the cursor
 * already continues on its own line.
 */
export function tidySuggestion(text: string, prefix: string): string {
  const lineBefore = prefix.slice(prefix.lastIndexOf("\n") + 1);
  let out = text.replace(/\s+$/, "");
  if (/^\s*$/.test(lineBefore)) out = out.replace(/^[ \t]+/, "");
  return out;
}
