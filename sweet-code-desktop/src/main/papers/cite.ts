import type { CitePick, CiteRef, CiteStyle } from "@shared/types";

// Citations as text: writing them (`[@key]` for Pandoc / Quarto Markdown, `\cite{key}` for LaTeX),
// and finding the keys a document already cites. No I/O here.

/** A Better BibTeX citation key: letters (any script), digits, and a little inner punctuation. */
const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_:.+/-]{0,199}$/u;
export const validCitekey = (v: unknown): v is string => typeof v === "string" && KEY.test(v) && !/[:.+/-]$/.test(v);

/** LaTeX for .tex files, Pandoc's syntax for everything else (.qmd, .md, plain text). */
export function citeStyleFor(file: string | undefined): CiteStyle {
  return file && /\.(tex|ltx|latex|sty|cls)$/i.test(file) ? "latex" : "pandoc";
}

/** A locator, prefix or suffix typed by a person: one line, nothing that would end the citation early. */
const part = (v: string | undefined) => (v ?? "").replace(/[\r\n]+/g, " ").replace(/[\][{};]/g, "").trim();

/**
 * One citation of one or more references.
 *   pandoc: [see @a, p. 12; -@b]
 *   latex:  \cite{a,b}, or one \cite[see][p. 12]{a} per reference once any of them has extra text
 */
export function formatCitation(refs: CiteRef[], style: CiteStyle): string {
  const list = refs.filter((r) => validCitekey(r.citekey));
  if (!list.length) return "";
  if (style === "pandoc") {
    return "[" + list.map((r) => `${part(r.prefix) ? part(r.prefix) + " " : ""}${r.suppressAuthor ? "-" : ""}@${r.citekey}${part(r.locator) ? ", " + part(r.locator) : ""}${part(r.suffix) ? " " + part(r.suffix) : ""}`).join("; ") + "]";
  }
  if (list.every((r) => !part(r.locator) && !part(r.prefix) && !part(r.suffix))) return `\\cite{${list.map((r) => r.citekey).join(",")}}`;
  return list
    .map((r) => {
      const pre = part(r.prefix);
      const post = [part(r.locator), part(r.suffix)].filter(Boolean).join(" ");
      // natbib: \cite[post]{key}, \cite[pre][post]{key}.
      return `\\cite${pre ? `[${pre}][${post}]` : post ? `[${post}]` : ""}{${r.citekey}}`;
    })
    .join("");
}

/** Quarto's cross-references look like citations (@fig-plot, @tbl-results) but aren't. */
const CROSSREF = /^(?:fig|tbl|lst|tip|nte|wrn|imp|cau|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|eq|sec|alg)-/;

/** Code is not prose: an @ or a \cite inside it cites nothing. */
const withoutCode = (text: string) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");

/**
 * The citation keys a text uses, each once, in the order they first appear. LaTeX commands
 * (\cite, \citep, \parencite, \autocite, … with optional arguments) are read in both styles,
 * since Markdown may carry raw LaTeX; Pandoc's @key only outside .tex files.
 */
export function citedKeys(text: string, style: CiteStyle): string[] {
  const found = new Set<string>();
  const body = style === "pandoc" ? withoutCode(text) : text.replace(/(^|[^\\])%[^\n]*/g, "$1");
  const at: [number, string][] = [];
  for (const m of body.matchAll(/\\[A-Za-z]*cite[A-Za-z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g)) {
    for (const key of m[1].split(",")) at.push([m.index, key.trim()]);
  }
  if (style === "pandoc") {
    // Not after a letter, digit or dot: that is an e-mail address, not a citation.
    for (const m of body.matchAll(/(?<![\p{L}\p{N}_.@])-?@(?:\{([^}\s]+)\}|([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.+/-](?=[\p{L}\p{N}_]))*))/gu)) {
      const key = m[1] ?? m[2];
      if (!CROSSREF.test(key)) at.push([m.index, key]);
    }
  }
  for (const [, key] of at.sort((a, b) => a[0] - b[0])) if (validCitekey(key)) found.add(key);
  return [...found];
}

/**
 * What Better BibTeX's picker (CAYW) answered. An empty answer means the picker was closed
 * without a choice. The text is used as it came (Zotero wrote locators and prefixes into it).
 */
export function parseCayw(body: string, style: CiteStyle): CitePick | null {
  const text = body.replace(/^﻿/, "").trim();
  if (!text) return null;
  if (text.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("Zotero 返回的引用格式不对，请再试一次");
  return { text, keys: citedKeys(text, style), style };
}
