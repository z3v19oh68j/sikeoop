// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import type { DispatchJob } from "../../src/shared/types.ts";
import { QuartoExecutor, expectedOutput, failureHint, parseQuartoVersion, parseRenderOutput, plain, quartoCandidates, quartoStatusOf, renderArgs, supportsTypst } from "../../src/main/papers/quarto.ts";
import { CSL_STYLES, checkTemplateRequest, cjkFont, emptyBib, looksLikeCsl, paperTemplate } from "../../src/main/papers/template.ts";

test("Quarto is looked for on PATH first, then where its installers put it", () => {
  const mac = quartoCandidates("darwin", { PATH: "/usr/bin:/Users/me/bin::relative/dir" }, "/Users/me");
  assert.deepEqual(mac.slice(0, 2), ["/usr/bin/quarto", "/Users/me/bin/quarto"]);
  assert.ok(mac.includes("/opt/homebrew/bin/quarto") && mac.includes("/Applications/quarto/bin/quarto") && mac.includes("/usr/local/bin/quarto"));
  assert.ok(!mac.some((p) => p.includes("relative")), "a relative PATH entry is never tried");
  assert.equal(new Set(mac).size, mac.length);

  const win = quartoCandidates("win32", { Path: 'C:\\Tools;"C:\\Program Files\\Quarto\\bin"', LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, "C:\\Users\\me");
  assert.deepEqual(win.slice(0, 4), ["C:\\Tools\\quarto.exe", "C:\\Tools\\quarto.cmd", "C:\\Program Files\\Quarto\\bin\\quarto.exe", "C:\\Program Files\\Quarto\\bin\\quarto.cmd"]);
  assert.ok(win.includes("C:\\Users\\me\\AppData\\Local\\Programs\\Quarto\\bin\\quarto.exe"));
  assert.ok(quartoCandidates("linux", {}, "/home/me").includes("/opt/quarto/bin/quarto"));
});

test("the version line is read; PDF through Typst needs 1.4", () => {
  assert.equal(parseQuartoVersion("1.5.57\n"), "1.5.57");
  assert.equal(parseQuartoVersion("\r\n1.4.550\r\n"), "1.4.550");
  assert.equal(parseQuartoVersion("99.9.9"), "99.9.9");
  assert.equal(parseQuartoVersion("quarto: command not found"), null);
  assert.equal(parseQuartoVersion(""), null);
  assert.deepEqual(["1.3.450", "1.4.0", "1.5.57", "2.0.0"].map(supportsTypst), [false, true, true, true]);

  const missing = quartoStatusOf(null);
  assert.deepEqual([missing.found, missing.typst, missing.steps.length > 0], [false, false, true]);
  assert.match(missing.message, /没有找到 Quarto/);
  assert.deepEqual(quartoStatusOf({ path: "/usr/local/bin/quarto", version: "1.5.57" }), { found: true, path: "/usr/local/bin/quarto", version: "1.5.57", typst: true, message: "", steps: [] });
  const old = quartoStatusOf({ path: "/usr/local/bin/quarto", version: "1.3.450" });
  assert.deepEqual([old.found, old.typst], [true, false]);
  assert.match(old.message, /出 PDF 需要 1\.4/);
});

test("the command for a rendering: the file's name only, the output format, code not run unless asked", () => {
  assert.deepEqual(renderArgs("paper.qmd", "pdf", false), ["render", "paper.qmd", "--to", "typst", "--no-execute"]);
  assert.deepEqual(renderArgs("我的 论文.md", "docx", false), ["render", "我的 论文.md", "--to", "docx", "--no-execute"]);
  assert.deepEqual(renderArgs("paper.qmd", "html", true), ["render", "paper.qmd", "--to", "html"]);
  for (const bad of ["../paper.qmd", "sub/paper.qmd", "--help.qmd", "paper.tex", "paper.qmd.exe", "paper"]) assert.throws(() => renderArgs(bad, "pdf", false), /只能排版/, bad);
  assert.deepEqual([expectedOutput("paper.qmd", "pdf"), expectedOutput("notes.md", "docx"), expectedOutput("a.b.qmd", "html")], ["paper.pdf", "notes.docx", "a.b.html"]);
});

// Made-up output in the shape of what Quarto, Pandoc and Typst print.
const OK = "\u001b[1mpandoc \u001b[22m\n  to: typst\n  output-file: paper.typ\n\n[typst]: Compiling paper.typ to paper.pdf...DONE\n\nOutput created: paper.pdf\n\n";
const WARN = "pandoc \n  to: docx\n[WARNING] Citeproc: citation smith2020 not found\n[WARNING] Citeproc: citation smith2020 not found\nWARNING: Unable to resolve crossref @fig-missing\n\nOutput created: out/paper.docx\n";
const TYPST_FAIL = "[typst]: Compiling paper.typ to paper.pdf...\nerror: unknown variable: foo\n   ┌─ paper.typ:12:3\n   │\n12 │   #foo\n   │    ^^^\n\nERROR: Error\n    at renderTypst (file:///x.js:1:1)\n";
const YAML_FAIL = "ERROR: YAMLError: bad indentation of a mapping entry at line 4, column 3:\n      author:\n      ^\n";

test("what Quarto printed: where the output is, and the lines a person needs", () => {
  assert.deepEqual(parseRenderOutput(OK), { output: "paper.pdf", points: [] });
  assert.equal(plain(OK).includes("\u001b"), false);
  assert.deepEqual(parseRenderOutput(WARN), { output: "out/paper.docx", points: ["引用 smith2020 在参考文献里找不到：先同步 references.bib，或检查 key 有没有写错", "Unable to resolve crossref @fig-missing"] });
  const typst = parseRenderOutput(TYPST_FAIL);
  assert.deepEqual([typst.output, typst.points[0]], [undefined, "unknown variable: foo（paper.typ:12:3）"]);
  assert.ok(!typst.points.some((p) => p.includes("renderTypst")), "no stack trace lines");
  assert.match(parseRenderOutput(YAML_FAIL).points[0], /^YAMLError: bad indentation/);
  assert.deepEqual(parseRenderOutput("ERROR:\nNo valid input files passed to render\n").points, ["No valid input files passed to render"]);
  assert.equal(parseRenderOutput(Array.from({ length: 40 }, (_, i) => `ERROR: problem ${i}`).join("\n")).points.length, 8);
  assert.deepEqual(parseRenderOutput(""), { output: undefined, points: [] });
});

test("a failure gets a plain hint when its lines point at a known cause", () => {
  assert.match(failureHint([], "error: unknown font family: songti sc")!, /字体/);
  assert.match(failureHint(["File references.bib not found in resource path"], "Could not find bibliography file: references.bib")!, /references\.bib/);
  assert.match(failureHint(["YAMLError: bad indentation"], "")!, /YAML/);
  assert.equal(failureHint(["unknown variable: foo"], TYPST_FAIL), null);
});

const job = {} as DispatchJob;

test("a rendering as a job: Quarto's output is the result; a non-zero exit fails with what went wrong", async () => {
  const ran: unknown[] = [];
  const ok = new QuartoExecutor("quarto:1", { bin: "/usr/local/bin/quarto", args: ["render", "paper.qmd", "--to", "typst"], cwd: "/project/paper", run: async (bin, args, cwd, out) => { ran.push(bin, args, cwd); out(OK.slice(0, 30)); out(OK.slice(30)); return 0; } });
  assert.deepEqual([ok.kind, ok.name, ok.ref, ok.ready(), ok.alive()], ["process", "Quarto", "quarto:1", true, true]);
  const result = await ok.run(job, new AbortController().signal);
  assert.match(result.text, /Output created: paper\.pdf$/);
  assert.deepEqual(ran, ["/usr/local/bin/quarto", ["render", "paper.qmd", "--to", "typst"], "/project/paper"]);
  assert.equal(ok.log, OK);

  const failing = new QuartoExecutor("quarto:2", { bin: "q", args: [], cwd: "/", run: async (_b, _a, _c, out) => { out(TYPST_FAIL); return 1; } });
  await assert.rejects(failing.run(job, new AbortController().signal), /unknown variable: foo（paper\.typ:12:3）/);
  const silent = new QuartoExecutor("quarto:3", { bin: "q", args: [], cwd: "/", run: async () => 3 });
  await assert.rejects(silent.run(job, new AbortController().signal), /Quarto 退出了（代码 3）/);
});

test("a cancelled or timed-out rendering says so, whatever Quarto's exit code was", async () => {
  for (const [reason, said] of [["cancelled", /已取消/], ["timeout", /太久没有结束/]] as const) {
    const stop = new AbortController();
    let began = false;
    const ex = new QuartoExecutor("quarto:4", { bin: "q", args: [], cwd: "/", begin: () => (began = true), run: (_b, _a, _c, _o, signal) => new Promise<number>((resolve) => signal.addEventListener("abort", () => resolve(143))) });
    const running = ex.run(job, stop.signal);
    stop.abort(reason);
    await assert.rejects(running, said);
    assert.ok(began);
  }
});

test("the paper template: title, authors, abstract, bibliography and citation style in the document's settings", () => {
  const zh = paperTemplate({ title: '基于"难度"的路由: 一个尝试', authors: ["李 旺", " ", "Ada Lovelace"], abstract: "第一行\n第二行", lang: "zh", csl: "gbt7714" }, { cslFile: CSL_STYLES.gbt7714.file, platform: "darwin" });
  const head = zh.split("\n---\n")[0].split("\n");
  assert.equal(head[0], "---");
  assert.ok(head.includes('title: "基于\\"难度\\"的路由: 一个尝试"'), "quotes and colons in the title don't break the settings");
  assert.deepEqual(head.filter((l) => l.startsWith("  - name:")), ['  - name: "李 旺"', '  - name: "Ada Lovelace"']);
  assert.ok(zh.includes("abstract: |\n  第一行\n  第二行\n"));
  assert.ok(head.includes("lang: zh") && head.includes("bibliography: references.bib") && head.includes('csl: "china-national-standard-gb-t-7714-2015-numeric.csl"'));
  assert.ok(head.includes('    mainfont: "Songti SC"') && !zh.includes("csl: gb-7714-2015-numeric"));
  assert.ok(zh.includes("# 引言") && zh.includes("[@citekey]") && zh.includes("::: {#refs}"));

  const en = paperTemplate({ title: "Routing by Difficulty", authors: [], abstract: "", lang: "en", csl: "apa" }, { platform: "linux" });
  assert.ok(!en.includes("author:") && !en.includes("mainfont") && !/^csl:/m.test(en));
  assert.ok(en.includes("  typst:\n    csl: apa\n"), "without the style file, PDF uses Typst's own style of the same name");
  assert.ok(en.includes("abstract: |\n  Write the abstract here.\n") && en.includes("lang: en") && en.includes("# Introduction"));
  assert.deepEqual([cjkFont("win32"), cjkFont("darwin"), cjkFont("linux")], ["SimSun", "Songti SC", "Noto Serif CJK SC"]);
  assert.match(emptyBib(), /^% /);
});

test("the style files come from the official CSL repository and are checked before use", () => {
  for (const s of Object.values(CSL_STYLES)) {
    assert.ok(s.url === `https://raw.githubusercontent.com/citation-style-language/styles/master/${s.file}` && s.file.endsWith(".csl") && s.license === "CC BY-SA 3.0");
  }
  const csl = `<?xml version="1.0" encoding="utf-8"?>\n<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">\n<info><title>Sample</title><rights license="http://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</rights></info>\n${"<macro/>".repeat(80)}\n</style>`;
  assert.equal(looksLikeCsl(csl), true);
  assert.equal(looksLikeCsl(csl.replace(/<rights[^]*?<\/rights>/, "")), false, "a file without its licence line is not taken");
  assert.equal(looksLikeCsl("<html><body>404: Not Found</body></html>".repeat(30)), false);
  assert.equal(looksLikeCsl("short"), false);
});

test("a new-paper request is checked: a folder inside the project, a plain file name", () => {
  const ok = { dir: "./paper/", name: "main", title: " 标题 ", authors: [" 甲 ", ""], abstract: "", lang: "zh", csl: "gbt7714", downloadCsl: 1 };
  assert.deepEqual(checkTemplateRequest(ok), { dir: "paper", name: "main", title: "标题", authors: ["甲"], abstract: "", lang: "zh", csl: "gbt7714", downloadCsl: false });
  assert.equal(checkTemplateRequest({ ...ok, dir: "", downloadCsl: true }).downloadCsl, true);
  for (const [patch, said] of [[{ dir: "../outside" }, /相对路径/], [{ dir: "/abs" }, /相对路径/], [{ dir: "a/../../b" }, /相对路径/], [{ name: "a/b" }, /文件名/], [{ name: "..hidden" }, /文件名/], [{ name: "end." }, /文件名/], [{ title: " " }, /标题/], [{ authors: "甲" }, /作者/], [{ lang: "fr" }, /语言/], [{ csl: "chicago" }, /引用格式/], [{ abstract: "x".repeat(5001) }, /摘要/]] as const) {
    assert.throws(() => checkTemplateRequest({ ...ok, ...patch }), said, JSON.stringify(patch));
  }
  assert.throws(() => checkTemplateRequest(null), /格式不正确/);
});
