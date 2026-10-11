import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasm from "vscode-oniguruma/release/onig.wasm?inline";
import { INITIAL, Registry, type IGrammar, type StateStack, parseRawGrammar } from "vscode-textmate";
import type { ExtensionContributions, ExtensionTheme } from "@shared/types";
import { monaco } from "./monaco";
import { setLanguageOverrides } from "./languages";
import { getSkin, onSkinChange } from "./skin";

// Applies what the enabled Open VSX extensions contribute to Monaco (main/extensions/service.ts):
//   themes    → monaco.editor.defineTheme (VS Code theme colors + token rules converted)
//   grammars  → TextMate tokenizers (vscode-textmate + oniguruma), replacing Monarch for that language
//   languages → registered ids, file associations and language-configuration.json
//   snippets  → completion items
// All of it is data; no extension code runs. Reloads whenever an extension is installed or toggled.

const THEME_KEY = "sweet.editorTheme";
export const DEFAULT_THEME = "sweet-dark";

let disposables: monaco.IDisposable[] = [];
let themes: ExtensionTheme[] = [];
let ruleScopes = new Set<string>();
let onigReady: Promise<void> | null = null;
/** Languages highlighted by a TextMate grammar: their tokens depend on the theme's rules. */
let tmLanguages = new Set<string>();
const listeners = new Set<() => void>();

/** Installed themes plus the built-in one, for the theme picker. */
export function editorThemes(): { id: string; label: string; source: string }[] {
  return [{ id: DEFAULT_THEME, label: getSkin().monacoTheme ? `跟随皮肤（${getSkin().label}）` : "sikeoop 默认深色", source: "内置" }, ...themes.map((t) => ({ id: t.id, label: t.label, source: t.extensionId }))];
}

export function currentEditorTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setEditorTheme(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // Not remembered; still applied for now.
  }
  applyTheme(id);
  listeners.forEach((l) => l());
}

export function onExtensionsApplied(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const monacoThemeId = (id: string) => "ext-" + id.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();

function applyTheme(id: string) {
  const t = themes.find((x) => x.id === id);
  ruleScopes = new Set(t ? t.tokenColors.flatMap((r) => scopesOf(r.scope)) : []);
  // "Default" follows the app skin: the EVA × MIKU skin brings its own editor colors.
  monaco.editor.setTheme(t ? monacoThemeId(t.id) : (getSkin().monacoTheme ?? DEFAULT_THEME));
  // TextMate token names depend on the theme's rules (see tokenName): re-tokenize those files.
  for (const m of monaco.editor.getModels()) {
    const lang = m.getLanguageId();
    if (!tmLanguages.has(lang)) continue;
    monaco.editor.setModelLanguage(m, "plaintext");
    monaco.editor.setModelLanguage(m, lang);
  }
}

// ---- themes ----

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function scopesOf(scope: string | string[] | undefined): string[] {
  const list = Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(",") : [];
  // Monaco matches one dotted token name: keep the last part of descendant selectors, drop exclusions.
  return list.map((s) => s.trim().split(/\s+/).pop() ?? "").filter((s) => s && !s.startsWith("-"));
}

/** Monaco's own tokenizers (Monarch) use short names; give them the closest VS Code scope's style. */
const MONARCH_ALIASES: Record<string, string[]> = {
  "constant.numeric": ["number"],
  "entity.name.type": ["type"],
  "support.type": ["type"],
  "entity.name.tag": ["tag"],
  "entity.other.attribute-name": ["attribute.name"],
  "punctuation": ["delimiter"],
  "keyword.operator": ["operator"],
  "variable": ["variable", "identifier"],
  "string.regexp": ["regexp"],
  "constant.language": ["predefined"],
};

function toMonacoTheme(t: ExtensionTheme): monaco.editor.IStandaloneThemeData {
  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (const r of t.tokenColors) {
    const fg = r.settings.foreground && HEX.test(r.settings.foreground) ? r.settings.foreground.slice(1, 7) : undefined;
    const fontStyle = r.settings.fontStyle?.trim();
    if (!fg && fontStyle === undefined) continue;
    const scopes = scopesOf(r.scope);
    for (const s of scopes.length ? scopes : [""]) {
      rules.push({ token: s, ...(fg ? { foreground: fg } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) });
      for (const alias of MONARCH_ALIASES[s] ?? []) rules.push({ token: alias, ...(fg ? { foreground: fg } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) });
    }
  }
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.colors)) if (HEX.test(v)) colors[k] = v;
  const base = t.uiTheme === "hc-black" ? "hc-black" : t.uiTheme === "hc-light" ? "hc-light" : t.uiTheme === "vs" ? "vs" : "vs-dark";
  return { base, inherit: true, rules, colors };
}

// ---- TextMate grammars ----

class TmState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone() {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TmState && other.stack.equals(this.stack);
  }
}

function loadOnig(): Promise<void> {
  onigReady ??= (async () => {
    const b64 = onigWasm.slice(onigWasm.indexOf(",") + 1);
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await loadWASM(bin.buffer);
  })();
  return onigReady;
}

/** The innermost scope the theme has a rule for (Monaco styles one dotted name per token). */
function tokenName(scopes: string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const parts = scopes[i].split(".");
    for (let n = parts.length; n > 0; n--) if (ruleScopes.has(parts.slice(0, n).join("."))) return scopes[i];
  }
  return scopes[scopes.length - 1] ?? "";
}

async function applyGrammars(c: ExtensionContributions) {
  if (!c.grammars.length) return;
  await loadOnig();
  const byScope = new Map(c.grammars.map((g) => [g.scopeName, g]));
  const injections = new Map<string, string[]>();
  for (const g of c.grammars) for (const target of g.injectTo ?? []) injections.set(target, [...(injections.get(target) ?? []), g.scopeName]);
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scopeName) => {
      const g = byScope.get(scopeName);
      if (!g) return null;
      try {
        return parseRawGrammar(g.content, g.format === "json" ? "grammar.json" : "grammar.plist");
      } catch {
        return null;
      }
    },
    getInjections: (scopeName) => injections.get(scopeName),
  });
  for (const g of c.grammars) {
    if (!g.language) continue;
    let grammar: IGrammar | null = null;
    try {
      grammar = await registry.loadGrammar(g.scopeName);
    } catch (e) {
      console.warn("[extensions] grammar failed", g.scopeName, e);
    }
    if (!grammar) continue;
    const gr = grammar;
    tmLanguages.add(g.language);
    disposables.push(
      monaco.languages.setTokensProvider(g.language, {
        getInitialState: () => new TmState(INITIAL),
        tokenize(line, state) {
          const r = gr.tokenizeLine(line, (state as TmState).stack, 500);
          return { tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: tokenName(t.scopes) })), endState: new TmState(r.ruleStack) };
        },
      }),
    );
  }
}

// ---- languages and snippets ----

function re(v: unknown): RegExp | undefined {
  try {
    if (typeof v === "string") return new RegExp(v);
    if (v && typeof v === "object" && typeof (v as { pattern?: unknown }).pattern === "string") {
      const o = v as { pattern: string; flags?: string };
      return new RegExp(o.pattern, (o.flags ?? "").replace(/[^gimsuy]/g, ""));
    }
  } catch {
    // An expression JavaScript can't read (Oniguruma-only syntax): skip that setting.
  }
  return undefined;
}

function pairs(v: unknown): monaco.languages.IAutoClosingPairConditional[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .map((p) => (Array.isArray(p) ? { open: String(p[0]), close: String(p[1]) } : p && typeof p === "object" ? { open: String((p as { open: unknown }).open), close: String((p as { close: unknown }).close), ...(Array.isArray((p as { notIn?: unknown }).notIn) ? { notIn: (p as { notIn: string[] }).notIn } : {}) } : null))
    .filter((p): p is monaco.languages.IAutoClosingPairConditional => !!p && p.open !== "undefined" && p.close !== "undefined");
}

function languageConfig(cfg: Record<string, unknown>): monaco.languages.LanguageConfiguration {
  const comments = cfg.comments as { lineComment?: string; blockComment?: [string, string] } | undefined;
  const folding = cfg.folding as { markers?: { start?: unknown; end?: unknown }; offSide?: boolean } | undefined;
  const indent = cfg.indentationRules as Record<string, unknown> | undefined;
  const start = re(folding?.markers?.start);
  const end = re(folding?.markers?.end);
  const inc = re(indent?.increaseIndentPattern);
  const dec = re(indent?.decreaseIndentPattern);
  return {
    ...(comments ? { comments: { ...(comments.lineComment ? { lineComment: comments.lineComment } : {}), ...(Array.isArray(comments.blockComment) ? { blockComment: comments.blockComment } : {}) } } : {}),
    ...(Array.isArray(cfg.brackets) ? { brackets: cfg.brackets as monaco.languages.CharacterPair[] } : {}),
    ...(pairs(cfg.autoClosingPairs) ? { autoClosingPairs: pairs(cfg.autoClosingPairs) } : {}),
    ...(pairs(cfg.surroundingPairs) ? { surroundingPairs: pairs(cfg.surroundingPairs) } : {}),
    ...(re(cfg.wordPattern) ? { wordPattern: re(cfg.wordPattern) } : {}),
    ...(start && end ? { folding: { markers: { start, end }, ...(folding?.offSide ? { offSide: true } : {}) } } : {}),
    ...(inc && dec ? { indentationRules: { increaseIndentPattern: inc, decreaseIndentPattern: dec } } : {}),
  };
}

function applyLanguages(c: ExtensionContributions) {
  const byExt = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const l of c.languages) {
    monaco.languages.register({ id: l.id, extensions: l.extensions, filenames: l.filenames, filenamePatterns: l.filenamePatterns, aliases: l.aliases });
    for (const e of l.extensions ?? []) byExt.set(e.toLowerCase(), l.id);
    for (const f of l.filenames ?? []) byName.set(f, l.id);
    if (l.configuration) {
      try {
        disposables.push(monaco.languages.setLanguageConfiguration(l.id, languageConfig(l.configuration)));
      } catch (e) {
        console.warn("[extensions] language configuration failed", l.id, e);
      }
    }
  }
  // An extension's language wins over sikeoop's stand-ins (e.g. .vue shown as HTML).
  setLanguageOverrides(byExt, byName);
}

function applySnippets(c: ExtensionContributions) {
  const byLang = new Map<string, { name: string; prefix: string; body: string; description?: string; from: string }[]>();
  for (const set of c.snippets) {
    for (const [name, sn] of Object.entries(set.snippets)) {
      if (!sn || typeof sn !== "object" || sn.body === undefined) continue;
      const body = Array.isArray(sn.body) ? sn.body.join("\n") : String(sn.body);
      for (const prefix of Array.isArray(sn.prefix) ? sn.prefix : [sn.prefix]) {
        if (typeof prefix !== "string" || !prefix) continue;
        for (const lang of set.language.split(",").map((x) => x.trim())) {
          byLang.set(lang, [...(byLang.get(lang) ?? []), { name, prefix, body, description: sn.description, from: set.extensionId }]);
        }
      }
    }
  }
  for (const [lang, list] of byLang) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          return {
            suggestions: list.map((s) => ({
              label: s.prefix,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: s.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: `${s.name}（${s.from}）`,
              ...(s.description ? { documentation: s.description } : {}),
              range,
            })),
          };
        },
      }),
    );
  }
}

/** (Re)loads every enabled extension's contributions into the editor. */
export async function applyExtensions(): Promise<void> {
  let c: ExtensionContributions;
  try {
    c = await window.sweet.extContributions();
  } catch {
    return;
  }
  for (const d of disposables) d.dispose();
  disposables = [];
  tmLanguages = new Set();
  themes = c.themes;
  for (const t of themes) {
    try {
      monaco.editor.defineTheme(monacoThemeId(t.id), toMonacoTheme(t));
    } catch (e) {
      console.warn("[extensions] theme failed", t.id, e);
    }
  }
  applyLanguages(c);
  applySnippets(c);
  await applyGrammars(c);
  const chosen = currentEditorTheme();
  applyTheme(themes.some((t) => t.id === chosen) ? chosen : DEFAULT_THEME);
  listeners.forEach((l) => l());
}

/** Loads extensions once at startup and again whenever one is installed, removed or toggled. */
export function startExtensions(): void {
  // A skin change can change what "default editor theme" means.
  onSkinChange(() => {
    applyTheme(currentEditorTheme());
    listeners.forEach((l) => l());
  });
  void applyExtensions();
  window.sweet.onExtChanged(() => void applyExtensions());
}
