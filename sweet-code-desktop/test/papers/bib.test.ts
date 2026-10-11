// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { bibKeys, mergeBib, parseBib } from "../../src/main/papers/bib.ts";

const VASWANI = "@article{vaswani2017,\n  title = {Attention Is {All} You Need},\n  author = {Vaswani, Ashish and others},\n  year = {2017}\n}";
const DEVLIN = '@inproceedings{devlin2019,\n  title = "BERT: Pre-training of Deep Bidirectional Transformers",\n  year = 2019,\n}';
const MINE = "@misc{mynote,\n  title = {A note I added by hand},\n  note = {an unbalanced \\{ brace, escaped}\n}";

test("a .bib file is split into entries by key; definitions, comments and stray text are kept apart", () => {
  const file = parseBib(`% my library\n@string{nips = {NeurIPS}}\n\n${VASWANI}\n\n@comment{jabref-meta: x}\n${DEVLIN}\n@preamble{"\\newcommand{\\x}{y}"}\n@Book(parens2001, title = {With (parentheses)}, year = 2001)\n`);
  assert.deepEqual(file.entries.map((e) => [e.key, e.type]), [["vaswani2017", "article"], ["devlin2019", "inproceedings"], ["parens2001", "book"]]);
  assert.equal(file.entries[0].raw, VASWANI);
  assert.deepEqual(file.extras, ["% my library", "@string{nips = {NeurIPS}}", "@comment{jabref-meta: x}", '@preamble{"\\newcommand{\\x}{y}"}']);
  assert.deepEqual(bibKeys(`${VASWANI}\n${VASWANI}\n${DEVLIN}`), ["vaswani2017", "devlin2019"]);
});

test("a damaged file loses nothing: what can't be read as an entry stays as text", () => {
  const broken = `${VASWANI}\n\n@article{never_closed,\n  title = {Oops`;
  const file = parseBib(broken);
  assert.deepEqual(file.entries.map((e) => e.key), ["vaswani2017"]);
  assert.deepEqual(file.extras, ["@article{never_closed,\n  title = {Oops"]);
  assert.deepEqual(parseBib("@article{,\n title = {no key}\n}").entries, []);
  assert.deepEqual(parseBib("").entries, []);
  assert.deepEqual(parseBib(MINE).entries.map((e) => e.key), ["mynote"], "an escaped brace doesn't end the entry early");
});

test("merging: Zotero's entries are added or replace the same key; what only the file has stays", () => {
  const local = `% kept comment\n\n${VASWANI.replace("{2017}", "{2016}")}\n\n${MINE}\n`;
  const m = mergeBib(local, `${VASWANI}\n\n${DEVLIN}\n`);
  assert.deepEqual([m.added, m.updated, m.kept, m.unchanged, m.total], [["devlin2019"], ["vaswani2017"], 1, 0, 3]);
  assert.equal(m.text, `% kept comment\n\n${VASWANI}\n\n${MINE}\n\n${DEVLIN}\n`, "replaced in place, new ones at the end");
  assert.deepEqual(bibKeys(m.text), ["vaswani2017", "mynote", "devlin2019"]);
});

test("merging again changes nothing; spacing differences are not an update", () => {
  const first = mergeBib("", `${VASWANI}\n${DEVLIN}`);
  assert.deepEqual([first.added, first.total], [["vaswani2017", "devlin2019"], 2]);
  const again = mergeBib(first.text, `${VASWANI.replace(/\n {2}/g, "\n\t")}\n\n\n${DEVLIN}`);
  assert.deepEqual([again.added, again.updated, again.unchanged, again.kept], [[], [], 2, 0]);
  assert.equal(again.text, first.text);
  assert.deepEqual(mergeBib(first.text, "").text, first.text, "an empty export removes nothing");
});

test("merging removes duplicates and carries over the definitions Zotero's entries need", () => {
  const dup = mergeBib(`${VASWANI}\n\n${VASWANI.replace("{2017}", "{2018}")}`, `@string{acl = {ACL}}\n@comment{zotero export}\n${DEVLIN}\n${DEVLIN}`);
  assert.deepEqual([dup.total, dup.added, dup.kept], [2, ["devlin2019"], 1]);
  assert.match(dup.text, /year = \{2018\}/, "of a key that is there twice, the later one is kept");
  assert.equal(dup.text.split("@article{vaswani2017").length, 2);
  assert.ok(dup.text.startsWith("@string{acl = {ACL}}\n\n") && !dup.text.includes("zotero export"));
  assert.equal(mergeBib("@string{acl = {ACL}}\n", "@string{acl = {ACL}}\n" + DEVLIN).text.split("@string").length, 2, "a definition already there isn't added twice");
  assert.equal(mergeBib("", "").text, "");
});
