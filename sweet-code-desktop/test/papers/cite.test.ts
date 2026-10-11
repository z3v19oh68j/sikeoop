// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { citeStyleFor, citedKeys, formatCitation, parseCayw, validCitekey } from "../../src/main/papers/cite.ts";

test("the citation syntax follows the file: LaTeX for .tex, Pandoc's for everything else", () => {
  assert.deepEqual(["paper.tex", "ch/intro.TEX", "refs.ltx"].map(citeStyleFor), ["latex", "latex", "latex"]);
  assert.deepEqual(["paper.qmd", "notes.md", "draft.txt", undefined].map(citeStyleFor), ["pandoc", "pandoc", "pandoc", "pandoc"]);
});

test("Pandoc citations: one bracket, keys joined by semicolons, locator after a comma", () => {
  assert.equal(formatCitation([{ citekey: "vaswani2017" }], "pandoc"), "[@vaswani2017]");
  assert.equal(formatCitation([{ citekey: "vaswani2017" }, { citekey: "devlin2019" }], "pandoc"), "[@vaswani2017; @devlin2019]");
  assert.equal(formatCitation([{ citekey: "a2020", prefix: "see", locator: "p. 12", suffix: "and passim" }, { citekey: "b2021", suppressAuthor: true }], "pandoc"), "[see @a2020, p. 12 and passim; -@b2021]");
  assert.equal(formatCitation([{ citekey: "王2020深度" }], "pandoc"), "[@王2020深度]");
});

test("LaTeX citations: one \\cite for plain keys, one per reference once any has extra text", () => {
  assert.equal(formatCitation([{ citekey: "a2020" }, { citekey: "b2021" }], "latex"), "\\cite{a2020,b2021}");
  assert.equal(formatCitation([{ citekey: "a2020", locator: "p. 12" }], "latex"), "\\cite[p. 12]{a2020}");
  assert.equal(formatCitation([{ citekey: "a2020", prefix: "see", locator: "chap. 3" }, { citekey: "b2021" }], "latex"), "\\cite[see][chap. 3]{a2020}\\cite{b2021}");
  assert.equal(formatCitation([{ citekey: "a2020", prefix: "cf." }], "latex"), "\\cite[cf.][]{a2020}");
});

test("text that would break out of a citation is taken out; unusable keys are left out", () => {
  assert.equal(formatCitation([{ citekey: "a2020", locator: "p. 1]; @evil\n[x" }], "pandoc"), "[@a2020, p. 1 @evil x]");
  assert.equal(formatCitation([{ citekey: "a2020", locator: "p. 1}\\input{x" }], "latex"), "\\cite[p. 1\\inputx]{a2020}");
  assert.equal(formatCitation([{ citekey: "bad key" }, { citekey: "ok1" }, { citekey: "a}b" }], "latex"), "\\cite{ok1}");
  assert.equal(formatCitation([{ citekey: "" }], "pandoc"), "");
  for (const [key, ok] of [["smith2020", true], ["smith_2020-a", true], ["doe:2019", true], ["10.1000/xyz", true], ["李2021", true], ["trailing.", false], ["has space", false], ["a,b", false], ["a{b}", false], ["@a", false], ["", false], [42, false]] as const) assert.equal(validCitekey(key), ok, String(key));
});

test("the keys a Markdown text cites: @key forms, not e-mail addresses, cross-references or code", () => {
  const text = [
    "Transformers [@vaswani2017; see @devlin2019, p. 3] work. @brown2020 argues so, as does -@liu2021.",
    "Contact me@example.org or user@host. See @fig-plot, @tbl-results and @sec-intro.",
    "Braced: @{key.with.dots}. Again [@vaswani2017]. Ends a sentence: @smith2020.",
    "Inline `@notakey` and",
    "```python",
    "x = '@alsonot'",
    "```",
    "Raw LaTeX \\citep[p. 2]{latexkey1, latexkey2}.",
  ].join("\n");
  assert.deepEqual(citedKeys(text, "pandoc"), ["vaswani2017", "devlin2019", "brown2020", "liu2021", "key.with.dots", "smith2020", "latexkey1", "latexkey2"]);
});

test("the keys a LaTeX text cites: every \\cite-like command, optional arguments, not comments or \\nocite{*}", () => {
  const text = "As in \\cite{a2020}, \\citep[see][p. 3]{b2021,c2022} and \\parencite*{d2023}.\n% \\cite{commented}\n\\textcite{e2024} \\autocite[12]{f2025} \\nocite{*} 50\\% of \\cite{g2026}\nAn e-mail a@b.com and @notlatex.";
  assert.deepEqual(citedKeys(text, "latex"), ["a2020", "b2021", "c2022", "d2023", "e2024", "f2025", "g2026"]);
  assert.deepEqual(citedKeys("no citations here", "latex"), []);
});

test("the picker's answer: the citation as Zotero wrote it and its keys; an empty answer is no choice", () => {
  assert.deepEqual(parseCayw("[@vaswani2017, p. 4; @devlin2019]\n", "pandoc"), { text: "[@vaswani2017, p. 4; @devlin2019]", keys: ["vaswani2017", "devlin2019"], style: "pandoc" });
  assert.deepEqual(parseCayw("\\cite[p. 1]{a2020}\\cite{b2021}", "latex"), { text: "\\cite[p. 1]{a2020}\\cite{b2021}", keys: ["a2020", "b2021"], style: "latex" });
  assert.equal(parseCayw("", "pandoc"), null);
  assert.equal(parseCayw("  \n", "latex"), null);
  assert.throws(() => parseCayw("a\u0000b", "pandoc"), /格式不对/);
  assert.throws(() => parseCayw("x".repeat(20_001), "pandoc"), /格式不对/);
});
