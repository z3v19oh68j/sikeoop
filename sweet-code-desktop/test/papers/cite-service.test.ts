// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BibFormat, PaperDoc } from "../../src/shared/types.ts";
import { CiteService } from "../../src/main/papers/cite-service.ts";
import { ProjectFiles } from "../../src/main/papers/project-files.ts";

const ENTRY = (key: string, year = 2020) => `@article{${key},\n  title = {Title of ${key}},\n  year = {${year}}\n}`;

function setup() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-cite-")));
  const project = path.join(base, "project");
  const userData = path.join(base, "userData");
  mkdirSync(path.join(project, "paper"), { recursive: true });
  const library: Record<string, string> = { a2020: ENTRY("a2020"), b2021: ENTRY("b2021", 2021), c2022: ENTRY("c2022", 2022) };
  const asked: { file: string; summary: string }[] = [];
  const zoteroCalls: string[] = [];
  const imported: { file: string; meta: { citekey: string; title: string; authors: string[] } }[] = [];
  let approve = true;
  let pdfs: string[] = [];
  let picker: { resolve(text: string | null): void; signal: AbortSignal } | null = null;
  const svc = new CiteService({
    userData: () => userData,
    root: () => project,
    files: new ProjectFiles(() => project),
    zotero: {
      status: async () => ({ state: "ready", message: "", steps: [] }),
      pick: (style, signal) =>
        new Promise((resolve, reject) => {
          picker = { resolve: (text) => resolve(text === null ? null : { text, keys: [], style }), signal };
          signal.addEventListener("abort", () => reject(new Error("已取消")));
        }),
      search: async (terms) => [{ citekey: "a2020", title: `found: ${terms}`, authors: [], year: 2020, type: "article" }],
      pdfs: async () => pdfs,
      exportKnown: async (keys: string[], format: BibFormat) => {
        zoteroCalls.push(`keys:${format}:${keys.join(",")}`);
        return { bib: keys.filter((k) => library[k]).map((k) => library[k]).join("\n\n"), missing: keys.filter((k) => !library[k]) };
      },
      collections: async () => [{ libraryId: 1, library: "My Library", key: "ABCD2345", name: "论文", path: "论文" }],
      exportCollection: async (lib, key, format) => {
        zoteroCalls.push(`collection:${lib}:${key}:${format}`);
        return Object.values(library).join("\n\n");
      },
    },
    approveWrite: async (file, summary) => {
      asked.push({ file, summary });
      return approve;
    },
    importPdf: async (file, meta) => {
      imported.push({ file, meta });
      return { id: "p1", title: meta.title, authors: meta.authors, citekey: meta.citekey, source: { kind: "file", path: file }, pages: 1, sections: [], addedAt: 0 } as PaperDoc;
    },
  });
  const write = (relative: string, text: string) => writeFileSync(path.join(project, relative), text);
  const read = (relative: string) => readFileSync(path.join(project, relative), "utf8");
  return { svc, base, project, library, asked, zoteroCalls, imported, write, read, setApprove: (v: boolean) => (approve = v), setPdfs: (v: string[]) => (pdfs = v), picker: () => picker! };
}

test("syncing by what the documents cite: only those entries, the keys Zotero doesn't have reported", async () => {
  const t = setup();
  t.write("paper/main.qmd", "Intro [@a2020; @ghost2019]. See @fig-one and me@example.org.");
  t.write("paper/appendix.tex", "More \\cite{b2021} and again \\cite{a2020}.");
  const before = await t.svc.bibState("paper/references.bib");
  assert.deepEqual([before.exists, before.entries, before.settings.format], [false, 0, "biblatex"]);

  const r = await t.svc.bibSync({ mode: "used", file: "paper/references.bib", format: "biblatex", documents: ["paper/main.qmd", "paper/appendix.tex"] });
  assert.deepEqual(r, { file: "paper/references.bib", added: ["a2020", "b2021"], updated: [], kept: 0, unchanged: 0, missing: ["ghost2019"], total: 2 });
  assert.deepEqual(t.zoteroCalls, ["keys:biblatex:a2020,ghost2019,b2021"]);
  assert.equal(t.read("paper/references.bib"), `${ENTRY("a2020")}\n\n${ENTRY("b2021", 2021)}\n`);
  assert.deepEqual(t.asked.map((a) => [a.file, a.summary.split("\n")[0]]), [["paper/references.bib", "从 Zotero 新增 2 条、更新 0 条"]]);

  const after = await t.svc.bibState();
  assert.deepEqual([after.settings.file, after.exists, after.entries, typeof after.updatedAt], ["paper/references.bib", true, 2, "number"], "the file used last is remembered");
});

test("syncing a collection keeps hand-added entries, says what will be replaced, and asks first", async () => {
  const t = setup();
  const mine = "@misc{handmade,\n  title = {Added by hand}\n}";
  t.write("references.bib", `${ENTRY("a2020", 1999)}\n\n${mine}\n`);
  const req = { mode: "collection", file: "references.bib", format: "bibtex", libraryId: 1, key: "ABCD2345", path: "论文" };

  t.setApprove(false);
  await assert.rejects(t.svc.bibSync(req), /你取消了同步，文件没有改动/);
  assert.equal(t.read("references.bib"), `${ENTRY("a2020", 1999)}\n\n${mine}\n`);
  assert.match(t.asked[0].summary, /新增 2 条、更新 1 条\n文件里另外 1 条 Zotero 没给的条目原样保留\n会被 Zotero 的版本替换的条目：a2020/);

  t.setApprove(true);
  const r = await t.svc.bibSync(req);
  assert.deepEqual([r.added, r.updated, r.kept, r.total], [["b2021", "c2022"], ["a2020"], 1, 4]);
  assert.equal(t.read("references.bib"), `${ENTRY("a2020")}\n\n${mine}\n\n${ENTRY("b2021", 2021)}\n\n${ENTRY("c2022", 2022)}\n`);
  assert.deepEqual((await t.svc.bibState()).settings, { file: "references.bib", format: "bibtex", collection: { libraryId: 1, key: "ABCD2345", path: "论文" } });

  // Nothing new in Zotero: nothing is asked and nothing is written.
  const again = await t.svc.bibSync(req);
  assert.deepEqual([again.added, again.updated, again.unchanged, again.kept], [[], [], 3, 1]);
  assert.equal(t.asked.length, 2);
  assert.deepEqual(t.zoteroCalls, ["collection:1:ABCD2345:bibtex", "collection:1:ABCD2345:bibtex", "collection:1:ABCD2345:bibtex"]);
});

test("a sync request is checked: a .bib inside the project, documents that cite something", async () => {
  const t = setup();
  t.write("paper/empty.md", "No citations yet.");
  const used = { mode: "used", format: "biblatex", documents: ["paper/empty.md"] };
  await assert.rejects(t.svc.bibSync({ ...used, file: "references.bib" }), /还没有引用/);
  await assert.rejects(t.svc.bibSync({ ...used, file: "references.txt" }), /以 \.bib 结尾/);
  await assert.rejects(t.svc.bibSync({ ...used, file: "../outside.bib" }), /超出了项目文件夹/);
  await assert.rejects(t.svc.bibSync({ ...used, file: "references.bib", documents: [] }), /请选择 1 到 20 个文稿/);
  await assert.rejects(t.svc.bibSync({ ...used, file: "references.bib", documents: ["../../etc/passwd"] }), /超出了项目文件夹/);
  await assert.rejects(t.svc.bibSync({ ...used, file: "references.bib", format: "ris" }), /BibLaTeX 或 BibTeX/);
  await assert.rejects(t.svc.bibSync({ mode: "everything", file: "references.bib", format: "bibtex" }), /同步方式不正确/);
  await assert.rejects(t.svc.bibState("../outside.bib"), /超出了项目文件夹/);
  // A link out of the project is not followed.
  symlinkSync(t.base, path.join(t.project, "escape"));
  await assert.rejects(t.svc.bibSync({ mode: "collection", file: "escape/references.bib", format: "bibtex", libraryId: 1, key: "ABCD2345", path: "论文" }), /超出了项目文件夹/);
  assert.deepEqual([t.asked.length, t.zoteroCalls.length], [0, 0], "nothing is asked of the user or of Zotero for a bad request");
});

test("the picker: one at a time, its answer handed back, and waiting can be stopped", async () => {
  const t = setup();
  const first = t.svc.pick("pandoc");
  await assert.rejects(t.svc.pick("latex"), /引用选择框已经开着/);
  t.picker().resolve("[@a2020]");
  assert.deepEqual(await first, { text: "[@a2020]", keys: [], style: "pandoc" });

  const closed = t.svc.pick("latex");
  t.picker().resolve(null);
  assert.equal(await closed, null);

  const waiting = t.svc.pick("pandoc");
  t.svc.cancelPick();
  await assert.rejects(waiting, /已取消/);
  assert.ok(t.picker().signal.aborted);
  const next = t.svc.pick("pandoc");
  t.picker().resolve("[@b2021]");
  assert.equal((await next)?.text, "[@b2021]", "after a cancel the picker can be opened again");
  await assert.rejects(t.svc.pick("html"), /Markdown 或 LaTeX/);
});

test("search and formatting are checked; an item's PDF is read into the workshop under its citekey", async () => {
  const t = setup();
  assert.equal((await t.svc.search("  attention  "))[0].title, "found: attention");
  await assert.rejects(t.svc.search(" "), /请输入要找的/);
  assert.equal(t.svc.format([{ citekey: "a2020" }, { citekey: "b2021", locator: "p. 3" }], "pandoc"), "[@a2020; @b2021, p. 3]");
  assert.throws(() => t.svc.format([{ citekey: "bad key" }], "pandoc"), /引用 key 不能用/);
  assert.throws(() => t.svc.format([], "latex"), /1 到 50 篇/);

  const item = { citekey: "a2020", title: "Attention", authors: ["Ashish Vaswani"], year: 2017, type: "article-journal" };
  await assert.rejects(t.svc.import(item), /没有 PDF 附件/);
  t.setPdfs([path.join(t.base, "not-synced.pdf"), "relative.pdf"]);
  await assert.rejects(t.svc.import(item), /文件不在这台电脑上/);
  const pdf = path.join(t.base, "paper.pdf");
  writeFileSync(pdf, "%PDF-1.4");
  t.setPdfs([path.join(t.base, "not-synced.pdf"), pdf]);
  const paper = await t.svc.import(item);
  assert.deepEqual([paper.citekey, paper.title], ["a2020", "Attention"]);
  assert.deepEqual(t.imported, [{ file: pdf, meta: { citekey: "a2020", title: "Attention", authors: ["Ashish Vaswani"] } }]);
  await assert.rejects(t.svc.import({ ...item, citekey: "../x" }), /引用 key 不能用/);
});
